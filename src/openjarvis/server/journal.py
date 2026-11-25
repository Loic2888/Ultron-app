"""Journal of the workbench: logs, Claude Code memory and last known plan usage.

Everything stays on this machine, in ``<config dir>/journal`` (``~/.openjarvis``
or ``$OPENJARVIS_HOME``):

* ``logs.jsonl``   one line per action ("repo opened", "message sent", ...);
* ``memory.jsonl`` one line per finished Claude Code turn: which repo, what was
  asked, which files were touched, the final answer in short;
* ``usage.json``   the last 5 h / 7 d plan usage seen in a ``rate_limit_event``,
  so the gauges can show it as soon as the page opens.

Routes (same gates as the other workbench routes): ``GET/POST /v1/journal/logs``,
``DELETE /v1/journal/logs``, ``GET /v1/journal/memory``. Nothing is sent anywhere.
"""

from __future__ import annotations

import json
import os
import threading
import time
from pathlib import Path
from typing import Any, Optional

try:
    from fastapi import APIRouter, HTTPException, Request
    from pydantic import BaseModel
except ImportError:  # pragma: no cover - fastapi is a server extra
    raise ImportError("fastapi is required for journal routes")


MAX_FILE_BYTES = 4_000_000
KEEP_AFTER_TRIM = 2_000  # lines kept when a file is trimmed
LEVELS = ("info", "warn", "error")
MAX_TEXT = 600
_lock = threading.Lock()


def journal_dir() -> Path:
    base = os.environ.get("OPENJARVIS_HOME")
    root = Path(base) if base else Path.home() / ".openjarvis"
    return root / "journal"


def _clip(value: Any, limit: int = MAX_TEXT) -> str:
    text = " ".join(str(value or "").split())
    return text if len(text) <= limit else text[: limit - 1] + "…"


def _append(name: str, record: dict[str, Any]) -> None:
    """Add one JSON line; trim the file when it grows too big. Never raises."""
    try:
        directory = journal_dir()
        directory.mkdir(parents=True, exist_ok=True)
        path = directory / name
        line = json.dumps(record, ensure_ascii=False, separators=(",", ":")) + "\n"
        with _lock:
            if path.exists() and path.stat().st_size > MAX_FILE_BYTES:
                lines = path.read_text("utf-8", errors="replace").splitlines()
                path.write_text("\n".join(lines[-KEEP_AFTER_TRIM:]) + "\n", "utf-8")
            with path.open("a", encoding="utf-8") as fh:
                fh.write(line)
    except OSError:
        pass


def _read(name: str, limit: int) -> list[dict[str, Any]]:
    path = journal_dir() / name
    try:
        with _lock:
            lines = path.read_text("utf-8", errors="replace").splitlines()
    except OSError:
        return []
    out: list[dict[str, Any]] = []
    for line in lines[-limit:]:
        try:
            item = json.loads(line)
        except ValueError:
            continue
        if isinstance(item, dict):
            out.append(item)
    return out


# -- logs ---------------------------------------------------------------------


def log(
    category: str,
    message: str,
    *,
    repo: Optional[str] = None,
    level: str = "info",
) -> None:
    """Record one action. ``repo`` is the folder it concerns, if any."""
    _append(
        "logs.jsonl",
        {
            "ts": int(time.time() * 1000),
            "level": level if level in LEVELS else "info",
            "category": _clip(category, 40),
            "message": _clip(message),
            "repo": _clip(repo, 300) if repo else None,
        },
    )


def read_logs(limit: int = 1000) -> list[dict[str, Any]]:
    return _read("logs.jsonl", limit)


def clear_logs() -> None:
    try:
        (journal_dir() / "logs.jsonl").unlink()
    except OSError:
        pass


# -- memory -------------------------------------------------------------------


def remember_turn(
    *,
    repo: str,
    chat: str,
    prompt: str,
    files: list[str],
    tools: dict[str, int],
    answer: str,
    ok: bool,
    started: float,
) -> None:
    """One finished Claude Code turn."""
    _append(
        "memory.jsonl",
        {
            "ts": int(time.time() * 1000),
            "repo": repo,
            "chat": chat,
            "prompt": _clip(prompt, 300),
            "files": files[:30],
            "tools": tools,
            "answer": _clip(answer, 500),
            "ok": ok,
            "seconds": round(max(0.0, time.time() - started), 1),
        },
    )


def read_memory(limit: int = 500) -> list[dict[str, Any]]:
    return _read("memory.jsonl", limit)


# -- last known plan usage ----------------------------------------------------


def save_usage(windows: dict[str, Any]) -> None:
    """Keep the ``unifiedWindows`` of the latest ``rate_limit_event``."""
    try:
        directory = journal_dir()
        directory.mkdir(parents=True, exist_ok=True)
        data = {"seen_at": int(time.time()), "windows": windows}
        with _lock:
            (directory / "usage.json").write_text(json.dumps(data), "utf-8")
    except (OSError, TypeError, ValueError):
        pass


def load_usage() -> Optional[dict[str, Any]]:
    try:
        data = json.loads((journal_dir() / "usage.json").read_text("utf-8"))
    except (OSError, ValueError):
        return None
    if isinstance(data, dict) and isinstance(data.get("windows"), dict):
        return data
    return None


# -- routes -------------------------------------------------------------------


class LogBody(BaseModel):
    category: str
    message: str
    level: str = "info"
    repo: Optional[str] = None


def create_journal_router() -> APIRouter:
    # Imported here: workspace_routes itself writes to the journal.
    from openjarvis.server.workspace_routes import guard

    router = APIRouter(tags=["journal"])

    @router.get("/v1/journal/logs")
    async def get_logs(request: Request, limit: int = 1000) -> dict[str, Any]:
        guard(request)
        return {"entries": read_logs(max(1, min(limit, 5000)))}

    @router.post("/v1/journal/logs")
    async def add_log(request: Request, body: LogBody) -> dict[str, Any]:
        guard(request)
        if not body.message.strip():
            raise HTTPException(status_code=400, detail="Empty message")
        log(body.category, body.message, repo=body.repo, level=body.level)
        return {"ok": True}

    @router.delete("/v1/journal/logs")
    async def delete_logs(request: Request) -> dict[str, Any]:
        guard(request)
        clear_logs()
        return {"ok": True}

    @router.get("/v1/journal/memory")
    async def get_memory(request: Request, limit: int = 500) -> dict[str, Any]:
        guard(request)
        return {"entries": read_memory(max(1, min(limit, 2000)))}

    @router.get("/v1/journal/info")
    async def info(request: Request) -> dict[str, Any]:
        """Where the journal and the repo memory live (paths only)."""
        guard(request)
        directory = journal_dir()
        return {
            "journal_dir": str(directory),
            "memory_dir": str(directory.parent / "memory"),
            "log_entries": len(read_logs(5000)),
            "task_entries": len(read_memory(2000)),
        }

    return router
