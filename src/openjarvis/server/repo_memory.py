"""One memory folder per repo, kept by the Claude Code windows.

``<config dir>/memory/<repo>/`` holds plain Markdown files that the Claude Code
window working on that repo reads at the start of a task and updates at the end:

* ``INDEX.md``            one line per entry below (what it is, link): read first;
* ``notes.md``            what the repo is: stack, structure, commands, conventions;
* ``fonctionne/``         one file per thing that works, named after it
  (``lancer-les-tests-python.md``): exact command, approach, setting, date;
* ``ne-fonctionne-pas/``  one file per failure or trap, named after it
  (``port-8000-pris-par-docker.md``): what was tried, why it fails, the fix.

(Older repos may still hold flat ``fonctionne.md`` / ``ne-fonctionne-pas.md``.)

Later an agent can read the "what works" files of every repo and turn them into
reusable skills. Everything stays on this machine.

Safety: the only thing a Claude Code window may do *without asking* is read and
write inside **its own repo's memory folder** (``allows``): the path is resolved
(symlinks followed) and must stay inside that folder. Anything else still goes to
the Accept / Refuse card.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import time
from pathlib import Path
from typing import Any, Optional

try:
    from fastapi import APIRouter, HTTPException, Request
except ImportError:  # pragma: no cover - fastapi is a server extra
    raise ImportError("fastapi is required for memory routes")

from openjarvis.server import journal

MEMORY_TOOLS = ("Read", "Write", "Edit", "MultiEdit")
MAX_FILE_BYTES = 200_000
META = "repo.json"

SEED_FILES: dict[str, str] = {
    "INDEX.md": (
        "# Index de la mémoire du repo\n\n"
        "Une ligne par fichier : `dossier/nom.md` — de quoi il parle. À lire en "
        "premier.\n"
    ),
    "notes.md": (
        "# Notes du repo\n\n"
        "Ce qu'il faut savoir pour travailler ici : stack, structure, commandes "
        "utiles, conventions.\n"
    ),
}
SEED_DIRS = ("fonctionne", "ne-fonctionne-pas")


def memory_root() -> Path:
    """``…/memory`` next to the journal (so tests and OPENJARVIS_HOME follow)."""
    return journal.journal_dir().parent / "memory"


def _slug(name: str) -> str:
    text = re.sub(r"[^A-Za-z0-9._-]+", "-", name).strip("-.")
    return text[:60] or "repo"


def _meta_path(directory: Path) -> Path:
    return directory / META


def _read_meta(directory: Path) -> Optional[dict[str, Any]]:
    try:
        data = json.loads(_meta_path(directory).read_text("utf-8"))
    except (OSError, ValueError):
        return None
    return data if isinstance(data, dict) else None


def ensure_repo_memory(repo: str | Path) -> Path:
    """The memory folder of *repo*, created (with its starter files) if missing.

    Named after the repo folder; if another repo already uses that name the
    folder gets a short hash of the path, so two repos never share a memory.
    """
    repo_path = str(Path(repo).resolve())
    root = memory_root()
    base = _slug(Path(repo_path).name)
    suffix = hashlib.sha256(repo_path.encode()).hexdigest()[:6]
    for name in (base, f"{base}-{suffix}"):
        directory = root / name
        meta = _read_meta(directory)
        if meta is not None and meta.get("path") != repo_path:
            continue  # taken by another repo
        if meta is None and directory.exists() and any(directory.iterdir()):
            continue  # a folder we did not create: leave it alone
        directory.mkdir(parents=True, exist_ok=True)
        if meta is None:
            _meta_path(directory).write_text(
                json.dumps({"path": repo_path, "created": int(time.time())}), "utf-8"
            )
        for sub in SEED_DIRS:
            (directory / sub).mkdir(exist_ok=True)
        for fname, text in SEED_FILES.items():
            target = directory / fname
            if not target.exists():
                target.write_text(text, "utf-8")
        return directory
    raise OSError("Could not choose a memory folder for this repo")


def prompt_for(directory: Path) -> str:
    """What the Claude Code window is told about its repo's memory."""
    return (
        "MÉMOIRE DU REPO (gérée par Jarvis). Dossier : "
        f"{directory}\n"
        "Organisation : INDEX.md (une ligne par fichier), notes.md (stack, "
        "structure, commandes, conventions), fonctionne/ (un fichier par chose qui "
        "marche), ne-fonctionne-pas/ (un fichier par échec ou piège).\n"
        "1. Au début de la tâche, lis INDEX.md et notes.md (outil Read), puis les "
        "fichiers qui concernent la tâche.\n"
        "2. DÈS QU'UNE CHOSE FONCTIONNE (commande, approche, réglage vérifiés) ou "
        "ÉCHOUE (erreur, piège, impasse), écris-le tout de suite, sans attendre la "
        "fin et sans demander : un fichier par sujet, dans fonctionne/ ou "
        "ne-fonctionne-pas/.\n"
        "3. Nom du fichier : explicite, en minuscules, mots séparés par des tirets, "
        "terminé par .md. Il dit CE QUE C'EST et le contexte, pour qu'une IA le "
        "retrouve sans l'ouvrir : lancer-les-tests-python.md, "
        "port-8000-pris-par-docker.md, build-front-exige-npm-11.md. Jamais "
        "notes2.md, divers.md, tmp.md.\n"
        "4. Contenu : titre, puis Contexte / Commande ou approche exacte / "
        "Résultat / Cause et solution (pour un échec) / Date (AAAA-MM-JJ). Court "
        "et précis, en français.\n"
        "5. Après chaque création, renommage ou suppression de fichier, mets "
        "INDEX.md à jour (une ligne `dossier/nom.md — résumé`).\n"
        "6. Si le sujet existe déjà, modifie le fichier existant plutôt que d'en "
        "créer un second ; si un échec a été résolu, déplace l'entrée vers "
        "fonctionne/ ; retire ce qui est devenu faux. Les anciens fichiers plats "
        "fonctionne.md / ne-fonctionne-pas.md, s'ils existent, sont à découper "
        "dans les dossiers puis à vider.\n"
        "7. N'y écris jamais de secret (clé, jeton, mot de passe) ni de donnée "
        "personnelle.\n"
        "8. Ces fichiers serviront à fabriquer des compétences réutilisables : "
        "n'écris que des choses vérifiées. Ne touche à rien d'autre dans ce "
        "dossier."
    )


