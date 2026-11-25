"""Jarvis assistant: policy, MCP helper, screen bridge, guarded tools."""

# ruff: noqa: E501, F811

from __future__ import annotations

import asyncio
import json
import os
import stat
import subprocess
import sys
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from openjarvis.server import claude_routes as cr
from openjarvis.server import jarvis_mcp as mcp
from openjarvis.server import jarvis_policy as pol
from openjarvis.server import jarvis_routes as jr
from openjarvis.server import terminal_routes as tr
from openjarvis.server import workspace_routes as wr
from tests.server.test_claude_routes import (  # noqa: F401  (fixtures)
    FRONTEND,
    LOCAL_HOST,
    Api,
    home,
)

posix_only = pytest.mark.skipif(os.name != "posix", reason="POSIX only")

# Fake `claude` for a Jarvis session: asks permission for each tool named in
# the message ("tools: a|b|c"), then reports what it was told.
FAKE_JARVIS = r"""#!{python}
import json, os, sys
def out(d): print(json.dumps(d), flush=True)
with open(os.environ["FAKE_LOG"], "a") as f:
    f.write(json.dumps({{"argv": sys.argv[1:]}}) + "\n")
for line in sys.stdin:
    msg = json.loads(line)
    if msg.get("type") != "user":
        continue
    text = msg["message"]["content"]
    names = text.split("tools:", 1)[1].strip().split("|")
    out({{"type": "system", "subtype": "init", "session_id": "99999999-aaaa-bbbb-cccc-000000000000"}})
    seen = []
    for i, name in enumerate(names):
        tool, _, path = name.partition("@")
        out({{"type": "control_request", "request_id": "q%d" % i, "request": {{
            "subtype": "can_use_tool", "tool_name": tool, "display_name": tool,
            "input": {{"path": path}} if path else {{}}}}}})
        reply = json.loads(sys.stdin.readline())
        seen.append(tool + ":" + reply["response"]["response"]["behavior"])
    out({{"type": "assistant", "message": {{"role": "assistant", "content": [
        {{"type": "text", "text": ";".join(seen)}}]}}}})
    out({{"type": "result", "subtype": "success", "is_error": False, "result": "ok"}})
"""


@pytest.fixture()
def fake_jarvis(tmp_path, monkeypatch):
    path = tmp_path / "fake-claude"
    path.write_text(FAKE_JARVIS.format(python=sys.executable))
    path.chmod(path.stat().st_mode | stat.S_IEXEC)
    log = tmp_path / "fake.log"
    monkeypatch.setenv("OPENJARVIS_CLAUDE_BIN", str(path))
    monkeypatch.setenv("FAKE_LOG", str(log))
    return log


def _app() -> FastAPI:
    app = FastAPI()
    app.include_router(cr.create_claude_router())
    app.include_router(jr.create_jarvis_router())
    app.state.allowed_origins = [FRONTEND]
    app.state.bind_host = "127.0.0.1"
    return app


class JApi(Api):
    """Like Api, but the client looks like it comes from the loopback address."""

    def __init__(self, app: FastAPI):
        self.app = app
        self.client = TestClient(
            app, base_url="http://localhost:8010", client=("127.0.0.1", 50000)
        )
        self.client.__enter__()
        self.headers = {
            "origin": FRONTEND,
            "host": LOCAL_HOST,
            wr.TOKEN_HEADER: tr.get_terminal_token(app),
        }

    def session(self, home, kind="jarvis"):
        (home / "w").mkdir(exist_ok=True)
        res = self.call(
            "POST", "/v1/claude/sessions", json={"cwd": str(home / "w"), "kind": kind}
        )
        assert res.status_code == 200, res.text
        return res.json()["id"]

    def secret(self, sid):
        return self.app.state.claude_manager.sessions[sid].secret

    def tool(self, secret, name, args=None, client_ip=None, host=LOCAL_HOST):
        headers = {"host": host}
        if secret is not None:
            headers["x-jarvis-secret"] = secret
        return self.client.post(
            "/v1/jarvis/tool", headers=headers, json={"name": name, "input": args or {}}
        )

    def grant(self, sid, tool, args):
        self.app.state.claude_manager.sessions[sid].grants.add(pol.PREFIX + tool, args)


