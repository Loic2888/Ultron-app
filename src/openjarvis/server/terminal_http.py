"""Browser terminals over plain HTTP (no WebSocket).

The WebSocket terminal (``terminal_routes``) cannot be opened from some
browsers: the relay between Windows and WSL blocks it. The Claude Code chats
already work with ordinary HTTP requests, so the terminal now does the same:

* ``POST   /v1/terminal/sessions``              start a shell, returns its id
* ``GET    /v1/terminal/sessions/{id}/output``  never-ending stream of JSON lines
  ``{"seq":N,"data":"..."}`` and finally ``{"exit":CODE}``; ``?after=N`` resumes
* ``POST   /v1/terminal/sessions/{id}/input``   keys typed by the user
* ``POST   /v1/terminal/sessions/{id}/resize``  new size in columns and rows
* ``DELETE /v1/terminal/sessions/{id}``         stop the shell

Same gates as the file routes (loopback bind and Host, known Origin, per-process
token in ``X-Jarvis-Token``). The shell's output is kept in memory (2 MB at
most), so a page reload can re-attach to a running shell.
"""

from __future__ import annotations

import asyncio
import codecs
import itertools
import json
import os
import threading
import time
import uuid
from typing import Any, Optional

try:
    from fastapi import APIRouter, HTTPException, Request
    from fastapi.responses import StreamingResponse
    from pydantic import BaseModel
except ImportError:  # pragma: no cover - fastapi is a server extra
    raise ImportError("fastapi is required for terminal routes")

from openjarvis.server import journal
from openjarvis.server.terminal_routes import (
    MAX_INPUT_BYTES,
    PtySession,
    clamp_size,
    resolve_cwd,
)
from openjarvis.server.workspace_routes import guard

MAX_SHELLS = 8
MAX_BUFFER_CHARS = 2_000_000
KEEPALIVE_SECONDS = 15.0
ORPHAN_SECONDS = 1800.0  # nobody attached nor typing for this long: stop it
EXITED_GRACE_SECONDS = 120.0
REAP_EVERY_SECONDS = 60.0


class Shell:
    """One PTY with its output kept for the browser to read."""

    def __init__(self, pty: PtySession, loop: asyncio.AbstractEventLoop) -> None:
        self.id = uuid.uuid4().hex
        self.pty = pty
        self.loop = loop
        self.chunks: list[tuple[int, str]] = []
        self.first_seq = 0
        self.size = 0
        self._seq = itertools.count()
        self.cond = asyncio.Condition()
        self.exit_code: Optional[int] = None
        self.attached = 0
        self.last_seen = time.monotonic()
        self.closed = False
        self._decoder = codecs.getincrementaldecoder("utf-8")(errors="replace")
        self._reading = True
        loop.add_reader(pty.master_fd, self._on_readable)

    def touch(self) -> None:
        self.last_seen = time.monotonic()

    # -- reading the shell (runs in the event loop) ---------------------------

    def _on_readable(self) -> None:
        try:
            raw = os.read(self.pty.master_fd, 65536)
        except OSError:
            raw = b""
        if not raw:
            self._stop_reading()
            self.loop.create_task(self._finish())
            return
        text = self._decoder.decode(raw)
        if text:
            self.loop.create_task(self._push(text))

    def _stop_reading(self) -> None:
        if self._reading:
            self._reading = False
            try:
                self.loop.remove_reader(self.pty.master_fd)
            except (ValueError, OSError):
                pass

    async def _push(self, text: str) -> None:
        async with self.cond:
            self.chunks.append((next(self._seq), text))
            self.size += len(text)
            while self.size > MAX_BUFFER_CHARS and len(self.chunks) > 1:
                _, old = self.chunks.pop(0)
                self.size -= len(old)
                self.first_seq += 1
            self.cond.notify_all()

    async def _finish(self) -> None:
        tail = self._decoder.decode(b"", final=True)
        if tail:
            await self._push(tail)
        code = await asyncio.to_thread(self.pty.proc.wait)
        async with self.cond:
            self.exit_code = code
            self.cond.notify_all()

    # -- ending ---------------------------------------------------------------

    def close(self) -> None:
        if self.closed:
            return
        self.closed = True
        self._stop_reading()
        # close() may wait a few seconds for the shell to die: never in the loop.
        threading.Thread(
            target=self.pty.close, name="terminal-close", daemon=True
        ).start()
        self.loop.create_task(self._wake())

    async def _wake(self) -> None:
        async with self.cond:
            self.cond.notify_all()


class ShellManager:
    def __init__(self) -> None:
        self.shells: dict[str, Shell] = {}
        self.reaper: Optional[asyncio.Task[None]] = None

    def ensure_reaper(self) -> None:
        if self.reaper is None or self.reaper.done():
            self.reaper = asyncio.get_running_loop().create_task(self._reap())

    async def _reap(self) -> None:
        while True:
            await asyncio.sleep(REAP_EVERY_SECONDS)
            now = time.monotonic()
            for sid, shell in list(self.shells.items()):
                idle = now - shell.last_seen
                gone = shell.exit_code is not None and idle > EXITED_GRACE_SECONDS
                if shell.attached == 0 and (gone or idle > ORPHAN_SECONDS):
                    self.drop(sid)

    def drop(self, sid: str) -> None:
        shell = self.shells.pop(sid, None)
        if shell is not None:
            shell.close()

    def make_room(self) -> bool:
        """Free a slot by stopping the oldest shell nobody is watching."""
        if len(self.shells) < MAX_SHELLS:
            return True
        free = [s for s in self.shells.values() if s.attached == 0]
        if not free:
            return False
        self.drop(min(free, key=lambda s: s.last_seen).id)
        return True

    def close_all(self) -> None:
        for sid in list(self.shells):
            self.drop(sid)
        if self.reaper is not None:
            self.reaper.cancel()


