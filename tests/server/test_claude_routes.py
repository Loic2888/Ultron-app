"""Claude chat routes, tested against a fake `claude` program (no real calls)."""

from __future__ import annotations

import asyncio
import json
import os
import stat
import sys
import time

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from openjarvis.server import claude_routes as cr
from openjarvis.server import terminal_routes as tr
from openjarvis.server import workspace_routes as wr

posix_only = pytest.mark.skipif(os.name != "posix", reason="POSIX only")

FRONTEND = "http://localhost:5173"
LOCAL_HOST = "localhost:8010"

FAKE = r"""#!{python}
import json, os, sys
sys.stdout.reconfigure(line_buffering=True)
def out(d): print(json.dumps(d), flush=True)
# Record how we were started, for the tests.
with open(os.environ.get("FAKE_LOG", "/dev/null"), "a") as f:
    f.write(json.dumps({{"argv": sys.argv[1:], "cwd": os.getcwd(),
        "has_anthropic": any(k.startswith("ANTHROPIC_") for k in os.environ)}}) + "\n")
for line in sys.stdin:
    msg = json.loads(line)
    if msg.get("type") == "control_request":
        continue
    if msg.get("type") != "user":
        continue
    text = msg["message"]["content"]
    out({{"type": "system", "subtype": "init",
          "session_id": "11111111-2222-3333-4444-555555555555"}})
    if text.startswith("mem "):
        out({{"type": "control_request", "request_id": "m1", "request": {{
            "subtype": "can_use_tool", "tool_name": "Write",
            "input": {{"file_path": text[4:], "content": "x"}}}}}})
        reply = json.loads(sys.stdin.readline())
        resp = reply["response"]["response"]
        out({{"type": "assistant", "message": {{"role": "assistant", "content": [
            {{"type": "text", "text": "mem " + resp["behavior"]}}]}}}})
    elif "tool" in text:
        out({{"type": "control_request", "request_id": "r1", "request": {{
            "subtype": "can_use_tool", "tool_name": "Bash", "display_name": "Bash",
            "input": {{"command": "echo hi"}}, "description": "say hi"}}}})
        reply = json.loads(sys.stdin.readline())
        resp = reply["response"]["response"]
        out({{"type": "assistant", "message": {{"role": "assistant", "content": [
            {{"type": "text", "text": "tool " + resp["behavior"]}}]}}}})
    else:
        out({{"type": "assistant", "message": {{"role": "assistant", "content": [
            {{"type": "text", "text": "echo: " + text}}]}}}})
    out({{"type": "rate_limit_event", "rate_limit_info": {{"unifiedWindows": {{}}}}}})
    out({{"type": "result", "subtype": "success", "is_error": False, "result": "ok"}})
"""


@pytest.fixture()
def home(tmp_path, monkeypatch):
    monkeypatch.setenv("HOME", str(tmp_path))
    return tmp_path.resolve()


@pytest.fixture()
def fake_claude(tmp_path, monkeypatch):
    path = tmp_path / "fake-claude"
    path.write_text(FAKE.format(python=sys.executable))
    path.chmod(path.stat().st_mode | stat.S_IEXEC)
    log = tmp_path / "fake.log"
    monkeypatch.setenv("OPENJARVIS_CLAUDE_BIN", str(path))
    monkeypatch.setenv("FAKE_LOG", str(log))
    monkeypatch.setenv("ANTHROPIC_BASE_URL", "https://example.invalid")
    return log


def _app(bind_host: str | None = "127.0.0.1") -> FastAPI:
    app = FastAPI()
    app.include_router(cr.create_claude_router())
    app.state.allowed_origins = [FRONTEND]
    if bind_host is not None:
        app.state.bind_host = bind_host
    return app


class Api:
    def __init__(self, app: FastAPI):
        # `with` keeps one event loop alive: sessions hold subprocesses.
        self.client = TestClient(app, base_url="http://localhost:8010")
        self.client.__enter__()
        self.headers = {
            "origin": FRONTEND,
            "host": LOCAL_HOST,
            wr.TOKEN_HEADER: tr.get_terminal_token(app),
        }

    def call(self, method, path, **kw):
        return self.client.request(method, path, headers=self.headers, **kw)

    def events(self, sid, after=-1):
        res = self.call(
            "GET",
            f"/v1/claude/sessions/{sid}/events",
            params={"after": after, "follow": "false"},
        )
        assert res.status_code == 200
        return [json.loads(x) for x in res.text.splitlines() if x.strip()]

    def wait(self, sid, pred, secs=10):
        end = time.time() + secs
        while time.time() < end:
            evs = self.events(sid)
            if pred(evs):
                return evs
            time.sleep(0.05)
        raise AssertionError("timed out; events: %r" % self.events(sid))

    def close(self):
        # Stop every chat first: live subprocesses would keep the loop open.
        res = self.call("GET", "/v1/claude/sessions")
        for item in res.json().get("sessions", []):
            self.call("DELETE", f"/v1/claude/sessions/{item['id']}")
        self.client.__exit__(None, None, None)


