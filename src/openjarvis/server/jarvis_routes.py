"""Routes that let the Ultron assistant act on the app.

Two audiences, two kinds of authentication:

* the **browser** (the screen) uses the same gates as the terminal and the
  file routes: loopback bind and ``Host``, known ``Origin``, per-process token.
  It reads *commands* (open a repo, open a tab...) from a stream, claims one,
  runs it on screen and reports the result;
* the **MCP helper** started by the Ultron ``claude`` session has no browser
  token. It authenticates with the secret of that one Ultron session
  (``X-Jarvis-Secret``) and must come from the loopback address.

Tools that change the disk (``create_repo``, ``delete_path``) are executed here
and refuse to run unless the owner approved exactly that call a moment ago
(see ``jarvis_policy.Grants``).
"""

from __future__ import annotations

import asyncio
import hmac
import itertools
import os
import shutil
import subprocess
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

try:
    from fastapi import APIRouter, HTTPException, Request
    from fastapi.responses import StreamingResponse
    from pydantic import BaseModel
except ImportError:  # pragma: no cover - fastapi is a server extra
    raise ImportError("fastapi is required for jarvis routes")

import json

from openjarvis.server import integrations, journal
from openjarvis.server import jarvis_policy as policy
from openjarvis.server.terminal_routes import (
    host_header_is_loopback,
    is_loopback_address,
)
from openjarvis.server.workspace_routes import guard, resolve_inside_home

SCREEN_TIMEOUT = 25.0
KEEPALIVE_SECONDS = 15.0
SCREEN_GRACE_SECONDS = 5.0
MAX_COMMANDS = 200
TRASH_DIR = ".jarvis-trash"
FIND_MAX_DEPTH = 3
FIND_MAX_RESULTS = 50
_SKIP_DIRS = {"node_modules", ".git", ".venv", "venv", "__pycache__", "target"}


# Tools served by ``integrations`` (blocking programs: run in a thread).
INTEGRATION_CALLS: dict[str, Any] = {
    "github_overview": lambda a: integrations.github_overview(),
    "github_list": lambda a: integrations.github_list(
        a.get("repo"), str(a.get("kind") or "pr"), str(a.get("state") or "open")
    ),
    "github_pr": lambda a: integrations.github_pr(a.get("repo"), a.get("number")),
    "ask_connectors": lambda a: integrations.ask_connectors(a.get("question")),
    "github_comment": lambda a: integrations.github_comment(
        a.get("repo"), str(a.get("kind") or ""), a.get("number"), a.get("body")
    ),
    "git_push": lambda a: integrations.git_push(a.get("path"), a.get("branch")),
    "github_create_pr": lambda a: integrations.github_create_pr(
        a.get("path"), a.get("title"), a.get("body") or "", a.get("base") or "main"
    ),
    "mail_send": lambda a: integrations.mail_send(
        a.get("to"), a.get("subject"), a.get("body")
    ),
}


class NoScreen(Exception):
    """No browser window is connected to carry out a screen command."""


class Bridge:
    """Commands for the screen: queued for the browser, answered by it."""

    def __init__(self) -> None:
        self.commands: list[dict[str, Any]] = []
        self.first_seq = 0
        self._seq = itertools.count()
        self.cond = asyncio.Condition()
        self.pending: dict[str, asyncio.Future[dict[str, Any]]] = {}
        self.claimed: set[str] = set()
        self.clients = 0
        self.last_screen = 0.0  # when a screen last followed the commands

    async def call(
        self, name: str, args: dict[str, Any], timeout: float = SCREEN_TIMEOUT
    ) -> dict[str, Any]:
        # The page re-asks right after each answer: a short gap is not "closed".
        gap = time.monotonic() - self.last_screen
        if self.clients <= 0 and gap > SCREEN_GRACE_SECONDS:
            raise NoScreen(
                "No Ultron screen is open. Open the app in the browser first."
            )
        seq = next(self._seq)
        cid = f"c{seq}"
        loop = asyncio.get_running_loop()
        fut: asyncio.Future[dict[str, Any]] = loop.create_future()
        self.pending[cid] = fut
        async with self.cond:
            self.commands.append({"seq": seq, "id": cid, "name": name, "args": args})
            if len(self.commands) > MAX_COMMANDS:
                drop = len(self.commands) - MAX_COMMANDS
                del self.commands[:drop]
                self.first_seq += drop
            self.cond.notify_all()
        try:
            return await asyncio.wait_for(fut, timeout)
        except asyncio.TimeoutError:
            raise NoScreen("The screen did not answer in time.")
        finally:
            self.pending.pop(cid, None)
            self.claimed.discard(cid)

    def claim(self, cid: str) -> bool:
        """First screen to claim a command runs it (two open tabs must not both)."""
        if cid not in self.pending or cid in self.claimed:
            return False
        self.claimed.add(cid)
        return True

    def resolve(self, cid: str, outcome: dict[str, Any]) -> bool:
        fut = self.pending.get(cid)
        if fut is None or fut.done() or cid not in self.claimed:
            return False
        fut.set_result(outcome)
        return True


