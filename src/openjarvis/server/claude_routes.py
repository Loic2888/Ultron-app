"""Claude Code chats: drive the official ``claude`` program from the browser.

Each chat tab is one *session*. A session owns a ``claude`` subprocess talking
the official ``stream-json`` protocol on stdin/stdout, started with the user's
own ``claude login`` (the subscription). This module never reads, copies or
forwards any token: it only launches the unmodified program, exactly as a
terminal would, and relays its messages.

Rules that keep this safe:

* every request passes the same gates as the terminal and the file routes
  (loopback bind, loopback ``Host``, known ``Origin``, per-process token in the
  ``X-Jarvis-Token`` header);
* the working folder must be inside ``$HOME`` (symlinks followed);
* the provider variables (``ANTHROPIC_*``, ``OPENJARVIS_*``, API keys) are
  removed from the child's environment, so it can only use the subscription;
* ``claude`` asks this server before using a tool that needs permission; the
  question goes to the page, which shows Accept / Refuse buttons. Nothing is
  allowed on its own, and ``bypassPermissions`` is not offered;
* a process that stays idle is stopped and resumed (``--resume``) on the next
  message, so a few open tabs cost almost no memory.

Events are kept in memory (and survive a page reload); a client reads them with
``GET .../events?after=N`` as a never-ending stream of JSON lines.
"""

from __future__ import annotations

import asyncio
import atexit
import json
import os
import re
import secrets
import shutil
import signal
import sys
import tempfile
import time
import uuid
from pathlib import Path
from typing import Any, Optional

try:
    from fastapi import APIRouter, HTTPException, Request
    from fastapi.responses import StreamingResponse
    from pydantic import BaseModel
except ImportError:  # pragma: no cover - fastapi is a server extra
    raise ImportError("fastapi is required for claude routes")

from openjarvis.server import custom_rules, jarvis_policy, journal, repo_memory
from openjarvis.server.terminal_routes import terminal_env
from openjarvis.server.workspace_routes import guard, resolve_inside_home

MAX_SESSIONS = 6
MAX_PROMPT_CHARS = 100_000
MAX_EVENTS = 20_000
IDLE_STOP_SECONDS = 600.0
KEEPALIVE_SECONDS = 15.0
PERMISSION_MODES = ("default", "acceptEdits", "plan", "custom")
EFFORTS = ("low", "medium", "high", "xhigh", "max")
_MODEL_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:\-\[\]]{0,79}$")
KINDS = ("code", "jarvis")
EDIT_TOOLS = ("Edit", "MultiEdit", "Write", "NotebookEdit")
PROBE_EVERY_SECONDS = 600.0
STDOUT_LINE_LIMIT = 32 * 1024 * 1024  # thinking signatures make long lines
_UUID_RE = re.compile(r"^[0-9a-fA-F-]{8,64}$")


def find_claude() -> Optional[str]:
    """Path of the official program, or None if it is not installed."""
    override = os.environ.get("OPENJARVIS_CLAUDE_BIN")
    if override:
        return override
    found = shutil.which("claude")
    if found:
        return found
    # Started from the desktop icon, the server runs in a login shell that has
    # not read ~/.bashrc, so PATH may miss the usual install folders.
    home = Path.home()
    for folder in (
        home / ".npm-global" / "bin",
        home / ".local" / "bin",
        home / ".claude" / "local",
        Path("/usr/local/bin"),
    ):
        candidate = folder / "claude"
        if candidate.is_file() and os.access(candidate, os.X_OK):
            return str(candidate)
    return None


def claude_env(environ: dict[str, str] | os._Environ[str]) -> dict[str, str]:
    """Environment of the child: no provider keys, so only the subscription works."""
    env = terminal_env(environ)
    # Started from the desktop icon, PATH lacks what ~/.bashrc adds (pnpm, claude...),
    # so Claude would not find the project's tools.
    have = [d for d in env.get("PATH", "").split(os.pathsep) if d]
    extra = [
        str(Path.home() / sub)
        for sub in (".npm-global/bin", ".local/bin", ".cargo/bin")
        if (Path.home() / sub).is_dir() and str(Path.home() / sub) not in have
    ]
    env["PATH"] = os.pathsep.join([*have, *extra])
    return env