@pytest.fixture()
def api():
    made: list[Api] = []

    def make(app=None):
        a = Api(app or _app())
        made.append(a)
        return a

    yield make
    for a in made:
        a.close()


def _new(a, home, **body):
    (home / "repo").mkdir(exist_ok=True)
    res = a.call(
        "POST", "/v1/claude/sessions", json={"cwd": str(home / "repo"), **body}
    )
    assert res.status_code == 200, res.text
    return res.json()


def _is_result(evs):
    return any(e.get("type") == "result" for e in evs)


# ---------------------------------------------------------------------------


@posix_only
class TestGates:
    def test_every_route_needs_the_token(self, home, fake_claude, api):
        a = api()
        s = _new(a, home)
        sid = s["id"]
        routes = [
            ("GET", "/v1/claude/status", None),
            ("GET", "/v1/claude/account", None),
            ("POST", "/v1/claude/sessions", {"cwd": str(home)}),
            ("GET", "/v1/claude/sessions", None),
            ("GET", f"/v1/claude/sessions/{sid}", None),
            ("POST", f"/v1/claude/sessions/{sid}/message", {"text": "x"}),
            (
                "POST",
                f"/v1/claude/sessions/{sid}/decision",
                {"request_id": "r", "allow": True},
            ),
            ("POST", f"/v1/claude/sessions/{sid}/interrupt", None),
            ("POST", f"/v1/claude/sessions/{sid}/mode", {"permission_mode": "plan"}),
            ("POST", f"/v1/claude/sessions/{sid}/settings", {"model": "opus"}),
            ("GET", f"/v1/claude/sessions/{sid}/events", None),
            ("DELETE", f"/v1/claude/sessions/{sid}", None),
        ]
        bad = dict(a.headers)
        bad[wr.TOKEN_HEADER] = "nope"
        for method, path, body in routes:
            res = a.client.request(method, path, headers=bad, json=body)
            assert res.status_code == 403, (method, path)

    def test_hostile_origin_and_host_refused(self, home, fake_claude, api):
        a = api()
        for headers in (
            {**a.headers, "origin": "http://evil.example"},
            {**a.headers, "host": "evil.example"},
        ):
            res = a.client.get("/v1/claude/status", headers=headers)
            assert res.status_code == 403

    def test_non_local_server_refused(self, home, fake_claude, api):
        a = api(_app(bind_host="0.0.0.0"))
        assert a.call("GET", "/v1/claude/status").status_code == 403


@posix_only
class TestAccount:
    def _program(self, tmp_path, monkeypatch, body: str):
        path = tmp_path / "auth-claude"
        path.write_text(f"#!{sys.executable}\n{body}")
        path.chmod(path.stat().st_mode | stat.S_IEXEC)
        monkeypatch.setenv("OPENJARVIS_CLAUDE_BIN", str(path))

    def test_shows_the_signed_in_account_without_ids(
        self, home, tmp_path, monkeypatch, api
    ):
        self._program(
            tmp_path,
            monkeypatch,
            "import json,sys\n"
            "assert sys.argv[1:] == ['auth', 'status']\n"
            "print(json.dumps({'loggedIn': True, 'authMethod': 'claude.ai',"
            " 'email': 'me@example.com', 'orgName': 'Acme', 'orgId': 'secret-id',"
            " 'subscriptionType': 'team', 'loginExpiresAt': '2030-01-01'}))\n",
        )
        body = api().call("GET", "/v1/claude/account").json()
        assert body["logged_in"] is True
        assert body["email"] == "me@example.com"
        assert body["organization"] == "Acme"
        assert body["plan"] == "team"
        assert "secret-id" not in json.dumps(body)

    def test_unreadable_output_means_not_signed_in(
        self, home, tmp_path, monkeypatch, api
    ):
        self._program(tmp_path, monkeypatch, "print('not json')\n")
        body = api().call("GET", "/v1/claude/account").json()
        assert body["logged_in"] is False

    def test_missing_program(self, home, api, monkeypatch):
        monkeypatch.setenv("OPENJARVIS_CLAUDE_BIN", "")
        monkeypatch.setenv("PATH", "/nonexistent")
        body = api().call("GET", "/v1/claude/account").json()
        assert body == {"installed": False, "logged_in": False}