def _bridge(request: Request) -> Bridge:
    bridge = getattr(request.app.state, "jarvis_bridge", None)
    if bridge is None:
        bridge = Bridge()
        request.app.state.jarvis_bridge = bridge
    return bridge


# --------------------------------------------------------------------------
# Server-side tools
# --------------------------------------------------------------------------


def find_repos(query: str, home: Optional[Path] = None) -> list[dict[str, str]]:
    """Git repositories under $HOME whose folder name contains *query*."""
    root = (home or Path.home()).resolve()
    needle = query.strip().lower()
    found: list[dict[str, str]] = []

    def walk(folder: Path, depth: int) -> None:
        if len(found) >= FIND_MAX_RESULTS or depth > FIND_MAX_DEPTH:
            return
        try:
            entries = sorted(os.scandir(folder), key=lambda e: e.name.lower())
        except OSError:
            return
        if (folder / ".git").exists() and (not needle or needle in folder.name.lower()):
            found.append({"path": str(folder), "name": folder.name})
        for entry in entries:
            if entry.name in _SKIP_DIRS or entry.name.startswith("."):
                continue
            try:
                if entry.is_dir(follow_symlinks=False):
                    walk(Path(entry.path), depth + 1)
            except OSError:
                continue

    walk(root, 0)
    return found


def create_repo(path: str, home: Optional[Path] = None) -> dict[str, str]:
    target = resolve_inside_home(path, home, must_exist=False)
    root = (home or Path.home()).resolve()
    if target == root:
        raise ValueError("Choose a folder inside the home folder, not the home itself")
    if (target / ".git").exists():
        raise ValueError("This folder is already a git repository")
    if target.exists() and not target.is_dir():
        raise ValueError("A file with this name already exists")
    target.mkdir(parents=True, exist_ok=True)
    result = subprocess.run(
        ["git", "init", "-q"],
        cwd=target,
        capture_output=True,
        text=True,
        timeout=30,
        check=False,
    )
    if result.returncode != 0:
        raise ValueError(f"git init failed: {result.stderr.strip()[:200]}")
    return {"path": str(target), "name": target.name}


def delete_path(path: str, home: Optional[Path] = None) -> dict[str, str]:
    """Move a file or folder to ~/.jarvis-trash (recoverable), never rm."""
    root = (home or Path.home()).resolve()
    target = resolve_inside_home(path, home)
    if target == root:
        raise ValueError("The home folder cannot be deleted")
    relative = target.relative_to(root)
    top = relative.parts[0]
    if top.startswith(".") or top == TRASH_DIR:
        raise ValueError(
            "Hidden folders in the home (settings, keys, trash) are protected"
        )
    if (root / TRASH_DIR) in target.parents:
        raise ValueError("Already in the trash")
    stamp = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
    trash = root / TRASH_DIR / f"{stamp}-{target.name}"
    n = 1
    while trash.exists():
        n += 1
        trash = root / TRASH_DIR / f"{stamp}-{n}-{target.name}"
    trash.parent.mkdir(parents=True, exist_ok=True)
    shutil.move(str(target), str(trash))
    return {"moved_to": str(trash)}


# --------------------------------------------------------------------------
# Authentication of the MCP helper
# --------------------------------------------------------------------------


def _deny(detail: str, status: int = 403) -> HTTPException:
    return HTTPException(status_code=status, detail=detail)


def _jarvis_session(request: Request):
    """The live Ultron session whose secret was sent, else a 403."""
    client = request.client.host if request.client else None
    if not is_loopback_address(client):
        raise _deny("Only the local machine may call this")
    if not host_header_is_loopback(request.headers.get("host")):
        raise _deny("Unexpected Host header")
    sent = request.headers.get("x-jarvis-secret", "")
    mgr = getattr(request.app.state, "claude_manager", None)
    if not sent or mgr is None:
        raise _deny("Missing or wrong secret")
    match = None
    for session in mgr.sessions.values():  # compare all: no early exit on a match
        if (
            session.kind == "jarvis"
            and not session.closed
            and hmac.compare_digest(sent.encode(), session.secret.encode())
        ):
            match = session
    if match is None:
        raise _deny("Missing or wrong secret")
    return match


