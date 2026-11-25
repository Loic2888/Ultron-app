"""Workspace files: browse folders, open and save files of a local repo.

Reading and writing files from a web page is as sensitive as a shell, so every
request must pass the same gates as the terminal (see ``terminal_routes``):
loopback bind, loopback ``Host``, known ``Origin`` and the per-process token,
sent in the ``X-Jarvis-Token`` header (a custom header forces a CORS preflight,
which hostile origins fail).

Extra rules for files:

* every path is resolved (symlinks followed) and must stay inside ``$HOME``;
* nothing is ever deleted or renamed here (those actions need the human
  approval flow, which comes later);
* writes into a ``.git`` directory are refused;
* only UTF-8 text up to ``MAX_READ_BYTES`` is opened.
"""

from __future__ import annotations

import hmac
import os
import tempfile
from pathlib import Path
from typing import Any, Optional

try:
    from fastapi import APIRouter, HTTPException, Request
    from pydantic import BaseModel
except ImportError:  # pragma: no cover - fastapi is a server extra
    raise ImportError("fastapi is required for workspace routes")

from openjarvis.server import journal
from openjarvis.server.terminal_routes import (
    get_terminal_token,
    host_header_is_loopback,
    is_loopback_address,
    origin_allowed,
)

MAX_READ_BYTES = 2 * 1024 * 1024
MAX_WRITE_BYTES = 5 * 1024 * 1024
MAX_ENTRIES = 3000
TOKEN_HEADER = "x-jarvis-token"


# --------------------------------------------------------------------------
# Pure helpers (unit-tested)
# --------------------------------------------------------------------------


def resolve_inside_home(
    requested: Optional[str],
    home: Optional[Path] = None,
    *,
    must_exist: bool = True,
) -> Path:
    """Resolve ``requested`` and make sure it is inside ``$HOME``.

    Raises ``ValueError`` otherwise. With ``must_exist=False`` the final
    component may be missing (new file) but its parent must be a directory.
    """
    base = (home or Path.home()).resolve()
    if not requested:
        return base
    path = Path(requested).expanduser()
    if not path.is_absolute():
        path = base / path
    if must_exist:
        resolved = path.resolve()
        if not resolved.exists():
            raise ValueError("Path does not exist")
    else:
        name = path.name
        if not name or name in (".", "..") or "\x00" in name:
            raise ValueError("Invalid file name")
        parent = path.parent.resolve()
        if not parent.is_dir():
            raise ValueError("Parent folder does not exist")
        resolved = parent / name
        if resolved.is_symlink():
            resolved = resolved.resolve()
    if resolved != base and base not in resolved.parents:
        raise ValueError("Path must be inside your home directory")
    return resolved


def inside_git_dir(path: Path) -> bool:
    return ".git" in path.parts


def read_branch(repo: Path) -> Optional[str]:
    """Current branch (or short hash when detached), without running git."""
    dot_git = repo / ".git"
    try:
        if dot_git.is_file():  # worktree or submodule: "gitdir: <path>"
            text = dot_git.read_text(encoding="utf-8", errors="replace").strip()
            if not text.startswith("gitdir:"):
                return None
            git_dir = (repo / text[len("gitdir:") :].strip()).resolve()
        elif dot_git.is_dir():
            git_dir = dot_git
        else:
            return None
        head = (git_dir / "HEAD").read_text(encoding="utf-8", errors="replace").strip()
    except OSError:
        return None
    if head.startswith("ref: refs/heads/"):
        return head[len("ref: refs/heads/") :]
    return head[:8] or None


def describe_repo(path: Path) -> dict[str, Any]:
    is_git = (path / ".git").exists()
    return {
        "path": str(path),
        "name": path.name or str(path),
        "is_git": is_git,
        "branch": read_branch(path) if is_git else None,
    }


def list_entries(path: Path, *, dirs_only: bool = False) -> tuple[list[dict], bool]:
    """Folders first, then files, each sorted case-insensitively."""
    dirs: list[dict[str, Any]] = []
    files: list[dict[str, Any]] = []
    truncated = False
    with os.scandir(path) as it:
        for count, entry in enumerate(it):
            if count >= MAX_ENTRIES:
                truncated = True
                break
            try:
                is_dir = entry.is_dir(follow_symlinks=True)
            except OSError:
                continue
            if is_dir:
                item: dict[str, Any] = {"name": entry.name, "type": "dir"}
                if dirs_only:  # the folder picker highlights repositories
                    item["is_git"] = os.path.exists(os.path.join(entry.path, ".git"))
                dirs.append(item)
            elif not dirs_only:
                try:
                    size = entry.stat().st_size
                except OSError:
                    size = 0
                files.append({"name": entry.name, "type": "file", "size": size})
    key = lambda e: e["name"].lower()  # noqa: E731
    return sorted(dirs, key=key) + sorted(files, key=key), truncated


def mtime_token(path: Path) -> str:
    """Modification time as a string (nanoseconds overflow JS numbers)."""
    return str(path.stat().st_mtime_ns)


def decode_text(data: bytes) -> str:
    """UTF-8 text or ``ValueError`` (binary files are not opened)."""
    if b"\x00" in data[:8000]:
        raise ValueError("Binary file")
    try:
        return data.decode("utf-8")
    except UnicodeDecodeError as exc:
        raise ValueError("File is not UTF-8 text") from exc