@posix_only
class TestJournalAndUsage:
    def test_finished_turn_goes_to_memory_and_logs(self, home, fake_claude, api):
        from openjarvis.server import journal

        a = api()
        sid = _new(a, home)["id"]
        a.call("POST", f"/v1/claude/sessions/{sid}/message", json={"text": "hello"})
        a.wait(sid, _is_result)
        item = journal.read_memory()[-1]
        assert item["repo"] == str(home / "repo")
        assert item["prompt"] == "hello"
        assert item["answer"] == "ok" and item["ok"] is True
        messages = [e["message"] for e in journal.read_logs()]
        assert any("Fenêtre Claude Code ouverte" in m for m in messages)
        assert any("hello" in m for m in messages)
        assert any("terminé" in m for m in messages)

    def test_edited_files_are_listed_relative_to_the_repo(self, home):
        session = cr.Session("s", str(home / "repo"), "default", None, None)
        session.turn = {"prompt": "p", "started": 0, "files": [], "tools": {}}
        event = {
            "message": {
                "content": [
                    {
                        "type": "tool_use",
                        "name": "Edit",
                        "input": {"file_path": str(home / "repo" / "a" / "b.py")},
                    },
                    {"type": "tool_use", "name": "Read", "input": {"file_path": "x"}},
                ]
            }
        }
        session._note_tools(event)
        assert session.turn["files"] == ["a/b.py"]
        assert session.turn["tools"] == {"Edit": 1, "Read": 1}

    def test_own_memory_notes_are_not_listed_as_repo_edits(self, home):
        from openjarvis.server import repo_memory

        session = cr.Session("s", str(home / "repo"), "default", None, None)
        session.memory_dir = repo_memory.ensure_repo_memory(home / "repo")
        session.turn = {"prompt": "p", "started": 0, "files": [], "tools": {}}
        note = str(session.memory_dir / "fonctionne.md")
        session._note_tools(
            {
                "message": {
                    "content": [
                        {
                            "type": "tool_use",
                            "name": "Edit",
                            "input": {"file_path": note},
                        }
                    ]
                }
            }
        )
        assert session.turn["files"] == []

    def test_rate_limit_event_is_kept_and_served(self, home, api):
        from openjarvis.server import journal

        session = cr.Session("s", str(home), "default", None, None)
        windows = {"five_hour": {"utilization": 0.25, "resetsAt": 9}}
        asyncio.run(
            session._handle(
                {
                    "type": "rate_limit_event",
                    "rate_limit_info": {"unifiedWindows": windows},
                }
            )
        )
        assert journal.load_usage()["windows"] == windows
        body = api().call("GET", "/v1/claude/usage").json()
        assert body["usage"]["windows"] == windows

    def test_refresh_reads_usage_with_one_clean_request(
        self, home, tmp_path, monkeypatch, api
    ):
        out = tmp_path / "probe.out"
        path = tmp_path / "probe-claude"
        path.write_text(
            f"#!{sys.executable}\n"
            "import json, os, sys\n"
            f"open({str(out)!r}, 'a').write(json.dumps({{'argv': sys.argv[1:],"
            " 'has_anthropic': any(k.startswith('ANTHROPIC_')"
            " for k in os.environ)}) + '\\n')\n"
            "print(json.dumps({'type': 'rate_limit_event', 'rate_limit_info':"
            " {'unifiedWindows': {'five_hour': {'utilization': 0.4}}}}))\n"
        )
        path.chmod(path.stat().st_mode | stat.S_IEXEC)
        monkeypatch.setenv("OPENJARVIS_CLAUDE_BIN", str(path))
        monkeypatch.setenv("ANTHROPIC_BASE_URL", "https://example.invalid")
        a = api()
        body = a.call("POST", "/v1/claude/usage/refresh").json()
        assert body["usage"]["windows"]["five_hour"]["utilization"] == 0.4
        # a second call within 10 minutes does not start another request
        a.call("POST", "/v1/claude/usage/refresh")
        runs = [json.loads(x) for x in out.read_text().splitlines()]
        assert len(runs) == 1
        assert runs[0]["has_anthropic"] is False
        assert (
            "--tools" in runs[0]["argv"]
            and "--no-session-persistence" in runs[0]["argv"]
        )