async def read_account() -> dict[str, Any]:
    """``claude auth status`` reduced to what the screen shows (no ids, no tokens)."""
    binary = find_claude()
    if binary is None:
        return {"installed": False, "logged_in": False}
    try:
        proc = await asyncio.create_subprocess_exec(
            binary,
            "auth",
            "status",
            stdin=asyncio.subprocess.DEVNULL,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.DEVNULL,
            env=claude_env(os.environ),
        )
        out, _ = await asyncio.wait_for(proc.communicate(), 15)
        data = json.loads(out.decode() or "{}")
    except (OSError, ValueError, asyncio.TimeoutError):
        return {"installed": True, "logged_in": False, "error": "unreadable"}
    if not isinstance(data, dict):
        return {"installed": True, "logged_in": False, "error": "unreadable"}
    return {
        "installed": True,
        "logged_in": bool(data.get("loggedIn")),
        "method": data.get("authMethod"),
        "email": data.get("email"),
        "organization": data.get("orgName"),
        "plan": data.get("subscriptionType"),
        "expires_at": data.get("loginExpiresAt"),
    }


async def probe_usage() -> bool:
    """One tiny ``claude`` request, only to read its ``rate_limit_event``.

    Same official program, same login, same cleaned environment as a chat; no
    tools, nothing saved to disk. Returns True when usage was read.
    """
    binary = find_claude()
    if binary is None:
        return False
    try:
        proc = await asyncio.create_subprocess_exec(
            binary,
            "-p",
            "ok",
            "--output-format",
            "stream-json",
            "--verbose",
            "--tools",
            "",
            "--no-session-persistence",
            "--model",
            "haiku",
            stdin=asyncio.subprocess.DEVNULL,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.DEVNULL,
            cwd=str(Path.home()),
            env=claude_env(os.environ),
            limit=STDOUT_LINE_LIMIT,
        )
        out, _ = await asyncio.wait_for(proc.communicate(), 60)
    except (OSError, asyncio.TimeoutError):
        return False
    found = False
    for line in out.decode(errors="replace").splitlines():
        try:
            event = json.loads(line)
        except ValueError:
            continue
        if isinstance(event, dict) and event.get("type") == "rate_limit_event":
            windows = (event.get("rate_limit_info") or {}).get("unifiedWindows")
            if isinstance(windows, dict) and windows:
                journal.save_usage(windows)
                found = True
    return found


def project_dir_name(cwd: str) -> str:
    """How ``claude`` names the folder that holds a repo's transcripts."""
    return re.sub(r"[^A-Za-z0-9]", "-", cwd)


def transcript_events(path: Path, limit: int = 2000) -> list[dict[str, Any]]:
    """Past messages of a conversation, in the shape of live events."""
    out: list[dict[str, Any]] = []
    try:
        lines = path.read_text(encoding="utf-8", errors="replace").splitlines()
    except OSError:
        return out
    for line in lines:
        try:
            rec = json.loads(line)
        except ValueError:
            continue
        kind = rec.get("type")
        if kind in ("user", "assistant") and isinstance(rec.get("message"), dict):
            if rec.get("isSidechain") or rec.get("isMeta"):
                continue
            out.append({"type": kind, "message": rec["message"], "replayed": True})
    return out[-limit:]