@pytest.fixture()
def japi():
    made: list[JApi] = []

    def make():
        a = JApi(_app())
        made.append(a)
        return a

    yield make
    for a in made:
        a.close()


# ---------------------------------------------------------------------------
# Policy
# ---------------------------------------------------------------------------


class TestPolicy:
    def test_safe_tools_are_allowed(self):
        for name in (
            "open_repo",
            "new_claude_tab",
            "new_terminal",
            "send_prompt",
            "read_chat",
            "list_workspace",
            "find_repos",
        ):
            assert pol.decide(pol.PREFIX + name) == "allow", name

    def test_sensitive_tools_ask(self):
        assert pol.decide(pol.PREFIX + "create_repo") == "ask"
        assert pol.decide(pol.PREFIX + "delete_path") == "ask"

    def test_everything_else_is_denied(self):
        for name in (
            "Bash",
            "Write",
            "Edit",
            "WebFetch",
            "mcp__other__thing",
            pol.PREFIX + "format_disk",
            pol.PREFIX,
            "",
        ):
            assert pol.decide(name) == "deny", name

    def test_every_tool_has_a_risk_place_and_object_schema(self):
        for name, (risk, where, desc, schema) in pol.TOOLS.items():
            assert risk in ("safe", "sensitive") and where in ("screen", "server")
            assert desc and schema["type"] == "object"

    def test_destructive_tools_are_all_sensitive(self):
        for name in ("create_repo", "delete_path"):
            assert pol.TOOLS[name][0] == "sensitive"


class TestGrants:
    def test_single_use(self):
        g = pol.Grants()
        g.add(pol.PREFIX + "delete_path", {"path": "/a"})
        assert g.consume(pol.PREFIX + "delete_path", {"path": "/a"}) is True
        assert g.consume(pol.PREFIX + "delete_path", {"path": "/a"}) is False

    def test_bound_to_exact_arguments_and_tool(self):
        g = pol.Grants()
        g.add(pol.PREFIX + "delete_path", {"path": "/a"})
        assert g.consume(pol.PREFIX + "delete_path", {"path": "/b"}) is False
        assert g.consume(pol.PREFIX + "create_repo", {"path": "/a"}) is False
        assert g.consume(pol.PREFIX + "delete_path", {"path": "/a"}) is True

    def test_key_ignores_argument_order_and_prefix(self):
        g = pol.Grants()
        g.add("delete_path", {"a": 1, "b": 2})
        assert g.consume(pol.PREFIX + "delete_path", {"b": 2, "a": 1}) is True

    def test_expires(self):
        g = pol.Grants(ttl=10)
        g.add("create_repo", {"path": "/x"}, now=100.0)
        assert g.consume("create_repo", {"path": "/x"}, now=111.0) is False
        g.add("create_repo", {"path": "/x"}, now=100.0)
        assert g.consume("create_repo", {"path": "/x"}, now=109.0) is True


# ---------------------------------------------------------------------------
# MCP helper
# ---------------------------------------------------------------------------