@posix_only
class TestSessions:
    def test_status(self, home, fake_claude, api):
        a = api()
        assert a.call("GET", "/v1/claude/status").json() == {"installed": True}

    def test_folder_must_be_inside_home(self, home, fake_claude, api):
        a = api()
        res = a.call("POST", "/v1/claude/sessions", json={"cwd": "/etc"})
        assert res.status_code == 403

    def test_unknown_mode_and_bad_resume_refused(self, home, fake_claude, api):
        a = api()
        (home / "repo").mkdir()
        cwd = str(home / "repo")
        for body in (
            {"cwd": cwd, "permission_mode": "bypassPermissions"},
            {"cwd": cwd, "resume": "../../etc/passwd"},
        ):
            assert a.call("POST", "/v1/claude/sessions", json=body).status_code == 400

    def test_full_house_frees_the_oldest_idle_chat(
        self, home, fake_claude, api, monkeypatch
    ):
        monkeypatch.setattr(cr, "MAX_SESSIONS", 2)
        a = api()
        first = _new(a, home)
        second = _new(a, home)
        third = _new(a, home)  # accepted: `first` was idle and the oldest
        ids = {s["id"] for s in a.call("GET", "/v1/claude/sessions").json()["sessions"]}
        assert ids == {second["id"], third["id"]}
        assert a.call("GET", f"/v1/claude/sessions/{first['id']}").status_code == 404

    def test_full_house_refuses_when_every_chat_is_in_use(
        self, home, fake_claude, api, monkeypatch
    ):
        monkeypatch.setattr(cr, "MAX_SESSIONS", 1)
        a = api()
        sid = _new(a, home)["id"]
        a.call(
            "POST", f"/v1/claude/sessions/{sid}/message", json={"text": "use a tool"}
        )
        a.wait(sid, lambda evs: any(e.get("kind") == "approval" for e in evs))
        res = a.call("POST", "/v1/claude/sessions", json={"cwd": str(home)})
        assert res.status_code == 429

    def test_message_round_trip(self, home, fake_claude, api):
        a = api()
        sid = _new(a, home)["id"]
        assert (
            a.call(
                "POST", f"/v1/claude/sessions/{sid}/message", json={"text": "hello"}
            ).status_code
            == 200
        )
        evs = a.wait(sid, _is_result)
        kinds = [(e["type"], e.get("kind")) for e in evs]
        assert ("jarvis", "user_message") in kinds
        texts = [
            b["text"]
            for e in evs
            if e["type"] == "assistant"
            for b in e["message"]["content"]
            if b["type"] == "text"
        ]
        assert texts == ["echo: hello"]
        # seq numbers are consecutive, and `after` resumes the stream
        assert [e["seq"] for e in evs] == list(range(len(evs)))
        assert a.events(sid, after=evs[2]["seq"])[0]["seq"] == evs[2]["seq"] + 1
        summary = a.call("GET", f"/v1/claude/sessions/{sid}").json()
        assert summary["busy"] is False
        assert summary["claude_session_id"] == "11111111-2222-3333-4444-555555555555"

    def test_child_has_no_provider_variables_and_right_folder(
        self, home, fake_claude, api
    ):
        a = api()
        sid = _new(a, home)["id"]
        a.call("POST", f"/v1/claude/sessions/{sid}/message", json={"text": "hi"})
        a.wait(sid, _is_result)
        start = json.loads(fake_claude.read_text().splitlines()[0])
        assert start["has_anthropic"] is False
        assert start["cwd"] == str(home / "repo")
        assert "--permission-prompt-tool" in start["argv"]
        assert start["argv"][start["argv"].index("--permission-mode") + 1] == "auto"

    def test_empty_and_huge_messages_refused(self, home, fake_claude, api):
        a = api()
        sid = _new(a, home)["id"]
        assert (
            a.call(
                "POST", f"/v1/claude/sessions/{sid}/message", json={"text": "  "}
            ).status_code
            == 400
        )
        big = "x" * (cr.MAX_PROMPT_CHARS + 1)
        assert (
            a.call(
                "POST", f"/v1/claude/sessions/{sid}/message", json={"text": big}
            ).status_code
            == 413
        )

    def test_second_message_while_busy_is_refused(self, home, fake_claude, api):
        a = api()
        sid = _new(a, home)["id"]
        a.call(
            "POST", f"/v1/claude/sessions/{sid}/message", json={"text": "use a tool"}
        )
        a.wait(sid, lambda evs: any(e.get("kind") == "approval" for e in evs))
        res = a.call(
            "POST", f"/v1/claude/sessions/{sid}/message", json={"text": "again"}
        )
        assert res.status_code == 409

    def test_unknown_session_is_404(self, home, fake_claude, api):
        a = api()
        assert a.call("GET", "/v1/claude/sessions/nope").status_code == 404

    def test_list_filters_by_folder_and_close_removes(self, home, fake_claude, api):
        a = api()
        (home / "other").mkdir()
        s1 = _new(a, home)
        a.call("POST", "/v1/claude/sessions", json={"cwd": str(home / "other")})
        mine = a.call("GET", "/v1/claude/sessions", params={"cwd": s1["cwd"]}).json()[
            "sessions"
        ]
        assert [s["id"] for s in mine] == [s1["id"]]
        assert a.call("DELETE", f"/v1/claude/sessions/{s1['id']}").status_code == 200
        assert a.call("GET", f"/v1/claude/sessions/{s1['id']}").status_code == 404

    def test_missing_program_gives_a_clear_error(self, home, api, monkeypatch):
        monkeypatch.setenv("OPENJARVIS_CLAUDE_BIN", "")
        monkeypatch.setenv("PATH", "/nonexistent")
        a = api()
        sid = _new(a, home)["id"]
        res = a.call("POST", f"/v1/claude/sessions/{sid}/message", json={"text": "hi"})
        assert res.status_code == 503
        assert "claude login" in res.json()["detail"]