class ToolBody(BaseModel):
    name: str
    input: dict[str, Any] = {}


class ResultBody(BaseModel):
    ok: bool
    result: Any = None
    error: Optional[str] = None


def create_jarvis_router() -> APIRouter:
    router = APIRouter(tags=["jarvis"])

    # ---- the screen -------------------------------------------------------

    @router.get("/v1/jarvis/commands")
    async def commands(
        request: Request, after: int = -1, follow: bool = True
    ) -> StreamingResponse:
        guard(request)
        bridge = _bridge(request)

        async def stream():
            bridge.clients += 1
            cursor = after + 1
            try:
                while True:
                    async with bridge.cond:
                        start = max(cursor, bridge.first_seq)
                        batch = bridge.commands[start - bridge.first_seq :]
                        if not batch:
                            if not follow:
                                return
                            try:
                                await asyncio.wait_for(
                                    bridge.cond.wait(), KEEPALIVE_SECONDS
                                )
                            except asyncio.TimeoutError:
                                pass
                            batch = bridge.commands[
                                max(cursor, bridge.first_seq) - bridge.first_seq :
                            ]
                    if await request.is_disconnected():
                        return
                    if not batch:
                        yield b'{"keepalive":true}\n'
                        continue
                    cursor = batch[-1]["seq"] + 1
                    yield b"".join(
                        json.dumps(c, separators=(",", ":")).encode() + b"\n"
                        for c in batch
                    )
            finally:
                bridge.clients -= 1

        return StreamingResponse(
            stream(),
            media_type="application/x-ndjson",
            headers={"Cache-Control": "no-store", "X-Accel-Buffering": "no"},
        )

    @router.post("/v1/jarvis/commands/{cid}/claim")
    async def claim(request: Request, cid: str) -> dict[str, Any]:
        guard(request)
        return {"claimed": _bridge(request).claim(cid)}

    @router.post("/v1/jarvis/commands/{cid}/result")
    async def result(request: Request, cid: str, body: ResultBody) -> dict[str, Any]:
        guard(request)
        outcome = {"ok": body.ok, "result": body.result, "error": body.error}
        if not _bridge(request).resolve(cid, outcome):
            raise HTTPException(status_code=404, detail="No such pending command")
        return {"ok": True}

    @router.get("/v1/integrations/status")
    async def integrations_status(request: Request) -> dict[str, Any]:
        """Which outside services are ready (GitHub, connectors, mail); no secret."""
        guard(request)
        return await asyncio.to_thread(integrations.status)

    # ---- the assistant (MCP helper) ----------------------------------------

    @router.post("/v1/jarvis/tool")
    async def tool(request: Request, body: ToolBody) -> dict[str, Any]:
        session = _jarvis_session(request)
        name = body.name
        entry = policy.TOOLS.get(name)
        if entry is None:
            raise HTTPException(status_code=404, detail=f"Unknown tool: {name}")
        risk, where, _desc, _schema = entry
        args = body.input
        if risk == "sensitive" and not session.grants.consume(name, args):
            # Second line of defence: the owner's Accept for this exact call.
            return {
                "ok": False,
                "error": "The owner has not approved this action. Ask them to accept "
                "it when the approval card appears.",
            }
        if name not in ("read_chat", "list_workspace"):
            target = args.get("path") or args.get("repo") or args.get("query") or ""
            journal.log("jarvis", f"Ultron : {name} {target}".strip())
        try:
            if where == "screen":
                wait = 0.0
                if name == "read_chat":
                    wait = min(120.0, max(0.0, float(args.get("wait_seconds") or 0)))
                outcome = await _bridge(request).call(
                    name, args, timeout=SCREEN_TIMEOUT + wait
                )
                return outcome
            if name == "find_repos":
                return {"ok": True, "result": find_repos(str(args.get("query", "")))}
            if name == "create_repo":
                return {"ok": True, "result": create_repo(str(args.get("path", "")))}
            if name == "delete_path":
                return {"ok": True, "result": delete_path(str(args.get("path", "")))}
            if name in INTEGRATION_CALLS:
                result = await asyncio.to_thread(INTEGRATION_CALLS[name], args)
                return {"ok": True, "result": result}
        except NoScreen as exc:
            return {"ok": False, "error": str(exc)}
        except (ValueError, OSError, subprocess.SubprocessError) as exc:
            return {"ok": False, "error": str(exc)}
        raise HTTPException(status_code=500, detail="Tool is not wired")

    return router
