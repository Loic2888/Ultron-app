"""Browser terminals: a real shell on a PTY, exposed over a WebSocket.

Giving a web page a shell is dangerous, so every connection must pass ALL of:

* the server is bound to a loopback address (``app.state.bind_host``);
* the ``Host`` header names a loopback host (blocks DNS rebinding);
* the ``Origin`` header, when present, is a known frontend origin or the
  server's own origin (WebSockets are not covered by CORS, so this is the only
  barrier against a hostile website in the user's browser);
* a per-process secret token, fetched from ``GET /v1/terminal/token`` (whose
  response other origins cannot read, thanks to CORS) and sent in the first
  WebSocket message, never in the URL;
* the usual API key, when one is configured.

Wire protocol (JSON text frames):

client -> server  ``{"type":"open","token":..,"cols":80,"rows":24,"cwd":".."}``
                  (first message), then ``{"type":"input","data":".."}`` and
                  ``{"type":"resize","cols":..,"rows":..}``
server -> client  ``{"type":"ready","pid":..}``, ``{"type":"output","data":".."}``,
                  ``{"type":"exit","code":..}``, ``{"type":"error","message":".."}``
"""

from __future__ import annotations

import asyncio
import codecs
import hmac
import ipaddress
import json
import logging
import os
import secrets
import signal
import subprocess
import threading
from pathlib import Path
from typing import Any, Mapping, Optional

try:
    from fastapi import (
        APIRouter,
        HTTPException,
        Request,
        WebSocket,
        WebSocketDisconnect,
    )
except ImportError:  # pragma: no cover - fastapi is a server extra
    raise ImportError("fastapi is required for terminal routes")

logger = logging.getLogger(__name__)

MAX_SESSIONS = 8
MAX_INPUT_BYTES = 256 * 1024
AUTH_TIMEOUT_SECONDS = 5.0
_LOOPBACK_NAMES = {"localhost", "127.0.0.1", "::1"}

# Secrets that must not leak into a shell started from the server's
# environment. ANTHROPIC_* is stripped on purpose too: the subscription-based
# ``claude`` started in a terminal must not silently fall back to the
# OpenRouter variables the launcher exports.
_SECRET_ENV_EXACT = {
    "OPENROUTER_API_KEY",
    "OPENAI_API_KEY",
    "GOOGLE_API_KEY",
    "GEMINI_API_KEY",
    "TAVILY_API_KEY",
    "TELEGRAM_BOT_TOKEN",
}
_SECRET_ENV_PREFIXES = ("ANTHROPIC_", "OPENJARVIS_", "OPENULTRON_")


# --------------------------------------------------------------------------
# Pure helpers (unit-tested)
# --------------------------------------------------------------------------


def is_loopback_address(host: Optional[str]) -> bool:
    """True for ``localhost`` and loopback IP literals (IPv4 or IPv6)."""
    if not host:
        return False
    name = host.strip().strip("[]").lower()
    if name in _LOOPBACK_NAMES:
        return True
    try:
        return ipaddress.ip_address(name).is_loopback
    except ValueError:
        return False


def host_header_is_loopback(host_header: Optional[str]) -> bool:
    """Check a ``Host`` header such as ``localhost:8010`` or ``[::1]:8010``."""
    if not host_header:
        return False
    value = host_header.strip()
    if value.startswith("["):
        end = value.find("]")
        return end != -1 and is_loopback_address(value[: end + 1])
    return is_loopback_address(value.rsplit(":", 1)[0] if ":" in value else value)


def origin_allowed(
    origin: Optional[str],
    host_header: Optional[str],
    allowed_origins: list[str],
) -> bool:
    """Accept a missing Origin (non-browser client) or a known/same origin."""
    if origin is None:
        return True
    if origin in allowed_origins:
        return True
    # Same origin: the UI is served by this very server.
    return bool(host_header) and origin in (
        f"http://{host_header}",
        f"https://{host_header}",
    )


def terminal_env(environ: Mapping[str, str]) -> dict[str, str]:
    """Environment for a spawned shell, without server-side secrets."""
    env = {
        k: v
        for k, v in environ.items()
        if k not in _SECRET_ENV_EXACT and not k.startswith(_SECRET_ENV_PREFIXES)
    }
    env["TERM"] = "xterm-256color"
    env["COLORTERM"] = "truecolor"
    return env


def resolve_cwd(requested: Optional[str], home: Optional[Path] = None) -> Path:
    """Working directory for a new shell: an existing directory under $HOME.

    Raises ``ValueError`` for anything else (outside home, missing, a file).
    """
    base = (home or Path.home()).resolve()
    if not requested:
        return base
    path = Path(requested).expanduser()
    if not path.is_absolute():
        path = base / path
    resolved = path.resolve()
    if not resolved.is_dir():
        raise ValueError("Working directory does not exist")
    if resolved != base and base not in resolved.parents:
        raise ValueError("Working directory must be inside your home directory")
    return resolved