class Session:
    """One chat tab: a conversation, its event log and (maybe) a live process."""

    def __init__(
        self,
        sid: str,
        cwd: str,
        permission_mode: str,
        model: Optional[str],
        resume: Optional[str],
        kind: str = "code",
        api_base: str = "",
        effort: Optional[str] = None,
        rules: Optional[custom_rules.CustomRules] = None,
    ) -> None:
        self.id = sid
        self.created_at = time.time()
        self.effort = effort
        self.rules = rules or custom_rules.CustomRules()
        self.kind = kind
        self.api_base = api_base
        # Jarvis only: the secret its MCP helper uses, and the owner's approvals.
        self.secret = secrets.token_urlsafe(32) if kind == "jarvis" else ""
        self.config_dir: Optional[str] = None
        self.grants = jarvis_policy.Grants()
        # Code chats only: the repo's memory folder (see repo_memory).
        self.memory_dir: Optional[Path] = None
        self.cwd = cwd
        self.permission_mode = permission_mode
        self.model = model
        self.claude_session_id: Optional[str] = resume
        self.proc: Optional[asyncio.subprocess.Process] = None
        self.reader: Optional[asyncio.Task[None]] = None
        self.events: list[dict[str, Any]] = []
        self.first_seq = 0  # seq of events[0] (older ones were dropped)
        self.next_seq = 0
        self.pending: dict[str, dict[str, Any]] = {}
        self.busy = False
        self.closed = False
        self.last_activity = time.monotonic()
        self.cond = asyncio.Condition()
        self.idle_task: Optional[asyncio.Task[None]] = None
        # The turn being answered, for the memory: prompt, files, tools.
        self.turn: Optional[dict[str, Any]] = None

    # -- events --------------------------------------------------------

    async def emit(self, event: dict[str, Any]) -> None:
        async with self.cond:
            event = {"seq": self.next_seq, **event}
            self.next_seq += 1
            self.events.append(event)
            if len(self.events) > MAX_EVENTS:
                drop = len(self.events) - MAX_EVENTS
                del self.events[:drop]
                self.first_seq += drop
            self.cond.notify_all()

    @property
    def claude_mode(self) -> str:
        """What ``claude`` is told. "custom" runs as plain "default" and every
        question is decided by our own rules (see custom_rules)."""
        return "default" if self.permission_mode == "custom" else self.permission_mode

    def summary(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "created_at": int(self.created_at),
            "model": self.model,
            "effort": self.effort,
            "rules": self.rules.as_dict(),
            "cwd": self.cwd,
            "kind": self.kind,
            "permission_mode": self.permission_mode,
            "claude_session_id": self.claude_session_id,
            "busy": self.busy,
            "closed": self.closed,
            "alive": self.proc is not None and self.proc.returncode is None,
            "pending": list(self.pending.values()),
            "next_seq": self.next_seq,
        }

    # -- process -------------------------------------------------------

    def _write_mcp_config(self, config: dict[str, Any]) -> str:
        """Put the MCP config (it holds this chat's secret) in a private file.

        A command line is readable by every user of the machine (``ps``); a
        0600 file inside a 0700 folder is not.
        """
        if self.config_dir is None:
            self.config_dir = tempfile.mkdtemp(prefix="jarvis-mcp-")
        path = os.path.join(self.config_dir, "mcp.json")
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w") as handle:
            json.dump(config, handle)
        return path

    def forget_config(self) -> None:
        if self.config_dir is not None:
            shutil.rmtree(self.config_dir, ignore_errors=True)
            self.config_dir = None

    def command(self, binary: str) -> list[str]:
        cmd = [
            binary,
            "-p",
            "--input-format",
            "stream-json",
            "--output-format",
            "stream-json",
            "--verbose",
            "--include-partial-messages",
            "--permission-prompt-tool",
            "stdio",
            "--permission-mode",
            self.claude_mode,
        ]
        if self.kind == "jarvis":
            # No built-in tools at all: Jarvis acts only through its own MCP tools.
            mcp = {
                "mcpServers": {
                    "jarvis": {
                        "command": sys.executable,
                        "args": ["-m", "openjarvis.server.jarvis_mcp"],
                        "env": {
                            "JARVIS_API": self.api_base,
                            "JARVIS_SECRET": self.secret,
                        },
                    }
                }
            }
            cmd += [
                "--tools",
                "",
                "--strict-mcp-config",
                "--mcp-config",
                self._write_mcp_config(mcp),
                "--disable-slash-commands",
                "--append-system-prompt",
                jarvis_policy.PROMPT,
            ]
        if self.kind == "code" and self.memory_dir is not None:
            cmd += [
                "--append-system-prompt",
                repo_memory.prompt_for(self.memory_dir),
                "--add-dir",
                str(self.memory_dir),
            ]
        if self.model:
            cmd += ["--model", self.model]
        if self.effort:
            cmd += ["--effort", self.effort]
        if self.claude_session_id:
            cmd += ["--resume", self.claude_session_id]
        return cmd

    async def ensure_process(self) -> None:
        if self.proc is not None and self.proc.returncode is None:
            return
        binary = find_claude()
        if not binary:
            raise HTTPException(
                status_code=503,
                detail="The `claude` program was not found. Install Claude Code "
                "and run `claude login` in a terminal.",
            )
        self.proc = await asyncio.create_subprocess_exec(
            *self.command(binary),
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            cwd=self.cwd,
            env=claude_env(os.environ),
            limit=STDOUT_LINE_LIMIT,
            start_new_session=True,
        )
        self.reader = asyncio.create_task(self._read(self.proc))

    async def _read(self, proc: asyncio.subprocess.Process) -> None:
        assert proc.stdout is not None and proc.stderr is not None
        stderr_task = asyncio.create_task(proc.stderr.read(8192))
        try:
            while True:
                line = await proc.stdout.readline()
                if not line:
                    break
                try:
                    event = json.loads(line)
                except ValueError:
                    continue
                if not isinstance(event, dict):
                    continue
                await self._handle(event)
        except (asyncio.CancelledError, ConnectionError):
            pass
        finally:
            code = await proc.wait()
            try:
                err = (await asyncio.wait_for(stderr_task, 1.0)).decode(
                    "utf-8", "replace"
                )
            except (asyncio.TimeoutError, asyncio.CancelledError):
                err = ""
            if self.proc is proc:
                was_busy = self.busy
                self.busy = False
                self.pending.clear()
                await self.emit(
                    {
                        "type": "jarvis",
                        "kind": "process_exit",
                        "code": code,
                        "during_turn": was_busy,
                        "stderr": err.strip()[-600:],
                    }
                )

    async def _handle(self, event: dict[str, Any]) -> None:
        kind = event.get("type")
        if kind == "system" and event.get("subtype") == "init":
            sid = event.get("session_id")
            if isinstance(sid, str):
                self.claude_session_id = sid
        if kind == "control_request":
            req = event.get("request") or {}
            rid = event.get("request_id")
            if req.get("subtype") == "can_use_tool" and isinstance(rid, str):
                if self.kind == "jarvis":
                    verdict = jarvis_policy.decide(str(req.get("tool_name") or ""))
                    if verdict == "allow":
                        await self._reply(
                            rid,
                            {
                                "behavior": "allow",
                                "updatedInput": req.get("input") or {},
                            },
                        )
                        return
                    if verdict == "deny":
                        await self._reply(
                            rid,
                            {
                                "behavior": "deny",
                                "message": "Jarvis may only use its own tools.",
                            },
                        )
                        return
                if self.kind == "code" and repo_memory.allows(
                    req.get("tool_name"), req.get("input"), self.memory_dir
                ):
                    # Its own repo's memory notes: the one thing it may touch
                    # without asking.
                    await self._reply(
                        rid,
                        {"behavior": "allow", "updatedInput": req.get("input") or {}},
                    )
                    if req.get("tool_name") != "Read":
                        journal.log(
                            "memory",
                            "Mémoire du repo mise à jour : "
                            + Path(str((req.get("input") or {}).get("file_path"))).name,
                            repo=self.cwd,
                        )
                    return
                if self.kind == "code" and self.permission_mode == "custom":
                    why = custom_rules.allows(
                        self.rules, req.get("tool_name"), req.get("input"), self.cwd
                    )
                    if why:
                        await self._reply(
                            rid,
                            {
                                "behavior": "allow",
                                "updatedInput": req.get("input") or {},
                            },
                        )
                        given = req.get("input") or {}
                        if req.get("tool_name") == "Bash":
                            journal.log(
                                "rules",
                                f"Accepté sans demander ({why}) : "
                                f"{str(given.get('command'))[:120]}",
                                repo=self.cwd,
                            )
                        elif req.get("tool_name") not in custom_rules.EDIT_TOOLS:
                            journal.log(
                                "rules",
                                f"Accepté sans demander ({why}) : "
                                f"{str(req.get('tool_name'))[:120]}",
                                repo=self.cwd,
                            )
                        return
                item = {
                    "request_id": rid,
                    "tool_name": req.get("tool_name"),
                    "display_name": req.get("display_name"),
                    "description": req.get("description"),
                    "input": req.get("input"),
                }
                self.pending[rid] = item
                await self.emit({"type": "jarvis", "kind": "approval", **item})
            elif isinstance(rid, str):
                # Any other request is refused: this app never grants unknown things.
                await self._reply(rid, {"behavior": "deny", "message": "Unsupported"})
            return
        if kind == "control_response":
            return
        if kind == "rate_limit_event":
            windows = (event.get("rate_limit_info") or {}).get("unifiedWindows")
            if isinstance(windows, dict) and windows:
                journal.save_usage(windows)
        elif kind == "assistant":
            self._note_tools(event)
        elif kind == "result":
            self.busy = False
            self._finish_turn(event)
        await self.emit(event)

    def _note_tools(self, event: dict[str, Any]) -> None:
        turn = self.turn
        content = (event.get("message") or {}).get("content")
        if turn is None or not isinstance(content, list):
            return
        for block in content:
            if not isinstance(block, dict) or block.get("type") != "tool_use":
                continue
            name = str(block.get("name") or "?")
            turn["tools"][name] = turn["tools"].get(name, 0) + 1
            args = block.get("input") if isinstance(block.get("input"), dict) else {}
            if name in EDIT_TOOLS:
                path = args.get("file_path") or args.get("notebook_path")
                if (
                    isinstance(path, str)
                    and not (
                        self.memory_dir is not None
                        and repo_memory.is_inside(path, self.memory_dir)
                    )  # its own memory notes are not "work on the repo"
                    and self._relative(path) not in turn["files"]
                ):
                    turn["files"].append(self._relative(path))

    def _relative(self, path: str) -> str:
        try:
            return str(Path(path).resolve().relative_to(Path(self.cwd).resolve()))
        except (ValueError, OSError):
            return path

    def _finish_turn(self, event: dict[str, Any]) -> None:
        turn, self.turn = self.turn, None
        if turn is None or self.kind != "code":
            return
        ok = not event.get("is_error")
        answer = event.get("result") if isinstance(event.get("result"), str) else ""
        journal.remember_turn(
            repo=self.cwd,
            chat=self.id,
            prompt=turn["prompt"],
            files=turn["files"],
            tools=turn["tools"],
            answer=answer,
            ok=ok,
            started=turn["started"],
        )
        done = "terminé" if ok else "terminé avec une erreur"
        journal.log(
            "claude",
            f"Claude Code {done} sur {Path(self.cwd).name}"
            + (
                f" ({len(turn['files'])} fichier(s) modifié(s))"
                if turn["files"]
                else ""
            ),
            repo=self.cwd,
            level="info" if ok else "warn",
        )

    async def _write(self, payload: dict[str, Any]) -> None:
        proc = self.proc
        if proc is None or proc.returncode is not None or proc.stdin is None:
            raise HTTPException(status_code=409, detail="The session is not running")
        proc.stdin.write((json.dumps(payload) + "\n").encode())
        await proc.stdin.drain()

    async def _reply(self, request_id: str, response: dict[str, Any]) -> None:
        await self._write(
            {
                "type": "control_response",
                "response": {
                    "subtype": "success",
                    "request_id": request_id,
                    "response": response,
                },
            }
        )

    # -- actions -------------------------------------------------------

    def touch(self) -> None:
        self.last_activity = time.monotonic()

    async def send(self, text: str) -> None:
        if self.closed:
            raise HTTPException(status_code=409, detail="The session is closed")
        if self.busy:
            raise HTTPException(status_code=409, detail="Claude is still answering")
        await self.ensure_process()
        self.busy = True
        self.touch()
        await self.emit({"type": "jarvis", "kind": "user_message", "text": text})
        self.turn = {"prompt": text, "started": time.time(), "files": [], "tools": {}}
        journal.log(
            "claude",
            f"Message envoyé à Claude Code sur {Path(self.cwd).name} : {text}",
            repo=self.cwd,
        )
        try:
            await self._write(
                {"type": "user", "message": {"role": "user", "content": text}}
            )
        except Exception:
            self.busy = False
            raise
        self._schedule_idle()

    async def decide(
        self, request_id: str, allow: bool, message: Optional[str] = None
    ) -> None:
        item = self.pending.pop(request_id, None)
        if item is None:
            raise HTTPException(status_code=404, detail="No such pending request")
        if allow and self.kind == "jarvis":
            # Remember the owner's Accept for exactly this call; the tool
            # endpoint refuses sensitive actions without it.
            tool = str(item.get("tool_name") or "")
            if jarvis_policy.risk_of(tool) == "sensitive":
                self.grants.add(tool, item.get("input"))
        journal.log(
            "approval",
            ("Accepté" if allow else "Refusé")
            + f" : {item.get('display_name') or item.get('tool_name')}"
            + f" ({Path(self.cwd).name})",
            repo=self.cwd,
        )
        if allow:
            response: dict[str, Any] = {
                "behavior": "allow",
                "updatedInput": item.get("input") or {},
            }
        else:
            response = {"behavior": "deny", "message": message or "Refused by the user"}
        await self._reply(request_id, response)
        await self.emit(
            {
                "type": "jarvis",
                "kind": "approval_resolved",
                "request_id": request_id,
                "allow": allow,
            }
        )
        self.touch()

    async def interrupt(self) -> None:
        if not self.busy:
            return
        await self._write(
            {
                "type": "control_request",
                "request_id": uuid.uuid4().hex,
                "request": {"subtype": "interrupt"},
            }
        )

    async def stop_process(self) -> None:
        proc = self.proc
        if proc is None or proc.returncode is not None:
            return
        self.proc = None  # the reader must not report this as a crash
        try:
            os.killpg(proc.pid, signal.SIGTERM)
        except (ProcessLookupError, PermissionError):
            pass
        try:
            await asyncio.wait_for(proc.wait(), 3.0)
        except asyncio.TimeoutError:
            try:
                os.killpg(proc.pid, signal.SIGKILL)
            except (ProcessLookupError, PermissionError):
                pass
        if self.reader:
            self.reader.cancel()
        self.busy = False
        self.pending.clear()

    async def close(self) -> None:
        self.closed = True
        if self.idle_task:
            self.idle_task.cancel()
        await self.stop_process()
        self.forget_config()
        await self.emit({"type": "jarvis", "kind": "closed"})

    def _schedule_idle(self) -> None:
        if self.idle_task:
            self.idle_task.cancel()
        self.idle_task = asyncio.create_task(self._idle_watch())

    async def _idle_watch(self) -> None:
        try:
            while not self.closed:
                await asyncio.sleep(max(1.0, IDLE_STOP_SECONDS / 10))
                idle = time.monotonic() - self.last_activity
                if idle >= IDLE_STOP_SECONDS and not self.busy and not self.pending:
                    await self.stop_process()
                    await self.emit({"type": "jarvis", "kind": "idle_stopped"})
                    return
        except asyncio.CancelledError:
            pass


