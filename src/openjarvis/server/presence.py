"""Stop the server when the app window is closed (desktop icon only).

The page keeps one never-ending request open on ``GET /v1/app/presence`` for as
long as it is open (a window, an installed app or a tab: it makes no difference).
When the last one is gone for ``GRACE_SECONDS``, the server stops itself, so
"click the icon" starts it and "close the app" ends it.

This only happens for a server started by ``jarvis desktop`` (it sets
``JARVIS_STOP_WHEN_CLOSED``); a server you started yourself never stops by
itself. It also never stops:

* while a Claude Code chat is working or waiting for your answer: it stops after;
* when the phone bot is configured (the phone needs the server to stay up).

A server whose window never opened stops after ``FIRST_SECONDS``.
"""

from __future__ import annotations

import asyncio
import json
import os
import signal
import time
from typing import Any

try:
    from fastapi import APIRouter, Request
    from fastapi.responses import StreamingResponse
except ImportError:  # pragma: no cover - fastapi is a server extra
    raise ImportError("fastapi is required for presence routes")

from openjarvis.server import journal
from openjarvis.server.claude_routes import manager_of
from openjarvis.server.phone_bridge import PhoneConfig
from openjarvis.server.workspace_routes import guard

ENV_FLAG = "JARVIS_STOP_WHEN_CLOSED"
GRACE_SECONDS = 30.0  # a reload, or a PC waking up, reconnects well within this
FIRST_SECONDS = 180.0  # nobody ever opened the page
CHECK_EVERY = 2.0
KEEPALIVE_SECONDS = 5.0


class Presence:
    """Counts the open pages and decides when the server may stop."""

    def __init__(self, *, enabled: bool, stop=None, clock=time.monotonic) -> None:
        self.enabled = enabled
        self.clients = 0
        self.ever = False
        self.stopping = False
        self._stop = stop or (lambda: os.kill(os.getpid(), signal.SIGTERM))
        self._clock = clock
        self._started = clock()
        self._empty_since: float | None = clock()

    def connect(self) -> None:
        self.clients += 1
        self.ever = True
        self._empty_since = None

    def disconnect(self) -> None:
        self.clients = max(0, self.clients - 1)
        if self.clients == 0:
            self._empty_since = self._clock()

    def should_stop(self, *, busy: bool, phone: bool) -> bool:
        if not self.enabled or self.clients > 0 or busy or phone:
            return False
        waited = self._clock() - (self._empty_since or self._started)
        return waited >= (GRACE_SECONDS if self.ever else FIRST_SECONDS)

    def tick(self, *, busy: bool, phone: bool) -> bool:
        """Stop if it is time. Returns True when the stop was triggered."""
        if self.stopping or not self.should_stop(busy=busy, phone=phone):
            return False
        self.stopping = True
        journal.log("app", "Application fermée : arrêt du serveur.")
        self._stop()
        return True


def _busy(app: Any) -> bool:
    return any(
        not s.closed and (s.busy or s.pending)
        for s in manager_of(app).sessions.values()
    )


def install_presence(app: Any) -> Presence:
    presence = Presence(enabled=bool(os.environ.get(ENV_FLAG)))
    app.state.presence = presence
    tasks: list[asyncio.Task[None]] = []

    async def watch() -> None:
        while True:
            await asyncio.sleep(CHECK_EVERY)
            phone = PhoneConfig.from_env(os.environ) is not None
            presence.tick(busy=_busy(app), phone=phone)

    @app.on_event("startup")
    async def _start_watch() -> None:
        if presence.enabled:
            tasks.append(asyncio.create_task(watch()))

    @app.on_event("shutdown")
    async def _stop_watch() -> None:
        for task in tasks:
            task.cancel()

    return presence


def create_presence_router() -> APIRouter:
    router = APIRouter(tags=["app"])

    @router.get("/v1/app/presence")
    async def presence_stream(request: Request) -> StreamingResponse:
        """Stays open while a page is open; lines are only keepalives."""
        guard(request)
        presence: Presence = request.app.state.presence

        async def stream():
            presence.connect()
            try:
                yield json.dumps({"hello": True}).encode() + b"\n"
                while not await request.is_disconnected():
                    await asyncio.sleep(KEEPALIVE_SECONDS)
                    yield b'{"keepalive":true}\n'
            finally:
                presence.disconnect()

        return StreamingResponse(
            stream(),
            media_type="application/x-ndjson",
            headers={"Cache-Control": "no-store", "X-Accel-Buffering": "no"},
        )

    return router