def pick_shell() -> str:
    candidate = os.environ.get("SHELL", "")
    if candidate and os.path.isabs(candidate) and os.access(candidate, os.X_OK):
        return candidate
    return "/bin/bash" if os.access("/bin/bash", os.X_OK) else "/bin/sh"


def clamp_size(value: Any, default: int) -> int:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return default
    return max(1, min(500, int(value)))


def get_terminal_token(app: Any) -> str:
    """Per-process secret, created on first use."""
    with _TOKEN_LOCK:
        token = getattr(app.state, "terminal_token", None)
        if not token:
            token = secrets.token_urlsafe(32)
            app.state.terminal_token = token
        return token


_TOKEN_LOCK = threading.Lock()


def terminal_enabled(app: Any) -> bool:
    """Terminals only run on POSIX and when the server is bound to loopback."""
    if os.name != "posix":
        return False
    return is_loopback_address(getattr(app.state, "bind_host", None))


# --------------------------------------------------------------------------
# PTY session
# --------------------------------------------------------------------------


class PtySession:
    """One shell attached to a pseudo-terminal."""

    def __init__(self, cwd: Path, cols: int, rows: int) -> None:
        import fcntl
        import pty
        import termios

        self._fcntl = fcntl
        self._termios = termios
        master, slave = pty.openpty()
        self.master_fd = master
        self._set_size(cols, rows)

        def _become_session_leader() -> None:
            # Runs in the child after stdio is wired to the slave end:
            # make the PTY its controlling terminal so job control works.
            fcntl.ioctl(0, termios.TIOCSCTTY, 0)

        try:
            self.proc = subprocess.Popen(
                [pick_shell(), "-l"],
                stdin=slave,
                stdout=slave,
                stderr=slave,
                cwd=str(cwd),
                env=terminal_env(os.environ),
                start_new_session=True,
                preexec_fn=_become_session_leader,
                close_fds=True,
            )
        except Exception:
            os.close(master)
            raise
        finally:
            os.close(slave)

    def _set_size(self, cols: int, rows: int) -> None:
        import struct

        self._fcntl.ioctl(
            self.master_fd,
            self._termios.TIOCSWINSZ,
            struct.pack("HHHH", rows, cols, 0, 0),
        )

    def resize(self, cols: int, rows: int) -> None:
        try:
            self._set_size(cols, rows)
        except OSError:
            pass

    @staticmethod
    def _write_all(fd: int, data: bytes) -> None:
        view = memoryview(data)
        while view:
            written = os.write(fd, view)
            view = view[written:]

    async def write(self, data: str) -> None:
        payload = data.encode("utf-8", errors="replace")
        await asyncio.to_thread(self._write_all, self.master_fd, payload)

    def close(self) -> None:
        """Hang up the shell's process group, then force-kill if needed."""
        try:
            pgid = os.getpgid(self.proc.pid)
        except (ProcessLookupError, PermissionError):
            pgid = None
        if self.proc.poll() is None and pgid is not None:
            try:
                os.killpg(pgid, signal.SIGHUP)
            except (ProcessLookupError, PermissionError):
                pass
            try:
                self.proc.wait(timeout=1.0)
            except subprocess.TimeoutExpired:
                try:
                    os.killpg(pgid, signal.SIGKILL)
                except (ProcessLookupError, PermissionError):
                    pass
                try:
                    self.proc.wait(timeout=1.0)
                except subprocess.TimeoutExpired:
                    pass
        try:
            os.close(self.master_fd)
        except OSError:
            pass


# --------------------------------------------------------------------------
# Routes
# --------------------------------------------------------------------------


def _forbid(reason: str) -> HTTPException:
    return HTTPException(status_code=403, detail=reason)


