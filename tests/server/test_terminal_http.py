"""Terminals over plain HTTP: a real shell, driven by requests (no WebSocket)."""

from __future__ import annotations

import json
import os
import time

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from openjarvis.server import terminal_http as th
from openjarvis.server import terminal_routes as tr
from openjarvis.server import workspace_routes as wr

posix_only = pytest.mark.skipif(os.name != "posix", reason="POSIX only")

FRONTEND = "http://localhost:5173"
LOCAL_HOST = "localhost:8010"


@pytest.fixture()
def home(tmp_path, monkeypatch):
    monkeypatch.setenv("HOME", str(tmp_path))
    monkeypatch.setenv("SHELL", "/bin/sh")
    return tmp_path.resolve()


def _app(bind_host: str | None = "127.0.0.1") -> FastAPI:
    app = FastAPI()
    app.include_router(th.create_terminal_http_router())
    th.install_terminal_cleanup(app)
    app.state.allowed_origins = [FRONTEND]
    if bind_host is not None:
        app.state.bind_host = bind_host
    return app


class Api:
    def __init__(self, app: FastAPI):
        self.app = app
        self.client = TestClient(app, base_url="http://localhost:8010")
        self.client.__enter__()
        self.headers = {
            "origin": FRONTEND,
            "host": LOCAL_HOST,
            wr.TOKEN_HEADER: tr.get_terminal_token(app),
        }

    def call(self, method, path, **kw):
        return self.client.request(method, path, headers=self.headers, **kw)

    def open(self, **body):
        res = self.call("POST", "/v1/terminal/sessions", json=body)
        assert res.status_code == 200, res.text
        return res.json()["id"]

    def lines(self, sid, after=-1):
        res = self.call(
            "GET",
            f"/v1/terminal/sessions/{sid}/output",
            params={"after": after, "follow": "false"},
        )
        assert res.status_code == 200
        return [json.loads(x) for x in res.text.splitlines() if x.strip()]

    def text(self, sid):
        return "".join(x.get("data", "") for x in self.lines(sid))

    def wait_for(self, sid, needle, secs=10):
        end = time.time() + secs
        while time.time() < end:
            if needle in self.text(sid):
                return self.text(sid)
            time.sleep(0.05)
        raise AssertionError(f"{needle!r} never appeared in {self.text(sid)!r}")

    def type(self, sid, data):
        res = self.call(
            "POST", f"/v1/terminal/sessions/{sid}/input", json={"data": data}
        )
        assert res.status_code == 200, res.text

    def close(self):
        self.app.state.shell_manager.close_all() if hasattr(
            self.app.state, "shell_manager"
        ) else None
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


@posix_only
class TestGates:
    def test_every_route_needs_the_token(self, home, api):
        a = api()
        sid = a.open()
        bad = {**a.headers, wr.TOKEN_HEADER: "nope"}
        routes = [
            ("POST", "/v1/terminal/sessions", {}),
            ("GET", f"/v1/terminal/sessions/{sid}/output", None),
            ("POST", f"/v1/terminal/sessions/{sid}/input", {"data": "x"}),
            ("POST", f"/v1/terminal/sessions/{sid}/resize", {"cols": 80, "rows": 24}),
            ("DELETE", f"/v1/terminal/sessions/{sid}", None),
        ]
        for method, path, body in routes:
            res = a.client.request(method, path, headers=bad, json=body)
            assert res.status_code == 403, (method, path)

    def test_hostile_origin_and_host_refused(self, home, api):
        a = api()
        for headers in (
            {**a.headers, "origin": "http://evil.example"},
            {**a.headers, "host": "evil.example"},
        ):
            res = a.client.post("/v1/terminal/sessions", headers=headers, json={})
            assert res.status_code == 403

    def test_non_local_server_refused(self, home, api):
        a = api(_app(bind_host="0.0.0.0"))
        assert a.call("POST", "/v1/terminal/sessions", json={}).status_code == 403

    def test_cwd_outside_home_refused(self, home, api):
        a = api()
        res = a.call("POST", "/v1/terminal/sessions", json={"cwd": "/etc"})
        assert res.status_code == 400