def _manager(app: Any) -> ShellManager:
    mgr = getattr(app.state, "shell_manager", None)
    if mgr is None:
        mgr = ShellManager()
        app.state.shell_manager = mgr
    return mgr


def install_terminal_cleanup(app: Any) -> None:
    """Stop every shell when the server shuts down."""

    @app.on_event("shutdown")
    async def _stop_shells() -> None:
        mgr = getattr(app.state, "shell_manager", None)
        if mgr is not None:
            mgr.close_all()


class OpenBody(BaseModel):
    cwd: Optional[str] = None
    cols: Optional[int] = None
    rows: Optional[int] = None


class InputBody(BaseModel):
    data: str


class ResizeBody(BaseModel):
    cols: int
    rows: int


def create_terminal_http_router() -> APIRouter:
    router = APIRouter(tags=["terminal"])

    def get(request: Request, sid: str) -> Shell:
        shell = _manager(request.app).shells.get(sid)
        if shell is None or shell.closed:
            raise HTTPException(status_code=404, detail="No such terminal")
        shell.touch()
        return shell

    @router.post("/v1/terminal/sessions")
    async def open_shell(request: Request, body: OpenBody) -> dict[str, Any]:
        guard(request)
        mgr = _manager(request.app)
        try:
            cwd = resolve_cwd(body.cwd)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc))
        if not mgr.make_room():
            raise HTTPException(status_code=429, detail="Too many open terminals")
        try:
            pty = PtySession(cwd, clamp_size(body.cols, 80), clamp_size(body.rows, 24))
        except OSError as exc:
            raise HTTPException(status_code=500, detail=f"Cannot start a shell: {exc}")
        shell = Shell(pty, asyncio.get_running_loop())
        mgr.shells[shell.id] = shell
        mgr.ensure_reaper()
        journal.log("terminal", f"Terminal ouvert dans {cwd}", repo=str(cwd))
        return {"id": shell.id, "pid": pty.proc.pid}

    @router.get("/v1/terminal/sessions/{sid}/output")
    async def output(
        request: Request, sid: str, after: int = -1, follow: bool = True
    ) -> StreamingResponse:
        guard(request)
        shell = get(request, sid)

        async def stream():
            shell.attached += 1
            cursor = after + 1
            try:
                while True:
                    shell.touch()
                    async with shell.cond:
                        start = max(cursor, shell.first_seq)
                        batch = [c for c in shell.chunks if c[0] >= start]
                        if not batch:
                            if shell.exit_code is not None:
                                yield (
                                    json.dumps({"exit": shell.exit_code}).encode()
                                    + b"\n"
                                )
                                return
                            if shell.closed or not follow:
                                return
                            try:
                                await asyncio.wait_for(
                                    shell.cond.wait(), KEEPALIVE_SECONDS
                                )
                            except asyncio.TimeoutError:
                                pass
                            batch = [
                                c
                                for c in shell.chunks
                                if c[0] >= max(cursor, shell.first_seq)
                            ]
                    if await request.is_disconnected():
                        return
                    if not batch:
                        yield b'{"keepalive":true}\n'
                        continue
                    cursor = batch[-1][0] + 1
                    yield b"".join(
                        json.dumps(
                            {"seq": n, "data": d}, separators=(",", ":")
                        ).encode()
                        + b"\n"
                        for n, d in batch
                    )
            finally:
                shell.attached -= 1
                shell.touch()

        return StreamingResponse(
            stream(),
            media_type="application/x-ndjson",
            headers={"Cache-Control": "no-store", "X-Accel-Buffering": "no"},
        )

    @router.post("/v1/terminal/sessions/{sid}/input")
    async def send_input(request: Request, sid: str, body: InputBody) -> dict[str, Any]:
        guard(request)
        shell = get(request, sid)
        if len(body.data) > MAX_INPUT_BYTES:
            raise HTTPException(status_code=413, detail="Input too large")
        if shell.exit_code is not None:
            raise HTTPException(status_code=409, detail="The shell has ended")
        await shell.pty.write(body.data)
        return {"ok": True}

    @router.post("/v1/terminal/sessions/{sid}/resize")
    async def resize(request: Request, sid: str, body: ResizeBody) -> dict[str, Any]:
        guard(request)
        shell = get(request, sid)
        shell.pty.resize(clamp_size(body.cols, 80), clamp_size(body.rows, 24))
        return {"ok": True}

    @router.delete("/v1/terminal/sessions/{sid}")
    async def close_shell(request: Request, sid: str) -> dict[str, Any]:
        guard(request)
        get(request, sid)
        _manager(request.app).drop(sid)
        return {"ok": True}

    return router