def is_inside(path: str, directory: Path) -> bool:
    """True when *path* (absolute, symlinks followed) is within *directory*."""
    if not path or not os.path.isabs(path):
        return False
    try:
        real = os.path.realpath(path)
        root = os.path.realpath(directory)
        return os.path.commonpath([real, root]) == root and real != root
    except ValueError:
        return False


def allows(tool_name: Any, tool_input: Any, directory: Optional[Path]) -> bool:
    """May this tool call run without asking? Only the repo's own memory files."""
    if directory is None or tool_name not in MEMORY_TOOLS:
        return False
    if not isinstance(tool_input, dict):
        return False
    path = str(tool_input.get("file_path") or "")
    if not path.endswith(".md"):  # never repo.json or anything but notes
        return False
    return is_inside(path, directory)


# -- reading (for the Memory page) --------------------------------------------


def list_repos() -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    root = memory_root()
    try:
        entries = sorted(root.iterdir())
    except OSError:
        return out
    for directory in entries:
        meta = _read_meta(directory) if directory.is_dir() else None
        if meta is None:
            continue
        files = []
        found = list(directory.glob("*.md")) + list(directory.glob("*/*.md"))
        for item in sorted(found, key=lambda p: (p.parent != directory, str(p))):
            if (
                item.is_file()
                and not item.is_symlink()
                and not item.parent.is_symlink()
            ):
                stat = item.stat()
                files.append(
                    {
                        "name": item.relative_to(directory).as_posix(),
                        "size": stat.st_size,
                        "modified": int(stat.st_mtime * 1000),
                    }
                )
        out.append(
            {
                "slug": directory.name,
                "repo": str(meta.get("path") or ""),
                "name": Path(str(meta.get("path") or directory.name)).name,
                "files": files,
            }
        )
    return out


def read_file(slug: str, name: str) -> Optional[str]:
    """Text of one memory file; None unless it is a listed regular .md file."""
    for repo in list_repos():
        if repo["slug"] == slug and any(f["name"] == name for f in repo["files"]):
            path = memory_root() / slug / name
            try:
                if path.stat().st_size > MAX_FILE_BYTES:
                    return None
                return path.read_text("utf-8", errors="replace")
            except OSError:
                return None
    return None


def create_repo_memory_router() -> APIRouter:
    from openjarvis.server.workspace_routes import guard

    router = APIRouter(tags=["memory"])

    @router.get("/v1/memory/repos")
    async def get_repos(request: Request) -> dict[str, Any]:
        guard(request)
        return {"repos": list_repos()}

    @router.get("/v1/memory/repos/{slug}/files/{name:path}")
    async def get_file(request: Request, slug: str, name: str) -> dict[str, Any]:
        guard(request)
        text = read_file(slug, name)
        if text is None:
            raise HTTPException(status_code=404, detail="No such memory file")
        return {"slug": slug, "name": name, "text": text}

    return router