class Manager:
    def __init__(self) -> None:
        self.sessions: dict[str, Session] = {}
        atexit.register(self.kill_all)

    def kill_all(self) -> None:
        for s in list(self.sessions.values()):
            s.forget_config()
            proc = s.proc
            if proc is not None and proc.returncode is None:
                try:
                    os.killpg(proc.pid, signal.SIGTERM)
                except (ProcessLookupError, PermissionError):
                    pass

    async def close_all(self) -> None:
        for s in list(self.sessions.values()):
            await s.close()
        self.sessions.clear()


def install_cleanup(app: Any) -> None:
    """Stop every chat (and delete private files) when the server shuts down.

    ``atexit`` alone is not enough: uvicorn ends the process with the signal it
    received, which skips ``atexit`` handlers.
    """

    @app.on_event("shutdown")
    async def _stop_chats() -> None:
        mgr = getattr(app.state, "claude_manager", None)
        if mgr is not None:
            await mgr.close_all()


class SessionLimit(Exception):
    """Every chat slot is in use."""


async def make_session(
    mgr: "Manager",
    *,
    cwd: Path,
    mode: str,
    model: Optional[str],
    resume: Optional[str],
    kind: str,
    api_port: int,
    effort: Optional[str] = None,
    rules: Optional[custom_rules.CustomRules] = None,
) -> Session:
    """Create and register a chat session (shared by the HTTP route and the phone)."""
    live = [s for s in mgr.sessions.values() if not s.closed]
    if len(live) >= MAX_SESSIONS:
        # Free the longest-unused chat that is doing nothing (no running
        # program, no answer pending): its conversation can still be
        # resumed from disk. Refuse only when every chat is in use.
        idle = [
            s
            for s in live
            if not s.busy
            and not s.pending
            and (s.proc is None or s.proc.returncode is not None)
        ]
        if not idle:
            raise SessionLimit(f"At most {MAX_SESSIONS} chats at once")
        oldest = min(idle, key=lambda s: s.last_activity)
        await oldest.close()
        mgr.sessions.pop(oldest.id, None)
    session = Session(
        uuid.uuid4().hex,
        str(cwd),
        "default" if kind == "jarvis" else mode,
        model,
        resume,
        kind=kind,
        api_base=f"http://127.0.0.1:{api_port}",
        effort=effort,
        rules=rules,
    )
    mgr.sessions[session.id] = session
    if kind == "code":
        try:
            session.memory_dir = repo_memory.ensure_repo_memory(cwd)
        except OSError:
            session.memory_dir = None  # no memory this time; the chat still works
    if resume:
        for ev in transcript_events(
            Path.home()
            / ".claude"
            / "projects"
            / project_dir_name(str(cwd))
            / f"{resume}.jsonl"
        ):
            await session.emit(ev)
    return session


