"""Terminal endpoints: the security gates matter more than the happy path."""

from __future__ import annotations

import os
import threading
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from openjarvis.server import terminal_routes as tr

posix_only = pytest.mark.skipif(os.name != "posix", reason="PTY needs POSIX")

FRONTEND = "http://localhost:5173"
LOCAL_HOST = "localhost:8010"


def _ws_headers(**over):
    """Starlette's WebSocket test client always sends Host: testserver."""
    return {"origin": FRONTEND, "host": LOCAL_HOST, **over}


# ---------------------------------------------------------------------------
# Pure helpers
# ---------------------------------------------------------------------------


class TestLoopbackChecks:
    @pytest.mark.parametrize(
        "host", ["localhost", "127.0.0.1", "::1", "[::1]", "127.5.5.5", "LOCALHOST"]
    )
    def test_loopback_names(self, host):
        assert tr.is_loopback_address(host)

    @pytest.mark.parametrize(
        "host", ["", None, "0.0.0.0", "192.168.1.5", "evil.example", "10.0.0.1"]
    )
    def test_non_loopback_names(self, host):
        assert not tr.is_loopback_address(host)

    @pytest.mark.parametrize(
        "header",
        ["localhost:8010", "127.0.0.1:8010", "[::1]:8010", "localhost", "[::1]"],
    )
    def test_host_header_ok(self, header):
        assert tr.host_header_is_loopback(header)

    @pytest.mark.parametrize(
        "header",
        [None, "", "evil.example:8010", "localhost.evil.example", "0.0.0.0:8010"],
    )
    def test_host_header_rejected(self, header):
        assert not tr.host_header_is_loopback(header)


class TestOriginAllowed:
    allowed = [FRONTEND, "http://127.0.0.1:5173"]

    def test_missing_origin_is_a_non_browser_client(self):
        assert tr.origin_allowed(None, "localhost:8010", self.allowed)

    def test_known_frontend(self):
        assert tr.origin_allowed(FRONTEND, "localhost:8010", self.allowed)

    def test_same_origin(self):
        assert tr.origin_allowed(
            "http://localhost:8010", "localhost:8010", self.allowed
        )

    def test_hostile_site(self):
        assert not tr.origin_allowed(
            "https://evil.example", "localhost:8010", self.allowed
        )

    def test_hostile_site_cannot_borrow_the_host_header(self):
        assert not tr.origin_allowed("https://evil.example", None, self.allowed)


class TestTerminalEnv:
    def test_strips_secrets_and_provider_variables(self):
        env = tr.terminal_env(
            {
                "PATH": "/usr/bin",
                "HOME": "/home/x",
                "ANTHROPIC_API_KEY": "a",
                "ANTHROPIC_BASE_URL": "https://openrouter.ai/api",
                "ANTHROPIC_AUTH_TOKEN": "b",
                "OPENROUTER_API_KEY": "c",
                "OPENAI_API_KEY": "d",
                "OPENJARVIS_API_KEY": "e",
            }
        )
        assert env["PATH"] == "/usr/bin" and env["HOME"] == "/home/x"
        assert not any(k.startswith(("ANTHROPIC_", "OPENJARVIS_")) for k in env)
        assert "OPENROUTER_API_KEY" not in env and "OPENAI_API_KEY" not in env
        assert env["TERM"] == "xterm-256color"


class TestResolveCwd:
    def test_default_is_home(self, tmp_path):
        assert tr.resolve_cwd(None, home=tmp_path) == tmp_path.resolve()

    def test_subdirectory(self, tmp_path):
        (tmp_path / "repo").mkdir()
        assert tr.resolve_cwd("repo", home=tmp_path) == (tmp_path / "repo").resolve()

    def test_outside_home_refused(self, tmp_path):
        home = tmp_path / "home"
        home.mkdir()
        with pytest.raises(ValueError):
            tr.resolve_cwd(str(tmp_path), home=home)

    def test_dotdot_escape_refused(self, tmp_path):
        home = tmp_path / "home"
        home.mkdir()
        with pytest.raises(ValueError):
            tr.resolve_cwd("../", home=home)

    def test_symlink_escape_refused(self, tmp_path):
        home = tmp_path / "home"
        home.mkdir()
        (home / "link").symlink_to(tmp_path)
        with pytest.raises(ValueError):
            tr.resolve_cwd("link", home=home)

    def test_missing_or_file_refused(self, tmp_path):
        (tmp_path / "f.txt").write_text("x")
        with pytest.raises(ValueError):
            tr.resolve_cwd("nope", home=tmp_path)
        with pytest.raises(ValueError):
            tr.resolve_cwd("f.txt", home=tmp_path)