def create_terminal_router() -> APIRouter:
    router = APIRouter(tags=["terminal"])

    @router.get("/v1/terminal/token")
    async def terminal_token(request: Request) -> dict[str, Any]:
        app = request.app
        if not terminal_enabled(app):
            raise _forbid("Terminals are only available when the server is local")
        if not host_header_is_loopback(request.headers.get("host")):
            raise _forbid("Unexpected Host header")
        origin = request.headers.get("origin")
        allowed = list(getattr(app.state, "allowed_origins", []) or [])
        if not origin_allowed(origin, request.headers.get("host"), allowed):
            raise _forbid("Origin not allowed")
        return {"token": get_terminal_token(app), "max_sessions": MAX_SESSIONS}

    @router.websocket("/v1/terminal/ws")
    async def terminal_ws(websocket: WebSocket) -> None:
        app = websocket.app
        # Handshake checks happen before accept(): a refused socket never opens.
        allowed = list(getattr(app.state, "allowed_origins", []) or [])
        if (
            not terminal_enabled(app)
            or not host_header_is_loopback(websocket.headers.get("host"))
            or not origin_allowed(
                websocket.headers.get("origin"),
                websocket.headers.get("host"),
                allowed,
            )
        ):
            await websocket.close(code=1008)
            return

        from openjarvis.server.auth_middleware import authenticate_websocket

        authorized, subprotocol = authenticate_websocket(
            websocket, getattr(app.state, "api_key", "")
        )
        if not authorized:
            await websocket.close(code=1008)
            return
        await websocket.accept(subprotocol=subprotocol)

        session: Optional[PtySession] = None
        counted = False
        loop = asyncio.get_running_loop()
        queue: asyncio.Queue[Optional[bytes]] = asyncio.Queue(maxsize=64)
        reading = False

        def on_readable() -> None:
            nonlocal reading
            try:
                chunk = os.read(session.master_fd, 65536)  # type: ignore[union-attr]
            except OSError:
                chunk = b""
            if not chunk:
                loop.remove_reader(session.master_fd)  # type: ignore[union-attr]
                reading = False
                queue.put_nowait(None)
                return
            queue.put_nowait(chunk)
            if queue.full():  # backpressure: pause until the client catches up
                loop.remove_reader(session.master_fd)  # type: ignore[union-attr]
                reading = False

        async def pump_output() -> None:
            nonlocal reading
            decoder = codecs.getincrementaldecoder("utf-8")(errors="replace")
            while True:
                chunk = await queue.get()
                if chunk is None:
                    tail = decoder.decode(b"", final=True)
                    if tail:
                        await websocket.send_json({"type": "output", "data": tail})
                    code = await asyncio.to_thread(session.proc.wait)  # type: ignore[union-attr]
                    await websocket.send_json({"type": "exit", "code": code})
                    return
                text = decoder.decode(chunk)
                if text:
                    await websocket.send_json({"type": "output", "data": text})
                if not reading and queue.qsize() < 32:
                    loop.add_reader(session.master_fd, on_readable)  # type: ignore[union-attr]
                    reading = True

        pump: Optional[asyncio.Task[None]] = None
        try:
            # --- first message: open + token ---
            try:
                raw = await asyncio.wait_for(
                    websocket.receive_text(), timeout=AUTH_TIMEOUT_SECONDS
                )
                first = json.loads(raw)
            except (asyncio.TimeoutError, ValueError):
                await websocket.close(code=1008)
                return
            token = first.get("token") if isinstance(first, dict) else None
            expected = get_terminal_token(app)
            if (
                not isinstance(first, dict)
                or first.get("type") != "open"
                or not isinstance(token, str)
                or not hmac.compare_digest(token.encode(), expected.encode())
            ):
                await websocket.close(code=1008)
                return

            with _SESSIONS_LOCK:
                active = getattr(app.state, "terminal_sessions", 0)
                if active >= MAX_SESSIONS:
                    over_limit = True
                else:
                    app.state.terminal_sessions = active + 1
                    counted = True
                    over_limit = False
            if over_limit:
                await websocket.send_json(
                    {"type": "error", "message": "Too many open terminals"}
                )
                await websocket.close(code=1008)
                return

            try:
                cwd = resolve_cwd(first.get("cwd"))
            except ValueError as exc:
                await websocket.send_json({"type": "error", "message": str(exc)})
                await websocket.close(code=1008)
                return

            session = PtySession(
                cwd,
                clamp_size(first.get("cols"), 80),
                clamp_size(first.get("rows"), 24),
            )
            loop.add_reader(session.master_fd, on_readable)
            reading = True
            await websocket.send_json({"type": "ready", "pid": session.proc.pid})
            pump = asyncio.create_task(pump_output())

            # --- main loop ---
            while True:
                message = await websocket.receive_text()
                try:
                    data = json.loads(message)
                except ValueError:
                    continue
                if not isinstance(data, dict):
                    continue
                kind = data.get("type")
                if kind == "input":
                    text = data.get("data")
                    if isinstance(text, str) and len(text) <= MAX_INPUT_BYTES:
                        await session.write(text)
                elif kind == "resize":
                    session.resize(
                        clamp_size(data.get("cols"), 80),
                        clamp_size(data.get("rows"), 24),
                    )
        except WebSocketDisconnect:
            pass
        except Exception:  # noqa: BLE001 - never crash the server on a terminal
            logger.exception("Terminal session failed")
        finally:
            # No ``await`` in here: the task may be cancelled (client gone,
            # server shutting down) and cleanup must still run to the end.
            if counted:
                with _SESSIONS_LOCK:
                    app.state.terminal_sessions = max(
                        0, getattr(app.state, "terminal_sessions", 1) - 1
                    )
            if pump is not None:
                pump.cancel()
            if session is not None:
                if reading:
                    loop.remove_reader(session.master_fd)
                # close() may wait up to a few seconds for the shell to die;
                # a daemon thread never blocks the loop and survives cancellation.
                threading.Thread(
                    target=session.close, name="terminal-close", daemon=True
                ).start()

    return router


_SESSIONS_LOCK = threading.Lock()