class TestMcp:
    def call(self, msg, caller=None):
        return mcp.handle(msg, caller or (lambda n, a: {"ok": True, "result": "x"}))

    def test_initialize_echoes_protocol_and_offers_tools(self):
        r = self.call(
            {
                "jsonrpc": "2.0",
                "id": 1,
                "method": "initialize",
                "params": {"protocolVersion": "2025-03-26"},
            }
        )
        assert r["result"]["protocolVersion"] == "2025-03-26"
        assert "tools" in r["result"]["capabilities"]

    def test_tools_list_matches_the_policy_table(self):
        r = self.call({"jsonrpc": "2.0", "id": 2, "method": "tools/list"})
        assert {t["name"] for t in r["result"]["tools"]} == set(pol.TOOLS)
        assert all(t["inputSchema"]["type"] == "object" for t in r["result"]["tools"])

    def test_notifications_get_no_answer(self):
        assert (
            self.call({"jsonrpc": "2.0", "method": "notifications/initialized"}) is None
        )

    def test_tool_call_success_and_failure(self):
        seen = []

        def caller(name, args):
            seen.append((name, args))
            return {"ok": name == "open_repo", "result": {"p": 1}, "error": "nope"}

        good = self.call(
            {
                "jsonrpc": "2.0",
                "id": 3,
                "method": "tools/call",
                "params": {"name": "open_repo", "arguments": {"path": "/a"}},
            },
            caller,
        )
        assert good["result"]["isError"] is False
        assert json.loads(good["result"]["content"][0]["text"]) == {"p": 1}
        bad = self.call(
            {
                "jsonrpc": "2.0",
                "id": 4,
                "method": "tools/call",
                "params": {"name": "find_repos", "arguments": {"query": "q"}},
            },
            caller,
        )
        assert bad["result"]["isError"] is True
        assert bad["result"]["content"][0]["text"] == "nope"
        assert seen == [("open_repo", {"path": "/a"}), ("find_repos", {"query": "q"})]

    def test_unknown_tool_and_method(self):
        t = self.call(
            {
                "jsonrpc": "2.0",
                "id": 5,
                "method": "tools/call",
                "params": {"name": "rm_rf", "arguments": {}},
            }
        )
        assert t["error"]["code"] == -32602
        m = self.call({"jsonrpc": "2.0", "id": 6, "method": "bogus"})
        assert m["error"]["code"] == -32601

    def test_works_as_a_real_subprocess_talking_to_a_server(self):
        received = {}

        class H(BaseHTTPRequestHandler):
            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                received.update(
                    body=body,
                    secret=self.headers.get("X-Jarvis-Secret"),
                    path=self.path,
                )
                data = json.dumps({"ok": True, "result": {"opened": True}}).encode()
                self.send_response(200)
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            def log_message(self, *a):
                pass

        srv = HTTPServer(("127.0.0.1", 0), H)
        threading.Thread(target=srv.serve_forever, daemon=True).start()
        try:
            env = {
                **os.environ,
                "JARVIS_API": f"http://127.0.0.1:{srv.server_port}",
                "JARVIS_SECRET": "s3cret",
            }
            lines = [
                {"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {}},
                {"jsonrpc": "2.0", "method": "notifications/initialized"},
                {"jsonrpc": "2.0", "id": 2, "method": "tools/list"},
                {
                    "jsonrpc": "2.0",
                    "id": 3,
                    "method": "tools/call",
                    "params": {"name": "open_repo", "arguments": {"path": "/x"}},
                },
            ]
            out = subprocess.run(
                [sys.executable, "-m", "openjarvis.server.jarvis_mcp"],
                input="\n".join(json.dumps(x) for x in lines) + "\n",
                capture_output=True,
                text=True,
                env=env,
                timeout=30,
                check=True,
            ).stdout.splitlines()
        finally:
            srv.shutdown()
        replies = [json.loads(x) for x in out]
        assert [r["id"] for r in replies] == [1, 2, 3]  # no reply to the notification
        assert received["path"] == "/v1/jarvis/tool"
        assert received["secret"] == "s3cret"
        assert received["body"] == {"name": "open_repo", "input": {"path": "/x"}}
        assert replies[2]["result"]["isError"] is False

    def test_unreachable_server_is_an_error_not_a_crash(self, monkeypatch):
        monkeypatch.setenv("JARVIS_API", "http://127.0.0.1:9")
        monkeypatch.setenv("JARVIS_SECRET", "x")
        out = mcp.call_api("open_repo", {})
        assert out["ok"] is False and "Cannot reach" in out["error"]
        monkeypatch.delenv("JARVIS_SECRET")
        assert mcp.call_api("open_repo", {})["ok"] is False


# ---------------------------------------------------------------------------
# Screen bridge
# ---------------------------------------------------------------------------


class TestBridge:
    def test_no_screen_means_a_clear_error(self):
        async def go():
            with pytest.raises(jr.NoScreen):
                await jr.Bridge().call("open_repo", {})

        asyncio.run(go())

    def test_command_claim_and_result(self):
        async def go():
            b = jr.Bridge()
            b.clients = 1
            task = asyncio.create_task(b.call("open_repo", {"path": "/a"}))
            await asyncio.sleep(0.05)
            cmd = b.commands[0]
            assert (cmd["name"], cmd["args"]) == ("open_repo", {"path": "/a"})
            assert b.resolve(cmd["id"], {"ok": True}) is False  # not claimed yet
            assert b.claim(cmd["id"]) is True
            assert b.claim(cmd["id"]) is False  # a second screen loses
            assert b.resolve(cmd["id"], {"ok": True, "result": 7}) is True
            assert (await task) == {"ok": True, "result": 7}
            assert b.pending == {}

        asyncio.run(go())

    def test_times_out_when_the_screen_never_answers(self):
        async def go():
            b = jr.Bridge()
            b.clients = 1
            with pytest.raises(jr.NoScreen):
                await b.call("open_repo", {}, timeout=0.1)
            assert b.pending == {}

        asyncio.run(go())


# ---------------------------------------------------------------------------
# Server-side tools
# ---------------------------------------------------------------------------


@posix_only
class TestFileTools:
    def test_find_repos(self, home):
        (home / "code" / "alpha" / ".git").mkdir(parents=True)
        (home / "code" / "beta-app" / ".git").mkdir(parents=True)
        (home / "code" / "notes").mkdir()
        (home / "code" / "alpha" / "node_modules" / "x" / ".git").mkdir(parents=True)
        (home / ".hidden" / "secret" / ".git").mkdir(parents=True)
        names = lambda q: sorted(r["name"] for r in jr.find_repos(q, home))  # noqa: E731
        assert names("") == ["alpha", "beta-app"]
        assert names("BETA") == ["beta-app"]
        assert names("zzz") == []

    def test_create_repo(self, home):
        (home / "projects").mkdir()
        out = jr.create_repo(str(home / "projects" / "new"), home)
        assert (home / "projects" / "new" / ".git").is_dir()
        assert out["name"] == "new"

    def test_create_repo_refusals(self, home):
        with pytest.raises(ValueError):
            jr.create_repo("/etc/evil", home)
        with pytest.raises(ValueError):
            jr.create_repo(str(home), home)
        with pytest.raises(ValueError):  # the parent folder must already exist
            jr.create_repo(str(home / "no" / "such" / "parent"), home)
        jr.create_repo(str(home / "r"), home)
        with pytest.raises(ValueError):
            jr.create_repo(str(home / "r"), home)
        (home / "afile").write_text("x")
        with pytest.raises(ValueError):
            jr.create_repo(str(home / "afile"), home)

    def test_delete_moves_to_trash_and_keeps_the_data(self, home):
        (home / "old").mkdir()
        (home / "old" / "f.txt").write_text("keep me")
        out = jr.delete_path(str(home / "old"), home)
        assert not (home / "old").exists()
        moved = home / jr.TRASH_DIR
        assert str(moved) in out["moved_to"]
        assert (next(moved.iterdir()) / "f.txt").read_text() == "keep me"

    def test_delete_refusals(self, home):
        (home / ".ssh").mkdir()
        (home / "ok").mkdir()
        for bad in (
            str(home),
            "/etc/passwd",
            str(home / ".ssh"),
            str(home / "missing"),
        ):
            with pytest.raises(ValueError):
                jr.delete_path(bad, home)
        jr.delete_path(str(home / "ok"), home)
        trashed = next((home / jr.TRASH_DIR).iterdir())
        with pytest.raises(ValueError):
            jr.delete_path(str(trashed), home)

    def test_two_deletions_of_the_same_name_do_not_collide(self, home):
        for _ in range(2):
            (home / "dup").mkdir()
            jr.delete_path(str(home / "dup"), home)
        assert len(list((home / jr.TRASH_DIR).iterdir())) == 2


# ---------------------------------------------------------------------------
# Tool endpoint: authentication and the approval rule
# ---------------------------------------------------------------------------


@posix_only
class TestToolEndpoint:
    def test_needs_the_session_secret(self, home, fake_jarvis, japi):
        a = japi()
        sid = a.session(home)
        assert a.tool(None, "find_repos").status_code == 403
        assert a.tool("wrong", "find_repos").status_code == 403
        assert a.tool("", "find_repos").status_code == 403
        assert a.tool(a.secret(sid), "find_repos", {"query": ""}).status_code == 200

    def test_a_code_chat_has_no_secret_and_cannot_call_tools(
        self, home, fake_jarvis, japi
    ):
        a = japi()
        a.session(home, kind="code")
        assert a.tool("", "find_repos").status_code == 403

    def test_browser_token_is_not_enough(self, home, fake_jarvis, japi):
        a = japi()
        a.session(home)
        res = a.client.post(
            "/v1/jarvis/tool",
            headers=a.headers,
            json={"name": "find_repos", "input": {}},
        )
        assert res.status_code == 403

    def test_only_from_the_local_machine_and_with_a_local_host(
        self, home, fake_jarvis, japi
    ):
        a = japi()
        sid = a.session(home)
        secret = a.secret(sid)
        assert a.tool(secret, "find_repos", host="evil.example").status_code == 403
        remote = TestClient(
            a.app, base_url="http://localhost:8010", client=("203.0.113.9", 4000)
        )
        with remote:
            res = remote.post(
                "/v1/jarvis/tool",
                headers={"host": LOCAL_HOST, "x-jarvis-secret": secret},
                json={"name": "find_repos", "input": {}},
            )
        assert res.status_code == 403

    def test_unknown_tool(self, home, fake_jarvis, japi):
        a = japi()
        sid = a.session(home)
        assert a.tool(a.secret(sid), "format_disk").status_code == 404

    def test_create_repo_needs_the_owners_approval(self, home, fake_jarvis, japi):
        a = japi()
        sid = a.session(home)
        target = str(home / "fresh")
        refused = a.tool(a.secret(sid), "create_repo", {"path": target}).json()
        assert refused["ok"] is False and "approved" in refused["error"]
        assert not os.path.exists(target)
        a.grant(sid, "create_repo", {"path": target})
        done = a.tool(a.secret(sid), "create_repo", {"path": target}).json()
        assert done["ok"] is True and os.path.isdir(target + "/.git")
        again = a.tool(
            a.secret(sid), "create_repo", {"path": str(home / "other")}
        ).json()
        assert again["ok"] is False  # approval was for another call

    def test_approval_is_single_use_and_exact(self, home, fake_jarvis, japi):
        a = japi()
        sid = a.session(home)
        (home / "a").mkdir()
        (home / "b").mkdir()
        a.grant(sid, "delete_path", {"path": str(home / "a")})
        other = a.tool(a.secret(sid), "delete_path", {"path": str(home / "b")}).json()
        assert other["ok"] is False and (home / "b").exists()
        ok = a.tool(a.secret(sid), "delete_path", {"path": str(home / "a")}).json()
        assert ok["ok"] is True and not (home / "a").exists()
        (home / "a").mkdir()
        replay = a.tool(a.secret(sid), "delete_path", {"path": str(home / "a")}).json()
        assert replay["ok"] is False and (home / "a").exists()

    def test_validation_errors_come_back_as_tool_errors(self, home, fake_jarvis, japi):
        a = japi()
        sid = a.session(home)
        a.grant(sid, "delete_path", {"path": "/etc/passwd"})
        out = a.tool(a.secret(sid), "delete_path", {"path": "/etc/passwd"}).json()
        assert out["ok"] is False and os.path.exists("/etc/passwd")

    def test_screen_tool_without_a_screen(self, home, fake_jarvis, japi):
        a = japi()
        sid = a.session(home)
        out = a.tool(a.secret(sid), "open_repo", {"path": str(home)}).json()
        assert out["ok"] is False and "screen" in out["error"].lower()

    def test_screen_tool_round_trip_through_the_browser(self, home, fake_jarvis, japi):
        a = japi()
        sid = a.session(home)
        secret = a.secret(sid)
        bridge = jr.Bridge()
        bridge.clients = 1  # pretend a browser is connected
        a.app.state.jarvis_bridge = bridge
        seen = {}

        def browser():
            for _ in range(100):
                res = a.call("GET", "/v1/jarvis/commands", params={"follow": "false"})
                lines = [json.loads(x) for x in res.text.splitlines() if x.strip()]
                if lines:
                    cmd = lines[0]
                    seen["cmd"] = cmd
                    seen["claimed"] = a.call(
                        "POST", f"/v1/jarvis/commands/{cmd['id']}/claim"
                    ).json()
                    seen["second"] = a.call(
                        "POST", f"/v1/jarvis/commands/{cmd['id']}/claim"
                    ).json()
                    a.call(
                        "POST",
                        f"/v1/jarvis/commands/{cmd['id']}/result",
                        json={"ok": True, "result": {"opened": cmd["args"]["path"]}},
                    )
                    return
                threading.Event().wait(0.05)

        t = threading.Thread(target=browser)
        t.start()
        out = a.tool(secret, "open_repo", {"path": "/home/x/repo"}).json()
        t.join()
        assert out == {"ok": True, "result": {"opened": "/home/x/repo"}, "error": None}
        assert seen["cmd"]["name"] == "open_repo"
        assert seen["claimed"] == {"claimed": True} and seen["second"] == {
            "claimed": False
        }

    def test_browser_routes_need_the_token(self, home, fake_jarvis, japi):
        a = japi()
        bad = {**a.headers, wr.TOKEN_HEADER: "nope"}
        for method, path in (
            ("GET", "/v1/jarvis/commands"),
            ("POST", "/v1/jarvis/commands/c1/claim"),
            ("POST", "/v1/jarvis/commands/c1/result"),
        ):
            res = a.client.request(method, path, headers=bad, json={"ok": True})
            assert res.status_code == 403, path
        hostile = {**a.headers, "origin": "http://evil.example"}
        assert a.client.get("/v1/jarvis/commands", headers=hostile).status_code == 403


# ---------------------------------------------------------------------------
# A whole Jarvis session
# ---------------------------------------------------------------------------


def _is_result(evs):
    return any(e.get("type") == "result" for e in evs)


@posix_only
class TestJarvisSession:
    def test_started_without_builtin_tools_and_with_its_mcp_server(
        self, home, fake_jarvis, japi
    ):
        a = japi()
        sid = a.session(home)
        a.call(
            "POST",
            f"/v1/claude/sessions/{sid}/message",
            json={"text": "tools: mcp__jarvis__open_repo"},
        )
        a.wait(sid, _is_result)
        argv = json.loads(fake_jarvis.read_text().splitlines()[0])["argv"]
        assert argv[argv.index("--tools") + 1] == ""
        assert "--strict-mcp-config" in argv
        cfg_path = argv[argv.index("--mcp-config") + 1]
        assert not cfg_path.lstrip().startswith("{")  # a file, not inline JSON
        assert stat.S_IMODE(os.stat(cfg_path).st_mode) == 0o600
        assert stat.S_IMODE(os.stat(os.path.dirname(cfg_path)).st_mode) == 0o700
        assert a.secret(sid) not in " ".join(argv)  # never on the command line
        cfg = json.load(open(cfg_path))["mcpServers"]["jarvis"]
        assert cfg["args"] == ["-m", "openjarvis.server.jarvis_mcp"]
        assert cfg["env"]["JARVIS_SECRET"] == a.secret(sid)
        assert cfg["env"]["JARVIS_API"].startswith("http://127.0.0.1:")
        assert "Jarvis" in argv[argv.index("--append-system-prompt") + 1]
        assert argv[argv.index("--permission-mode") + 1] == "default"
        assert "--resume" not in argv

    def test_the_private_config_is_removed_when_the_chat_closes(
        self, home, fake_jarvis, japi
    ):
        a = japi()
        sid = a.session(home)
        a.call(
            "POST",
            f"/v1/claude/sessions/{sid}/message",
            json={"text": "tools: mcp__jarvis__open_repo"},
        )
        a.wait(sid, _is_result)
        argv = json.loads(fake_jarvis.read_text().splitlines()[0])["argv"]
        cfg_path = argv[argv.index("--mcp-config") + 1]
        assert os.path.exists(cfg_path)
        a.call("DELETE", f"/v1/claude/sessions/{sid}")
        assert not os.path.exists(cfg_path)

    def test_a_jarvis_chat_cannot_choose_a_looser_mode(self, home, fake_jarvis, japi):
        a = japi()
        (home / "w").mkdir()
        res = a.call(
            "POST",
            "/v1/claude/sessions",
            json={"cwd": str(home / "w"), "kind": "jarvis", "permission_mode": "plan"},
        )
        assert res.json()["permission_mode"] == "default"

    def test_unknown_kind_refused(self, home, fake_jarvis, japi):
        a = japi()
        res = a.call(
            "POST", "/v1/claude/sessions", json={"cwd": str(home), "kind": "root"}
        )
        assert res.status_code == 400

    def test_policy_applies_to_every_request_claude_makes(
        self, home, fake_jarvis, japi
    ):
        a = japi()
        sid = a.session(home)
        target = str(home / "victim")
        os.mkdir(target)
        names = f"mcp__jarvis__open_repo|Bash|mcp__other__x|mcp__jarvis__delete_path@{target}"
        a.call(
            "POST",
            f"/v1/claude/sessions/{sid}/message",
            json={"text": "tools: " + names},
        )
        evs = a.wait(sid, lambda e: any(x.get("kind") == "approval" for x in e))
        asks = [e for e in evs if e.get("kind") == "approval"]
        # only the sensitive tool reached the owner; the safe one passed, others were denied
        assert [x["tool_name"] for x in asks] == ["mcp__jarvis__delete_path"]
        assert os.path.exists(target)
        a.call(
            "POST",
            f"/v1/claude/sessions/{sid}/decision",
            json={"request_id": asks[0]["request_id"], "allow": True},
        )
        evs = a.wait(sid, _is_result)
        text = next(
            b["text"]
            for e in evs
            if e["type"] == "assistant"
            for b in e["message"]["content"]
        )
        assert text == (
            "mcp__jarvis__open_repo:allow;Bash:deny;mcp__other__x:deny;"
            "mcp__jarvis__delete_path:allow"
        )
        # the Accept created the approval the tool endpoint demands, for this call only
        gone = a.tool(a.secret(sid), "delete_path", {"path": target}).json()
        assert gone["ok"] is True and not os.path.exists(target)

    def test_refusing_leaves_nothing_to_use(self, home, fake_jarvis, japi):
        a = japi()
        sid = a.session(home)
        target = str(home / "keep")
        os.mkdir(target)
        a.call(
            "POST",
            f"/v1/claude/sessions/{sid}/message",
            json={"text": f"tools: mcp__jarvis__delete_path@{target}"},
        )
        evs = a.wait(sid, lambda e: any(x.get("kind") == "approval" for x in e))
        ask = next(e for e in evs if e.get("kind") == "approval")
        a.call(
            "POST",
            f"/v1/claude/sessions/{sid}/decision",
            json={"request_id": ask["request_id"], "allow": False},
        )
        a.wait(sid, _is_result)
        out = a.tool(a.secret(sid), "delete_path", {"path": target}).json()
        assert out["ok"] is False and os.path.exists(target)


@posix_only
class TestShutdown:
    def test_server_shutdown_stops_chats_and_deletes_private_files(
        self, home, fake_jarvis, tmp_path
    ):
        app = _app()
        cr.install_cleanup(app)
        a = JApi(app)
        sid = a.session(home)
        a.call(
            "POST",
            f"/v1/claude/sessions/{sid}/message",
            json={"text": "tools: mcp__jarvis__open_repo"},
        )
        a.wait(sid, _is_result)
        argv = json.loads(fake_jarvis.read_text().splitlines()[0])["argv"]
        cfg_path = argv[argv.index("--mcp-config") + 1]
        session = app.state.claude_manager.sessions[sid]
        pid = session.proc.pid
        assert os.path.exists(cfg_path)
        a.client.__exit__(None, None, None)  # the server shuts down
        assert not os.path.exists(cfg_path)
        with pytest.raises(ProcessLookupError):
            os.kill(pid, 0)