@posix_only
class TestApprovals:
    def _ask(self, a, home):
        sid = _new(a, home)["id"]
        a.call(
            "POST", f"/v1/claude/sessions/{sid}/message", json={"text": "use a tool"}
        )
        evs = a.wait(sid, lambda e: any(x.get("kind") == "approval" for x in e))
        ask = next(e for e in evs if e.get("kind") == "approval")
        return sid, ask

    def test_approval_is_shown_and_listed_as_pending(self, home, fake_claude, api):
        a = api()
        sid, ask = self._ask(a, home)
        assert ask["tool_name"] == "Bash"
        assert ask["input"] == {"command": "echo hi"}
        pending = a.call("GET", f"/v1/claude/sessions/{sid}").json()["pending"]
        assert [p["request_id"] for p in pending] == ["r1"]

    def test_accept_lets_the_tool_run(self, home, fake_claude, api):
        a = api()
        sid, ask = self._ask(a, home)
        res = a.call(
            "POST",
            f"/v1/claude/sessions/{sid}/decision",
            json={"request_id": ask["request_id"], "allow": True},
        )
        assert res.status_code == 200
        evs = a.wait(sid, _is_result)
        assert any(
            b.get("text") == "tool allow"
            for e in evs
            if e["type"] == "assistant"
            for b in e["message"]["content"]
        )
        assert any(e.get("kind") == "approval_resolved" and e["allow"] for e in evs)

    def test_refuse_blocks_the_tool(self, home, fake_claude, api):
        a = api()
        sid, ask = self._ask(a, home)
        a.call(
            "POST",
            f"/v1/claude/sessions/{sid}/decision",
            json={"request_id": ask["request_id"], "allow": False},
        )
        evs = a.wait(sid, _is_result)
        assert any(
            b.get("text") == "tool deny"
            for e in evs
            if e["type"] == "assistant"
            for b in e["message"]["content"]
        )

    def test_unknown_request_is_404_and_double_answer_refused(
        self, home, fake_claude, api
    ):
        a = api()
        sid, ask = self._ask(a, home)
        assert (
            a.call(
                "POST",
                f"/v1/claude/sessions/{sid}/decision",
                json={"request_id": "zzz", "allow": True},
            ).status_code
            == 404
        )
        body = {"request_id": ask["request_id"], "allow": True}
        assert (
            a.call("POST", f"/v1/claude/sessions/{sid}/decision", json=body).status_code
            == 200
        )
        assert (
            a.call("POST", f"/v1/claude/sessions/{sid}/decision", json=body).status_code
            == 404
        )