def manager_of(app: Any) -> "Manager":
    mgr = getattr(app.state, "claude_manager", None)
    if mgr is None:
        mgr = Manager()
        app.state.claude_manager = mgr
    return mgr


def _manager(request: Request) -> Manager:
    return manager_of(request.app)


def _get(request: Request, sid: str) -> Session:
    session = _manager(request).sessions.get(sid)
    if session is None:
        raise HTTPException(status_code=404, detail="No such session")
    return session


class CreateBody(BaseModel):
    cwd: str
    permission_mode: str = "default"
    model: Optional[str] = None
    resume: Optional[str] = None
    kind: str = "code"
    effort: Optional[str] = None
    rules: Optional[dict[str, Any]] = None


class MessageBody(BaseModel):
    text: str


class DecideBody(BaseModel):
    request_id: str
    allow: bool
    message: Optional[str] = None


class ModeBody(BaseModel):
    permission_mode: str
    rules: Optional[dict[str, Any]] = None


class SettingsBody(BaseModel):
    model: Optional[str] = None  # None = the program's default
    effort: Optional[str] = None


def _check_model_effort(model: Optional[str], effort: Optional[str]) -> None:
    if model and not _MODEL_RE.match(model):
        raise HTTPException(status_code=400, detail="Bad model name")
    if effort and effort not in EFFORTS:
        raise HTTPException(status_code=400, detail="Unknown effort level")