def atomic_write(path: Path, data: bytes) -> None:
    """Write via a temp file in the same folder, keeping the file mode."""
    mode = None
    try:
        mode = path.stat().st_mode & 0o777
    except OSError:
        pass
    fd, tmp = tempfile.mkstemp(dir=str(path.parent), prefix=".jarvis-save-")
    try:
        with os.fdopen(fd, "wb") as handle:
            handle.write(data)
        if mode is not None:
            os.chmod(tmp, mode)
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


# --------------------------------------------------------------------------
# Routes
# --------------------------------------------------------------------------


class WriteBody(BaseModel):
    path: str
    content: str
    # ``mtime`` returned by the last read/save. When given and the file has
    # changed on disk since, the write is refused (409) so a stale editor
    # buffer never silently overwrites what Claude Code (or you) just saved.
    expected_mtime: Optional[str] = None


def _forbid(reason: str) -> HTTPException:
    return HTTPException(status_code=403, detail=reason)


def guard(request: Request) -> None:
    """All the gates, in the order that leaks the least."""
    app = request.app
    if os.name != "posix" or not is_loopback_address(
        getattr(app.state, "bind_host", None)
    ):
        raise _forbid("The workspace is only available when the server is local")
    host = request.headers.get("host")
    if not host_header_is_loopback(host):
        raise _forbid("Unexpected Host header")
    allowed = list(getattr(app.state, "allowed_origins", []) or [])
    if not origin_allowed(request.headers.get("origin"), host, allowed):
        raise _forbid("Origin not allowed")
    token = request.headers.get(TOKEN_HEADER, "")
    expected = get_terminal_token(app)
    if not hmac.compare_digest(token.encode(), expected.encode()):
        raise _forbid("Missing or wrong token")


def _bad(exc: ValueError, status: int = 400) -> HTTPException:
    return HTTPException(status_code=status, detail=str(exc))


def create_workspace_router() -> APIRouter:
    router = APIRouter(tags=["workspace"])

    @router.get("/v1/workspace/home")
    async def workspace_home(request: Request) -> dict[str, Any]:
        guard(request)
        return {"home": str(Path.home().resolve())}

    @router.get("/v1/workspace/repo")
    async def workspace_repo(request: Request, path: str) -> dict[str, Any]:
        guard(request)
        try:
            resolved = resolve_inside_home(path)
        except ValueError as exc:
            raise _bad(exc, 403 if "inside" in str(exc) else 404)
        if not resolved.is_dir():
            raise HTTPException(status_code=400, detail="Not a folder")
        return describe_repo(resolved)

    @router.get("/v1/workspace/tree")
    async def workspace_tree(
        request: Request, path: str = "", dirs_only: bool = False
    ) -> dict[str, Any]:
        guard(request)
        try:
            resolved = resolve_inside_home(path)
        except ValueError as exc:
            raise _bad(exc, 403 if "inside" in str(exc) else 404)
        if not resolved.is_dir():
            raise HTTPException(status_code=400, detail="Not a folder")
        try:
            entries, truncated = list_entries(resolved, dirs_only=dirs_only)
        except PermissionError:
            raise HTTPException(status_code=403, detail="Folder is not readable")
        return {"path": str(resolved), "entries": entries, "truncated": truncated}

    @router.get("/v1/workspace/file")
    async def workspace_read(request: Request, path: str) -> dict[str, Any]:
        guard(request)
        try:
            resolved = resolve_inside_home(path)
        except ValueError as exc:
            raise _bad(exc, 403 if "inside" in str(exc) else 404)
        if not resolved.is_file():
            raise HTTPException(status_code=400, detail="Not a file")
        size = resolved.stat().st_size
        if size > MAX_READ_BYTES:
            raise HTTPException(
                status_code=413, detail="File is too large to open (over 2 MB)"
            )
        try:
            text = decode_text(resolved.read_bytes())
        except ValueError as exc:
            raise _bad(exc, 415)
        except PermissionError:
            raise HTTPException(status_code=403, detail="File is not readable")
        return {
            "path": str(resolved),
            "content": text,
            "size": size,
            "mtime": mtime_token(resolved),
        }

    @router.put("/v1/workspace/file")
    async def workspace_write(request: Request, body: WriteBody) -> dict[str, Any]:
        guard(request)
        try:
            resolved = resolve_inside_home(body.path, must_exist=False)
        except ValueError as exc:
            raise _bad(exc, 403 if "inside" in str(exc) else 400)
        if inside_git_dir(resolved):
            raise _forbid("Files inside .git cannot be written")
        if resolved.is_dir():
            raise HTTPException(status_code=400, detail="Path is a folder")
        data = body.content.encode("utf-8")
        if len(data) > MAX_WRITE_BYTES:
            raise HTTPException(status_code=413, detail="Content is too large")
        if body.expected_mtime is not None and resolved.exists():
            if mtime_token(resolved) != body.expected_mtime:
                raise HTTPException(
                    status_code=409,
                    detail="The file changed on disk since you opened it",
                )
        try:
            atomic_write(resolved, data)
        except PermissionError:
            raise HTTPException(status_code=403, detail="File is not writable")
        journal.log("fichier", f"Fichier enregistré : {resolved}")
        return {
            "path": str(resolved),
            "size": len(data),
            "mtime": mtime_token(resolved),
        }

    return router