@posix_only
class TestShell:
    def test_runs_commands_and_returns_output(self, home, api):
        a = api()
        sid = a.open(cwd=str(home), cols=100, rows=30)
        a.type(sid, "echo hello-$((20+22))\n")
        assert "hello-42" in a.wait_for(sid, "hello-42")

    def test_starts_in_the_requested_folder(self, home, api):
        (home / "repo").mkdir()
        a = api()
        sid = a.open(cwd=str(home / "repo"))
        a.type(sid, "pwd\n")
        assert str(home / "repo") in a.wait_for(sid, str(home / "repo"))

    def test_server_secrets_are_not_in_the_shell(self, home, api, monkeypatch):
        monkeypatch.setenv("ANTHROPIC_AUTH_TOKEN", "super-secret-value")
        a = api()
        sid = a.open()
        a.type(sid, "echo value=[$ANTHROPIC_AUTH_TOKEN]\n")
        assert "value=[]" in a.wait_for(sid, "value=[]")
        assert "super-secret-value" not in a.text(sid)

    def test_resume_after_a_given_sequence(self, home, api):
        a = api()
        sid = a.open()
        a.type(sid, "echo first-mark\n")
        a.wait_for(sid, "first-mark")
        seen = a.lines(sid)
        last = seen[-1]["seq"]
        a.type(sid, "echo second-mark\n")
        a.wait_for(sid, "second-mark")
        later = "".join(x["data"] for x in a.lines(sid, after=last))
        assert "second-mark" in later and "first-mark" not in later

    def test_exit_is_reported(self, home, api):
        a = api()
        sid = a.open()
        a.type(sid, "exit 3\n")
        end = time.time() + 10
        while time.time() < end:
            tail = a.lines(sid)[-1:]
            if tail and tail[0].get("exit") == 3:
                break
            time.sleep(0.05)
        else:
            raise AssertionError(a.lines(sid))
        assert (
            a.call(
                "POST", f"/v1/terminal/sessions/{sid}/input", json={"data": "x"}
            ).status_code
            == 409
        )

    def test_resize_and_close(self, home, api):
        a = api()
        sid = a.open()
        res = a.call(
            "POST",
            f"/v1/terminal/sessions/{sid}/resize",
            json={"cols": 120, "rows": 40},
        )
        assert res.status_code == 200
        assert a.call("DELETE", f"/v1/terminal/sessions/{sid}").status_code == 200
        assert a.call("GET", f"/v1/terminal/sessions/{sid}/output").status_code == 404

    def test_unknown_terminal(self, home, api):
        a = api()
        res = a.call("POST", "/v1/terminal/sessions/nope/input", json={"data": "x"})
        assert res.status_code == 404

    def test_oversized_input_refused(self, home, api):
        a = api()
        sid = a.open()
        big = "x" * (tr.MAX_INPUT_BYTES + 1)
        res = a.call("POST", f"/v1/terminal/sessions/{sid}/input", json={"data": big})
        assert res.status_code == 413


@posix_only
class TestLimits:
    def test_oldest_unwatched_shell_makes_room(self, home, api, monkeypatch):
        monkeypatch.setattr(th, "MAX_SHELLS", 2)
        a = api()
        first = a.open()
        time.sleep(0.01)
        second = a.open()
        third = a.open()
        mgr = a.app.state.shell_manager
        assert first not in mgr.shells
        assert second in mgr.shells and third in mgr.shells

    def test_buffer_is_capped(self, home, api, monkeypatch):
        monkeypatch.setattr(th, "MAX_BUFFER_CHARS", 2000)
        a = api()
        sid = a.open()
        loop = "i=0; while [ $i -lt 400 ]; do echo line-$i-padding; i=$((i+1)); done"
        a.type(sid, loop + "; echo done-mark\n")
        a.wait_for(sid, "line-399-padding")
        assert sum(len(x.get("data", "")) for x in a.lines(sid)) < 6000