class TestClampSize:
    def test_clamps_and_defaults(self):
        assert tr.clamp_size(120, 80) == 120
        assert tr.clamp_size(0, 80) == 1
        assert tr.clamp_size(10_000, 80) == 500
        assert tr.clamp_size("x", 80) == 80
        assert tr.clamp_size(True, 80) == 80
        assert tr.clamp_size(None, 24) == 24


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------


def _client(bind_host: str | None = "127.0.0.1", *, base_url="http://localhost:8010"):
    app = FastAPI()
    app.include_router(tr.create_terminal_router())
    app.state.allowed_origins = [FRONTEND]
    app.state.api_key = ""
    if bind_host is not None:
        app.state.bind_host = bind_host
    return TestClient(app, base_url=base_url)


@posix_only
class TestTokenEndpoint:
    def test_issues_a_token_to_the_frontend(self):
        c = _client()
        r = c.get("/v1/terminal/token", headers=_ws_headers())
        assert r.status_code == 200
        assert len(r.json()["token"]) >= 32

    def test_token_is_stable_within_a_process(self):
        c = _client()
        a = c.get("/v1/terminal/token").json()["token"]
        b = c.get("/v1/terminal/token").json()["token"]
        assert a == b

    def test_refused_when_server_is_not_local(self):
        for host in ("0.0.0.0", "192.168.1.10", None):
            r = _client(host).get("/v1/terminal/token")
            assert r.status_code == 403, host

    def test_refused_on_dns_rebinding_host(self):
        c = _client(base_url="http://evil.example:8010")
        assert c.get("/v1/terminal/token").status_code == 403

    def test_refused_for_hostile_origin(self):
        r = _client().get(
            "/v1/terminal/token", headers=_ws_headers(origin="https://evil.example")
        )
        assert r.status_code == 403


def _token(c: TestClient) -> str:
    return c.get("/v1/terminal/token").json()["token"]


def _open(ws, token, **extra):
    ws.send_json({"type": "open", "token": token, "cols": 100, "rows": 30, **extra})


def _drain(ws, until, seconds=20.0):
    """Collect frames until ``until(frames)`` holds, failing instead of hanging."""
    frames: list[dict] = []
    done = threading.Event()

    def run():
        try:
            while not until(frames):
                frames.append(ws.receive_json())
        except Exception:  # noqa: BLE001 - disconnects end the loop
            pass
        finally:
            done.set()

    threading.Thread(target=run, daemon=True).start()
    if not done.wait(seconds):
        pytest.fail(f"timed out waiting for terminal output; got {frames[-3:]}")
    return frames


def _text(frames):
    return "".join(f.get("data", "") for f in frames if f["type"] == "output")


@posix_only
class TestWebSocketGates:
    def test_hostile_origin_never_connects(self):
        c = _client()
        token = _token(c)
        with pytest.raises(WebSocketDisconnect):
            with c.websocket_connect(
                "/v1/terminal/ws", headers=_ws_headers(origin="https://evil.example")
            ) as ws:
                _open(ws, token)
                ws.receive_json()

    def test_not_local_never_connects(self):
        c = _client("0.0.0.0")
        with pytest.raises(WebSocketDisconnect):
            with c.websocket_connect("/v1/terminal/ws", headers=_ws_headers()) as ws:
                ws.receive_json()

    def test_rebinding_host_never_connects(self):
        c = _client()
        with pytest.raises(WebSocketDisconnect):
            with c.websocket_connect(
                "/v1/terminal/ws", headers=_ws_headers(host="evil.example:8010")
            ) as ws:
                ws.receive_json()

    def test_wrong_token_is_closed(self):
        c = _client()
        _token(c)
        with c.websocket_connect("/v1/terminal/ws", headers=_ws_headers()) as ws:
            _open(ws, "not-the-token")
            with pytest.raises(WebSocketDisconnect):
                ws.receive_json()

    def test_first_message_must_be_open(self):
        c = _client()
        token = _token(c)
        with c.websocket_connect("/v1/terminal/ws", headers=_ws_headers()) as ws:
            ws.send_json({"type": "input", "token": token, "data": "id\n"})
            with pytest.raises(WebSocketDisconnect):
                ws.receive_json()

    def test_cwd_outside_home_is_refused(self, tmp_path, monkeypatch):
        home = tmp_path / "home"
        home.mkdir()
        monkeypatch.setenv("HOME", str(home))
        c = _client()
        token = _token(c)
        with c.websocket_connect("/v1/terminal/ws", headers=_ws_headers()) as ws:
            _open(ws, token, cwd="/")
            msg = ws.receive_json()
            assert msg["type"] == "error"