@posix_only
class TestModeAndRestart:
    def test_mode_change_restarts_with_resume(self, home, fake_claude, api):
        a = api()
        sid = _new(a, home)["id"]
        a.call("POST", f"/v1/claude/sessions/{sid}/message", json={"text": "one"})
        a.wait(sid, _is_result)
        res = a.call(
            "POST", f"/v1/claude/sessions/{sid}/mode", json={"permission_mode": "plan"}
        )
        assert res.status_code == 200 and res.json()["permission_mode"] == "plan"
        assert res.json()["alive"] is False
        a.call("POST", f"/v1/claude/sessions/{sid}/message", json={"text": "two"})
        a.wait(sid, lambda evs: sum(e.get("type") == "result" for e in evs) == 2)
        starts = [json.loads(x) for x in fake_claude.read_text().splitlines()]
        assert len(starts) == 2
        argv = starts[1]["argv"]
        assert argv[argv.index("--permission-mode") + 1] == "plan"
        assert (
            argv[argv.index("--resume") + 1] == "11111111-2222-3333-4444-555555555555"
        )

    def test_mode_refused_while_waiting_for_an_answer(self, home, fake_claude, api):
        a = api()
        sid = _new(a, home)["id"]
        a.call(
            "POST", f"/v1/claude/sessions/{sid}/message", json={"text": "use a tool"}
        )
        a.wait(sid, lambda evs: any(e.get("kind") == "approval" for e in evs))
        res = a.call(
            "POST", f"/v1/claude/sessions/{sid}/mode", json={"permission_mode": "plan"}
        )
        assert res.status_code == 409

    def test_idle_process_is_stopped_then_resumed(
        self, home, fake_claude, api, monkeypatch
    ):
        monkeypatch.setattr(cr, "IDLE_STOP_SECONDS", 0.3)
        a = api()
        sid = _new(a, home)["id"]
        a.call("POST", f"/v1/claude/sessions/{sid}/message", json={"text": "one"})
        a.wait(sid, _is_result)
        a.wait(sid, lambda evs: any(e.get("kind") == "idle_stopped" for e in evs))
        assert a.call("GET", f"/v1/claude/sessions/{sid}").json()["alive"] is False
        a.call("POST", f"/v1/claude/sessions/{sid}/message", json={"text": "two"})
        a.wait(sid, lambda evs: sum(e.get("type") == "result" for e in evs) == 2)


@posix_only
class TestTranscript:
    def test_project_dir_name(self):
        assert cr.project_dir_name("/home/a/my repo") == "-home-a-my-repo"

    def test_resume_replays_the_saved_conversation(self, home, fake_claude, api):
        folder = home / "repo"
        folder.mkdir()
        cid = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
        proj = home / ".claude" / "projects" / cr.project_dir_name(str(folder))
        proj.mkdir(parents=True)
        lines = [
            {
                "type": "user",
                "message": {"role": "user", "content": "earlier question"},
            },
            {
                "type": "assistant",
                "message": {
                    "role": "assistant",
                    "content": [{"type": "text", "text": "earlier answer"}],
                },
            },
            {
                "type": "user",
                "isMeta": True,
                "message": {"role": "user", "content": "hidden"},
            },
            {"type": "summary", "summary": "ignored"},
        ]
        (proj / f"{cid}.jsonl").write_text("\n".join(json.dumps(x) for x in lines))
        a = api()
        sid = a.call(
            "POST", "/v1/claude/sessions", json={"cwd": str(folder), "resume": cid}
        ).json()["id"]
        evs = a.events(sid)
        assert [e["type"] for e in evs] == ["user", "assistant"]
        assert all(e["replayed"] for e in evs)
        a.call("POST", f"/v1/claude/sessions/{sid}/message", json={"text": "next"})
        a.wait(sid, _is_result)
        argv = json.loads(fake_claude.read_text().splitlines()[0])["argv"]
        assert argv[argv.index("--resume") + 1] == cid