def create_claude_router() -> APIRouter:
    router = APIRouter(tags=["claude"])

    @router.get("/v1/claude/status")
    async def claude_status(request: Request) -> dict[str, Any]:
        guard(request)
        return {"installed": find_claude() is not None}

    @router.get("/v1/claude/account")
    async def claude_account(request: Request) -> dict[str, Any]:
        """Which Anthropic account the official ``claude`` program is signed in to."""
        guard(request)
        return await read_account()

    @router.get("/v1/claude/usage")
    async def claude_usage(request: Request) -> dict[str, Any]:
        """Last 5 h / 7 d usage seen in a ``rate_limit_event`` (may be None)."""
        guard(request)
        return {"usage": journal.load_usage()}

    @router.post("/v1/claude/usage/refresh")
    async def claude_usage_refresh(request: Request) -> dict[str, Any]:
        """Read fresh usage with one tiny ``claude`` request (10 min apart)."""
        guard(request)
        state = request.app.state
        last = getattr(state, "usage_probe_at", 0.0)
        if time.monotonic() - last >= PROBE_EVERY_SECONDS or last == 0.0:
            state.usage_probe_at = time.monotonic()
            await probe_usage()
        return {"usage": journal.load_usage()}

    @router.post("/v1/claude/sessions")
    async def create_session(request: Request, body: CreateBody) -> dict[str, Any]:
        guard(request)
        mgr = _manager(request)
        if body.permission_mode not in PERMISSION_MODES:
            raise HTTPException(status_code=400, detail="Unknown permission mode")
        if body.kind not in KINDS:
            raise HTTPException(status_code=400, detail="Unknown chat kind")
        _check_model_effort(body.model, body.effort)
        if body.resume is not None and not _UUID_RE.match(body.resume):
            raise HTTPException(status_code=400, detail="Bad conversation id")
        try:
            cwd = resolve_inside_home(body.cwd)
        except ValueError as exc:
            raise HTTPException(
                status_code=403 if "inside" in str(exc) else 404, detail=str(exc)
            )
        if not cwd.is_dir():
            raise HTTPException(status_code=400, detail="Not a folder")
        server = request.scope.get("server") or ("127.0.0.1", request.url.port or 80)
        try:
            session = await make_session(
                mgr,
                cwd=cwd,
                mode=body.permission_mode,
                model=body.model,
                resume=body.resume,
                kind=body.kind,
                api_port=server[1],
                effort=body.effort,
                rules=custom_rules.CustomRules.from_dict(body.rules),
            )
        except SessionLimit as exc:
            raise HTTPException(status_code=429, detail=str(exc))
        if session.kind == "code":
            journal.log(
                "claude",
                f"Fenêtre Claude Code ouverte sur {cwd.name}",
                repo=str(cwd),
            )
        return session.summary()

    @router.get("/v1/claude/sessions")
    async def list_sessions(
        request: Request, cwd: Optional[str] = None
    ) -> dict[str, Any]:
        guard(request)
        items = [
            s.summary()
            for s in _manager(request).sessions.values()
            if not s.closed and (cwd is None or s.cwd == cwd)
        ]
        return {"sessions": items}

    @router.get("/v1/claude/sessions/{sid}")
    async def get_session(request: Request, sid: str) -> dict[str, Any]:
        guard(request)
        return _get(request, sid).summary()

    @router.post("/v1/claude/sessions/{sid}/message")
    async def send_message(
        request: Request, sid: str, body: MessageBody
    ) -> dict[str, Any]:
        guard(request)
        session = _get(request, sid)
        text = body.text.strip()
        if not text:
            raise HTTPException(status_code=400, detail="Empty message")
        if len(text) > MAX_PROMPT_CHARS:
            raise HTTPException(status_code=413, detail="Message too long")
        await session.send(text)
        return {"ok": True}

    @router.post("/v1/claude/sessions/{sid}/decision")
    async def decide(request: Request, sid: str, body: DecideBody) -> dict[str, Any]:
        guard(request)
        await _get(request, sid).decide(body.request_id, body.allow, body.message)
        return {"ok": True}

    @router.post("/v1/claude/sessions/{sid}/interrupt")
    async def interrupt(request: Request, sid: str) -> dict[str, Any]:
        guard(request)
        await _get(request, sid).interrupt()
        return {"ok": True}

    @router.post("/v1/claude/sessions/{sid}/mode")
    async def set_mode(request: Request, sid: str, body: ModeBody) -> dict[str, Any]:
        guard(request)
        session = _get(request, sid)
        if body.permission_mode not in PERMISSION_MODES:
            raise HTTPException(status_code=400, detail="Unknown permission mode")
        if session.busy or session.pending:
            raise HTTPException(
                status_code=409, detail="Wait until Claude has finished to change mode"
            )
        if body.rules is not None:
            session.rules = custom_rules.CustomRules.from_dict(body.rules)
        if body.permission_mode != session.permission_mode:
            before = session.claude_mode
            session.permission_mode = body.permission_mode
            journal.log(
                "claude",
                f"Mode de permission : {body.permission_mode} "
                f"({Path(session.cwd).name})",
                repo=session.cwd,
            )
            if session.claude_mode != before:
                # The next message restarts the program (and resumes) in the new mode.
                await session.stop_process()
        return session.summary()

    @router.post("/v1/claude/sessions/{sid}/settings")
    async def set_settings(
        request: Request, sid: str, body: SettingsBody
    ) -> dict[str, Any]:
        guard(request)
        session = _get(request, sid)
        _check_model_effort(body.model, body.effort)
        if session.busy or session.pending:
            raise HTTPException(
                status_code=409, detail="Wait until Claude has finished to change this"
            )
        if (body.model or None, body.effort or None) != (
            session.model,
            session.effort,
        ):
            session.model = body.model or None
            session.effort = body.effort or None
            journal.log(
                "claude",
                f"Modèle {session.model or 'par défaut'}, effort "
                f"{session.effort or 'par défaut'} ({Path(session.cwd).name})",
                repo=session.cwd,
            )
            await session.stop_process()  # restarts with --resume on the next message
        return session.summary()

    @router.delete("/v1/claude/sessions/{sid}")
    async def close_session(request: Request, sid: str) -> dict[str, Any]:
        guard(request)
        session = _get(request, sid)
        await session.close()
        _manager(request).sessions.pop(sid, None)
        if session.kind == "code":
            journal.log(
                "claude",
                f"Fenêtre Claude Code fermée sur {Path(session.cwd).name}",
                repo=session.cwd,
            )
        return {"ok": True}

    @router.get("/v1/claude/sessions/{sid}/events")
    async def events(
        request: Request, sid: str, after: int = -1, follow: bool = True
    ) -> StreamingResponse:
        guard(request)
        session = _get(request, sid)

        async def stream():
            cursor = after + 1
            while True:
                async with session.cond:
                    start = max(cursor, session.first_seq)
                    batch = session.events[start - session.first_seq :]
                    if not batch:
                        if session.closed or not follow:
                            return
                        try:
                            await asyncio.wait_for(
                                session.cond.wait(), KEEPALIVE_SECONDS
                            )
                        except asyncio.TimeoutError:
                            pass
                        batch = session.events[
                            max(cursor, session.first_seq) - session.first_seq :
                        ]
                if await request.is_disconnected():
                    return
                if not batch:
                    yield b'{"keepalive":true}\n'
                    continue
                cursor = batch[-1]["seq"] + 1
                yield b"".join(
                    json.dumps(e, separators=(",", ":")).encode() + b"\n" for e in batch
                )

        return StreamingResponse(
            stream(),
            media_type="application/x-ndjson",
            headers={"Cache-Control": "no-store", "X-Accel-Buffering": "no"},
        )

    return router