@posix_only
class TestWebSocketShell:
    def test_runs_a_command_and_reports_exit(self, tmp_path, monkeypatch):
        monkeypatch.setenv("HOME", str(tmp_path))
        monkeypatch.setenv(
            "SHELL", "/bin/bash" if os.path.exists("/bin/bash") else "/bin/sh"
        )
        monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-must-not-leak")
        c = _client()
        token = _token(c)
        with c.websocket_connect("/v1/terminal/ws", headers=_ws_headers()) as ws:
            _open(ws, token)
            ready = ws.receive_json()
            while ready["type"] != "ready":
                ready = ws.receive_json()
            ws.send_json({"type": "resize", "cols": 120, "rows": 40})
            ws.send_json(
                {
                    "type": "input",
                    "data": "echo pty_$((6*7)) key=[${ANTHROPIC_API_KEY}]; pwd\n",
                }
            )
            frames = _drain(
                ws, lambda f: "pty_42" in _text(f) and str(tmp_path) in _text(f)
            )
            text = _text(frames)
            assert "pty_42" in text
            assert "sk-must-not-leak" not in text
            assert "key=[]" in text
            ws.send_json({"type": "input", "data": "exit 3\n"})
            frames = _drain(ws, lambda f: any(x["type"] == "exit" for x in f))
            assert [x for x in frames if x["type"] == "exit"][0]["code"] == 3

    def test_session_cap(self, tmp_path, monkeypatch):
        monkeypatch.setenv("HOME", str(tmp_path))
        monkeypatch.setattr(tr, "MAX_SESSIONS", 1)
        c = _client()
        token = _token(c)
        with c.websocket_connect("/v1/terminal/ws", headers=_ws_headers()) as first:
            _open(first, token)
            while first.receive_json()["type"] != "ready":
                pass
            with c.websocket_connect(
                "/v1/terminal/ws", headers=_ws_headers()
            ) as second:
                _open(second, token)
                msg = second.receive_json()
                assert msg["type"] == "error"
        # the slot is released once the server has cleaned the session up
        for _ in range(100):
            if c.app.state.terminal_sessions == 0:
                break
            threading.Event().wait(0.05)
        assert c.app.state.terminal_sessions == 0

    def test_shell_is_killed_when_the_socket_closes(self, tmp_path, monkeypatch):
        monkeypatch.setenv("HOME", str(tmp_path))
        c = _client()
        token = _token(c)
        with c.websocket_connect("/v1/terminal/ws", headers=_ws_headers()) as ws:
            _open(ws, token)
            pid = None
            while pid is None:
                msg = ws.receive_json()
                if msg["type"] == "ready":
                    pid = msg["pid"]
        for _ in range(50):
            try:
                os.kill(pid, 0)
            except ProcessLookupError:
                break
            threading.Event().wait(0.1)
            try:  # reap if it is our zombie child
                os.waitpid(pid, os.WNOHANG)
            except ChildProcessError:
                pass
        else:
            pytest.fail("shell process survived the socket closing")


def test_home_default_uses_path_home(tmp_path, monkeypatch):
    monkeypatch.setenv("HOME", str(tmp_path))
    assert tr.resolve_cwd(None) == Path(tmp_path).resolve()