@posix_only
class TestRepoMemory:
    def test_window_is_told_about_its_memory_folder(self, home, fake_claude, api):
        a = api()
        sid = _new(a, home)["id"]
        a.call("POST", f"/v1/claude/sessions/{sid}/message", json={"text": "hi"})
        a.wait(sid, _is_result)
        argv = json.loads(fake_claude.read_text().splitlines()[0])["argv"]
        mem = argv[argv.index("--add-dir") + 1]
        assert mem.endswith("/memory/repo")
        assert os.path.isfile(os.path.join(mem, "INDEX.md"))
        assert os.path.isdir(os.path.join(mem, "fonctionne"))
        assert os.path.isdir(os.path.join(mem, "ne-fonctionne-pas"))
        assert mem in argv[argv.index("--append-system-prompt") + 1]

    def test_own_memory_files_are_allowed_without_asking(self, home, fake_claude, api):
        from openjarvis.server import repo_memory

        a = api()
        target = repo_memory.ensure_repo_memory(home / "repo") / "fonctionne.md"
        sid = _new(a, home)["id"]
        a.call(
            "POST", f"/v1/claude/sessions/{sid}/message", json={"text": f"mem {target}"}
        )
        evs = a.wait(sid, _is_result)
        assert not any(e.get("kind") == "approval" for e in evs)
        assert any(
            b.get("text") == "mem allow"
            for e in evs
            if e["type"] == "assistant"
            for b in e["message"]["content"]
        )
        from openjarvis.server import journal

        logs = journal.read_logs()
        assert any(
            e["category"] == "memory" and "fonctionne.md" in e["message"] for e in logs
        )

    def test_anything_else_still_asks(self, home, fake_claude, api):
        a = api()
        sid = _new(a, home)["id"]
        a.call(
            "POST",
            f"/v1/claude/sessions/{sid}/message",
            json={"text": f"mem {home / 'repo' / 'secret.txt'}"},
        )
        evs = a.wait(sid, lambda e: any(x.get("kind") == "approval" for x in e))
        assert any(e.get("kind") == "approval" for e in evs)


