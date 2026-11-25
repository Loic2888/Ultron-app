"""One long request for everything the page follows live.

A browser keeps at most six connections open to one address. Chats, terminals
and the Jarvis screen commands each used to hold a never-ending stream, so a
few open tabs used all six and the next request (a message to another chat)
waited forever. The page now holds **one** request here instead:

``POST /v1/hub/poll`` — the page lists what it follows (``chat`` sessions,
``term`` shells, the ``cmd`` queue) with the last sequence number it has seen
for each. The call answers as soon as any of them has something new (or after
about 25 s with nothing), and the page asks again. The cursors stay on the page,
so a poll that is cancelled loses nothing.

Same gates as the other routes (loopback, ``Origin``, token).
"""

from __future__ import annotations

import asyncio
import time
from typing import Any, Callable, Literal, Optional

try:
    from fastapi import APIRouter, Request
    from pydantic import BaseModel, Field
except ImportError:  # pragma: no cover - fastapi is a server extra
    raise ImportError("fastapi is required for the hub route")

from openjarvis.server.workspace_routes import guard

MAX_WAIT_SECONDS = 25.0
SLICE_SECONDS = 5.0  # how often a waiting poll checks that the page has not left
MAX_SUBS = 64


class Sub(BaseModel):
    ch: Literal["chat", "term", "cmd"]
    id: str = ""
    after: int = -1


class PollBody(BaseModel):
    subs: list[Sub] = Field(default_factory=list, max_length=MAX_SUBS)
    wait: float = MAX_WAIT_SECONDS


class _Source:
    """What the hub needs from one thing it follows (all calls under ``cond``)."""

    def __init__(self, sub: Sub, cond: asyncio.Condition) -> None:
        self.sub = sub
        self.cond = cond

    def read(self) -> Optional[dict[str, Any]]:  # pragma: no cover - abstract
        raise NotImplementedError

    def enter(self) -> None:
        pass

    def leave(self) -> None:
        pass


class _ChatSource(_Source):
    def __init__(self, sub: Sub, session: Any) -> None:
        super().__init__(sub, session.cond)
        self.s = session

    def read(self) -> Optional[dict[str, Any]]:
        s = self.s
        start = max(self.sub.after + 1, s.first_seq)
        batch = s.events[start - s.first_seq :]
        if batch:
            return {"events": list(batch)}
        if s.closed:
            return {"ended": "closed"}
        return None


class _TermSource(_Source):
    def __init__(self, sub: Sub, shell: Any) -> None:
        super().__init__(sub, shell.cond)
        self.s = shell

    def read(self) -> Optional[dict[str, Any]]:
        s = self.s
        start = max(self.sub.after + 1, s.first_seq)
        batch = [{"seq": n, "data": d} for n, d in s.chunks if n >= start]
        if batch:
            return {"events": batch}
        if s.exit_code is not None:
            return {"events": [{"exit": s.exit_code}], "ended": "exit"}
        if s.closed:
            return {"ended": "closed"}
        return None

    def enter(self) -> None:
        self.s.attached += 1
        self.s.touch()

    def leave(self) -> None:
        self.s.attached -= 1
        self.s.touch()


class _CmdSource(_Source):
    def __init__(self, sub: Sub, bridge: Any) -> None:
        super().__init__(sub, bridge.cond)
        self.b = bridge

    def read(self) -> Optional[dict[str, Any]]:
        b = self.b
        start = max(self.sub.after + 1, b.first_seq)
        batch = b.commands[start - b.first_seq :]
        return {"events": list(batch)} if batch else None

    def enter(self) -> None:
        self.b.clients += 1

    def leave(self) -> None:
        self.b.clients -= 1
        self.b.last_screen = time.monotonic()


def build_sources(
    subs: list[Sub],
    *,
    find_chat: Callable[[str], Any],
    find_term: Callable[[str], Any],
    bridge: Any,
) -> tuple[list[_Source], list[dict[str, Any]]]:
    """Sources for the subscriptions, and the ones that no longer exist."""
    sources: list[_Source] = []
    missing: list[dict[str, Any]] = []
    for sub in subs:
        found: Any = None
        if sub.ch == "chat":
            found = find_chat(sub.id)
            if found is not None:
                sources.append(_ChatSource(sub, found))
        elif sub.ch == "term":
            found = find_term(sub.id)
            if found is not None:
                sources.append(_TermSource(sub, found))
        else:
            found = bridge
            sources.append(_CmdSource(sub, bridge))
        if found is None:
            missing.append({"ch": sub.ch, "id": sub.id, "ended": "missing"})
    return sources, missing


async def collect(sources: list[_Source]) -> list[dict[str, Any]]:
    """Everything new right now, without waiting."""
    out: list[dict[str, Any]] = []
    for src in sources:
        async with src.cond:
            result = src.read()
        if result is not None:
            out.append({"ch": src.sub.ch, "id": src.sub.id, **result})
    return out


async def _wait_for(src: _Source) -> None:
    async with src.cond:
        while src.read() is None:
            await src.cond.wait()


async def poll(
    sources: list[_Source],
    missing: list[dict[str, Any]],
    wait: float,
    *,
    disconnected: Callable[[], Any],
) -> dict[str, Any]:
    """Answer when anything is new, else after ``wait`` seconds."""
    for src in sources:
        src.enter()
    try:
        items = await collect(sources)
        deadline = time.monotonic() + max(0.0, min(wait, MAX_WAIT_SECONDS))
        while not items and not missing and sources:
            left = deadline - time.monotonic()
            if left <= 0:
                break
            tasks = [asyncio.ensure_future(_wait_for(s)) for s in sources]
            try:
                await asyncio.wait(
                    tasks,
                    timeout=min(left, SLICE_SECONDS),
                    return_when=asyncio.FIRST_COMPLETED,
                )
            finally:
                for t in tasks:
                    t.cancel()
                await asyncio.gather(*tasks, return_exceptions=True)
            items = await collect(sources)
            if not items and await disconnected():
                break
        return {"items": items, "ended": missing}
    finally:
        for src in sources:
            src.leave()


def create_hub_router() -> APIRouter:
    from openjarvis.server import claude_routes, jarvis_routes, terminal_http

    router = APIRouter(tags=["hub"])

    @router.post("/v1/hub/poll")
    async def hub_poll(request: Request, body: PollBody) -> dict[str, Any]:
        guard(request)
        app = request.app
        chats = claude_routes.manager_of(app).sessions
        shells = terminal_http._manager(app).shells

        def find_term(sid: str) -> Any:
            shell = shells.get(sid)
            return None if shell is None or shell.closed else shell

        sources, missing = build_sources(
            body.subs,
            find_chat=chats.get,
            find_term=find_term,
            bridge=jarvis_routes._bridge(request),
        )
        return await poll(
            sources, missing, body.wait, disconnected=request.is_disconnected
        )

    return router