@posix_only
class TestCustomModeAndSettings:
    def _argv(self, fake_claude):
        return [json.loads(x)["argv"] for x in fake_claude.read_text().splitlines()]

    def test_custom_runs_claude_in_ask_mode_and_keeps_its_rules(
        self, home, fake_claude, api
    ):
        a = api()
        info = _new(
            a, home, permission_mode="custom", rules={"readonly": True, "evil": 1}
        )
        assert info["permission_mode"] == "custom"
        assert info["rules"]["readonly"] is True and "evil" not in info["rules"]
        sid = info["id"]
        a.call("POST", f"/v1/claude/sessions/{sid}/message", json={"text": "hi"})
        a.wait(sid, _is_result)
        argv = self._argv(fake_claude)[0]
        # Claude's own "accept edits" would let rm / mv / cp through: not for Custom.
        assert argv[argv.index("--permission-mode") + 1] == "default"

    def test_a_ticked_rule_answers_for_the_owner_and_is_logged(
        self, home, fake_claude, api
    ):
        from openjarvis.server import journal

        a = api()
        sid = _new(a, home, permission_mode="custom", rules={"any_command": True})["id"]
        a.call(
            "POST", f"/v1/claude/sessions/{sid}/message", json={"text": "use a tool"}
        )
        evs = a.wait(sid, _is_result)
        assert not any(e.get("kind") == "approval" for e in evs)
        assert any(
            b.get("text") == "tool allow"
            for e in evs
            if e["type"] == "assistant"
            for b in e["message"]["content"]
        )
        assert any(
            e["category"] == "rules" and "echo hi" in e["message"]
            for e in journal.read_logs()
        )

    def test_without_a_rule_it_still_asks(self, home, fake_claude, api):
        a = api()
        sid = _new(a, home, permission_mode="custom", rules={"readonly": True})["id"]
        a.call(
            "POST", f"/v1/claude/sessions/{sid}/message", json={"text": "use a tool"}
        )
        evs = a.wait(sid, lambda e: any(x.get("kind") == "approval" for x in e))
        assert any(e.get("kind") == "approval" for e in evs)

    def test_rules_are_ignored_outside_custom_mode(self, home, fake_claude, api):
        a = api()
        sid = _new(a, home, permission_mode="acceptEdits", rules={"any_command": True})[
            "id"
        ]
        a.call(
            "POST", f"/v1/claude/sessions/{sid}/message", json={"text": "use a tool"}
        )
        evs = a.wait(sid, lambda e: any(x.get("kind") == "approval" for x in e))
        assert any(e.get("kind") == "approval" for e in evs)

    def test_switching_between_ask_modes_restarts_only_when_claudes_mode_changes(
        self, home, fake_claude, api
    ):
        a = api()
        sid = _new(a, home, permission_mode="acceptEdits")["id"]
        a.call("POST", f"/v1/claude/sessions/{sid}/message", json={"text": "one"})
        a.wait(sid, _is_result)
        res = a.call(
            "POST",
            f"/v1/claude/sessions/{sid}/mode",
            json={"permission_mode": "custom", "rules": {"build_test": True}},
        )
        assert res.json()["alive"] is False  # acceptEdits -> custom: program restarts
        assert res.json()["rules"]["build_test"] is True
        a.call("POST", f"/v1/claude/sessions/{sid}/message", json={"text": "two"})
        a.wait(sid, lambda evs: sum(e.get("type") == "result" for e in evs) == 2)
        res = a.call(
            "POST",
            f"/v1/claude/sessions/{sid}/mode",
            json={"permission_mode": "default"},
        )
        assert res.json()["alive"] is True  # custom -> default: same program mode

    def test_auto_is_default_and_passed_to_claude(self, home, fake_claude, api):
        a = api()
        info = _new(a, home)
        assert info["permission_mode"] == "auto"
        a.call("POST", f"/v1/claude/sessions/{info['id']}/message", json={"text": "x"})
        a.wait(info["id"], _is_result)
        argv = self._argv(fake_claude)[0]
        assert argv[argv.index("--permission-mode") + 1] == "auto"

    def test_model_and_effort_are_passed_and_changeable(self, home, fake_claude, api):
        a = api()
        sid = _new(a, home, model="sonnet", effort="low")["id"]
        a.call("POST", f"/v1/claude/sessions/{sid}/message", json={"text": "one"})
        a.wait(sid, _is_result)
        first = self._argv(fake_claude)[0]
        assert first[first.index("--model") + 1] == "sonnet"
        assert first[first.index("--effort") + 1] == "low"
        res = a.call(
            "POST",
            f"/v1/claude/sessions/{sid}/settings",
            json={"model": "opus", "effort": "high"},
        )
        assert res.status_code == 200
        assert res.json()["model"] == "opus" and res.json()["effort"] == "high"
        a.call("POST", f"/v1/claude/sessions/{sid}/message", json={"text": "two"})
        a.wait(sid, lambda evs: sum(e.get("type") == "result" for e in evs) == 2)
        second = self._argv(fake_claude)[1]
        assert second[second.index("--model") + 1] == "opus"
        assert second[second.index("--effort") + 1] == "high"
        assert "--resume" in second
        # Back to the program's defaults: no flag at all.
        a.call("POST", f"/v1/claude/sessions/{sid}/settings", json={})
        a.call("POST", f"/v1/claude/sessions/{sid}/message", json={"text": "three"})
        a.wait(sid, lambda evs: sum(e.get("type") == "result" for e in evs) == 3)
        third = self._argv(fake_claude)[2]
        assert "--model" not in third and "--effort" not in third

    def test_bad_model_or_effort_refused(self, home, fake_claude, api):
        a = api()
        (home / "repo").mkdir(exist_ok=True)
        for body in ({"effort": "ludicrous"}, {"model": "x; rm -rf ~"}):
            res = a.call(
                "POST", "/v1/claude/sessions", json={"cwd": str(home / "repo"), **body}
            )
            assert res.status_code == 400
        sid = _new(a, home)["id"]
        res = a.call(
            "POST", f"/v1/claude/sessions/{sid}/settings", json={"model": "--flag"}
        )
        assert res.status_code == 400

    def test_settings_refused_while_waiting_for_an_answer(self, home, fake_claude, api):
        a = api()
        sid = _new(a, home)["id"]
        a.call(
            "POST", f"/v1/claude/sessions/{sid}/message", json={"text": "use a tool"}
        )
        a.wait(sid, lambda evs: any(e.get("kind") == "approval" for e in evs))
        res = a.call(
            "POST", f"/v1/claude/sessions/{sid}/settings", json={"model": "opus"}
        )
        assert res.status_code == 409


def test_find_claude_falls_back_to_usual_folders(tmp_path, monkeypatch):
    from openjarvis.server import claude_routes as cr

    binary = tmp_path / ".npm-global" / "bin" / "claude"
    binary.parent.mkdir(parents=True)
    binary.write_text("#!/bin/sh\n")
    binary.chmod(0o755)
    monkeypatch.delenv("OPENJARVIS_CLAUDE_BIN", raising=False)
    monkeypatch.setenv("PATH", "/nonexistent")
    monkeypatch.setattr(cr.Path, "home", lambda: tmp_path)
    assert cr.find_claude() == str(binary)


def test_claude_env_adds_the_usual_user_bin_folders(tmp_path, monkeypatch):
    from openjarvis.server import claude_routes as cr

    (tmp_path / ".npm-global" / "bin").mkdir(parents=True)
    monkeypatch.setattr(cr.Path, "home", lambda: tmp_path)
    env = cr.claude_env({"PATH": "/usr/bin"})
    assert str(tmp_path / ".npm-global" / "bin") in env["PATH"].split(":")
    assert env["PATH"].split(":")[0] == "/usr/bin"
