"""Rules of the "Custom" permission mode of a Claude Code window.

"Custom" behaves like "Accept edits" for file edits (an edit of a file inside the
repo goes through), and in addition the owner can tick rules that let some shell
commands run **without asking**: read-only commands, tests and builds, git and
pull-request commands, any command that is not destructive, and his own lists of
commands / deletions.

These rules are enforced here, in the server, when ``claude`` asks for a tool
(``can_use_tool``); a rule that is not ticked changes nothing and the usual
Accept / Refuse card is shown. Everything is off by default.

``claude`` itself runs in its plain "ask" mode for Custom: its own "accept edits"
mode would also let ``rm``, ``mv`` and ``cp`` through without asking, which a
deletion rule must be the only way to allow. File edits are therefore decided
here: allowed inside the repo (never inside ``.git``), asked anywhere else.

Safety of the matching:

* a rule only matches a **single simple command**: no ``;``, ``&``, ``|``,
  redirection, command substitution or ``$`` outside quotes, no newline. So
  ``git status; rm -rf ~`` never matches the "git status" rule;
* a pattern matches the command word for word; a trailing ``*`` accepts extra
  arguments. For read-only commands and for the deletion list those extra
  arguments may not leave the repo (no absolute path, ``~`` or ``..``);
* "any command" still asks for deletions, moves, ``sudo``, ``git push`` and
  friends, and pipes into a shell; those need an explicit rule;
* ``git push`` is allowed by the git rule only for a named, non-protected
  branch without any force or delete option;
* a Bash call that asks to leave the sandbox is never auto-allowed.
"""

from __future__ import annotations

import fnmatch
import re
import shlex
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any, Optional

from openjarvis.server.repo_memory import is_inside

# Built-in tools that only look (no side effect). Read / Glob / Grep also have to
# stay inside the repo.
LOOKUP_TOOLS = ("ToolSearch", "TodoWrite", "Read", "Glob", "Grep")
PATH_TOOLS = ("Read", "Glob", "Grep")
# An MCP tool whose name starts with one of these words only reads.
MCP_READ_VERBS = frozenset(
    {
        "get",
        "list",
        "search",
        "read",
        "find",
        "query",
        "fetch",
        "whoami",
        "describe",
        "view",
    }
)
EDIT_TOOLS = ("Edit", "MultiEdit", "Write", "NotebookEdit")
MAX_PATTERNS = 50
MAX_PATTERN_CHARS = 200
PROTECTED_BRANCHES = ("main", "master", "develop", "production", "prod")

# What "any command" must still ask about.
DESTRUCTIVE = re.compile(
    r"(^|[\s;&|(`/\\])(rm|rmdir|unlink|shred|dd|mkfs\S*|sudo|su|chmod|chown|mv|truncate)"
    r"(\s|$)"
    r"|\bgit\b.*\b(push|reset|clean|restore|rebase|filter-branch|update-ref)\b"
    r"|\bgit\b.*\bcheckout\s+(-f|--force|--)"
    r"|\bgit\b.*\bbranch\s+-[dD]\b"
    r"|\bfind\b.*\s-(delete|exec)\b"
    r"|\|\s*(sudo\s+)?(sh|bash|zsh|dash)\b"
    r"|(?<![\d&])>>?\s*(?!/dev/null\b)(?!&)\S"
    r"|\b:\(\)\s*\{"
)

READONLY = (
    "ls *",
    "pwd",
    "cat *",
    "head *",
    "tail *",
    "wc *",
    "grep *",
    "rg *",
    "git status *",
    "git diff *",
    "git log *",
    "git show *",
    "git rev-parse *",
    "git remote -v",
    "git branch --show-current",
    "which *",
    "date",
    "uname *",
    "sort *",
    "uniq *",
    "diff *",
    "file *",
    "stat *",
    "tree *",
    "du *",
    "df *",
    "jq *",
    "git branch",
    "git branch -a",
    "git branch --list *",
    "git stash list",
    "git ls-files *",
    "git blame *",
    "git tag",
    "node --version",
    "python --version",
    "python3 --version",
)
BUILD_TEST = (
    "pytest *",
    "uv run pytest *",
    "uv run ruff check *",
    "uv run ruff format --check *",
    "ruff check *",
    "npm test *",
    "npm run test *",
    "npm run lint *",
    "npm run build",
    "npm run typecheck",
    "npx tsc *",
    "npx vitest *",
    "cargo test *",
    "cargo check *",
    "cargo build *",
    "cargo clippy *",
    "go test *",
    "go build *",
    "make test",
)
INSTALL = (
    "npm install *",
    "npm i *",
    "npm ci",
    "pnpm install *",
    "yarn install",
    "pip install *",
    "uv sync *",
    "uv add *",
    "uv pip install *",
    "cargo fetch",
    "go mod download",
    "go mod tidy",
)
FILES = (
    "mkdir *",
    "touch *",
)
DOCKER = (
    "docker ps *",
    "docker images *",
    "docker logs *",
    "docker build *",
    "docker compose ps *",
    "docker compose logs *",
    "docker compose up *",
    "docker compose build *",
)
GIT_PR = (
    "git add *",
    "git commit *",
    "git checkout -b *",
    "git switch -c *",
    "git fetch *",
    "gh pr create *",
    "gh pr view *",
    "gh pr list *",
    "gh pr status",
    "gh pr checks *",
    "gh pr diff *",
    "gh pr comment *",
)

# Labels shown to the owner (the screen has the same texts).
GROUPS: dict[str, tuple[str, tuple[str, ...]]] = {
    "readonly": ("Read-only commands", READONLY),
    "build_test": ("Tests, lint and builds", BUILD_TEST),
    "git_pr": ("Git and pull requests", GIT_PR),
    "install": ("Install dependencies", INSTALL),
    "files": ("Create folders and files", FILES),
    "docker": ("Docker (look, build, start)", DOCKER),
}


@dataclass
class CustomRules:
    readonly: bool = False
    build_test: bool = False
    git_pr: bool = False
    install: bool = False
    files: bool = False
    docker: bool = False
    any_command: bool = False
    other_tools: bool = False
    allow_tools: list[str] = field(default_factory=list)
    allow_commands: list[str] = field(default_factory=list)
    allow_deletes: list[str] = field(default_factory=list)

    def as_dict(self) -> dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, data: Any) -> "CustomRules":
        """Build from untrusted JSON; anything odd is ignored (rule stays off)."""
        if not isinstance(data, dict):
            return cls()

        def flag(name: str) -> bool:
            return data.get(name) is True

        def patterns(name: str) -> list[str]:
            raw = data.get(name)
            out: list[str] = []
            if isinstance(raw, list):
                for item in raw[:MAX_PATTERNS]:
                    if isinstance(item, str):
                        text = " ".join(item.split())
                        if text and len(text) <= MAX_PATTERN_CHARS and text not in out:
                            out.append(text)
            return out

        return cls(
            readonly=flag("readonly"),
            build_test=flag("build_test"),
            git_pr=flag("git_pr"),
            install=flag("install"),
            files=flag("files"),
            docker=flag("docker"),
            any_command=flag("any_command"),
            other_tools=flag("other_tools"),
            allow_tools=patterns("allow_tools"),
            allow_commands=patterns("allow_commands"),
            allow_deletes=patterns("allow_deletes"),
        )


def _unsafe_outside_quotes(command: str) -> bool:
    """True if the command chains, redirects or expands anything (outside quotes)."""
    if "\n" in command or "\r" in command or "\x00" in command:
        return True
    quote = ""
    i = 0
    while i < len(command):
        ch = command[i]
        if quote == "'":
            if ch == "'":
                quote = ""
        elif quote == '"':
            if ch == "\\":
                i += 1  # an escaped character
            elif ch == '"':
                quote = ""
            elif ch in "$`":
                return True
        else:
            if ch in "'\"":
                quote = ch
            elif ch == "\\":
                i += 1
            elif ch in ";&|<>`$(){}":
                return True
        i += 1
    return bool(quote)  # an unclosed quote is not a command we understand


def simple_tokens(command: str) -> Optional[list[str]]:
    """Words of a single simple command, or None when it is anything more."""
    if not command.strip() or _unsafe_outside_quotes(command):
        return None
    try:
        tokens = shlex.split(command)
    except ValueError:
        return None
    return tokens or None


def _stays_in_repo(arg: str) -> bool:
    if arg.startswith(("/", "~")) or arg.startswith("-") and "=/" in arg:
        return False
    return ".." not in arg.replace("\\", "/").split("/")


def matches(pattern: str, tokens: list[str], *, confine: bool = False) -> bool:
    """Word-for-word match; a trailing ``*`` accepts extra arguments."""
    try:
        want = shlex.split(pattern)
    except ValueError:
        return False
    if not want:
        return False
    if want[-1] == "*":
        head = want[:-1]
        if tokens[: len(head)] != head or len(tokens) < len(head):
            return False
        extra = tokens[len(head) :]
        return all(_stays_in_repo(a) for a in extra) if confine else True
    return tokens == want


def _safe_push(tokens: list[str]) -> bool:
    """``git push [-u] <remote> <branch>`` for a branch that is not protected."""
    if tokens[:2] != ["git", "push"]:
        return False
    rest = [t for t in tokens[2:] if t not in ("-u", "--set-upstream")]
    if len(rest) != 2 or any(t.startswith("-") for t in rest):
        return False
    remote, branch = rest
    if ":" in branch or "+" in branch or branch.startswith("refs/") or "/" in remote:
        return False
    if branch == "HEAD" or branch.lower() in PROTECTED_BRANCHES:
        return False
    return bool(re.fullmatch(r"[\w.\-/]+", branch))


def _edit_inside_repo(tool_input: dict[str, Any], cwd: str) -> bool:
    path = tool_input.get("file_path") or tool_input.get("notebook_path")
    if not isinstance(path, str) or not is_inside(path, Path(cwd)):
        return False
    import os

    inside = os.path.relpath(os.path.realpath(path), os.path.realpath(cwd))
    return ".git" not in inside.split(os.sep)


def _other_tool_allowed(
    rules: CustomRules, tool_name: Any, tool_input: dict[str, Any], cwd: Optional[str]
) -> Optional[str]:
    """Tools that are neither Bash nor a file edit: MCP tools, Read, ToolSearch…"""
    if not isinstance(tool_name, str) or not tool_name:
        return None
    for pattern in rules.allow_tools:
        if pattern.strip("*") and fnmatch.fnmatchcase(tool_name, pattern):
            return "your list of allowed tools"
    if not rules.other_tools:
        return None
    if tool_name in LOOKUP_TOOLS:
        if tool_name in PATH_TOOLS:
            path = tool_input.get("file_path") or tool_input.get("path")
            if path is not None and not (
                isinstance(path, str) and cwd and is_inside(path, Path(cwd))
            ):
                return None
        return "reading tools"
    parts = tool_name.split("__", 2)
    if len(parts) == 3 and parts[0] == "mcp":
        if parts[2].split("_", 1)[0] in MCP_READ_VERBS:
            return "read-only MCP tools"
    return None


def allows(
    rules: CustomRules, tool_name: Any, tool_input: Any, cwd: Optional[str] = None
) -> Optional[str]:
    """Why this tool call may run without asking, or None (then the owner is asked)."""
    if not isinstance(tool_input, dict):
        return None
    if tool_name in EDIT_TOOLS:
        if cwd and _edit_inside_repo(tool_input, cwd):
            return "edit inside the repo"
        return None
    if tool_name != "Bash":
        return _other_tool_allowed(rules, tool_name, tool_input, cwd)
    command = tool_input.get("command")
    if not isinstance(command, str) or tool_input.get("dangerouslyDisableSandbox"):
        return None
    tokens = simple_tokens(command)
    if tokens is not None:
        if any(matches(p, tokens, confine=True) for p in rules.allow_deletes):
            return "your list of allowed deletions"
        if any(matches(p, tokens) for p in rules.allow_commands):
            return "your list of allowed commands"
        if rules.readonly and any(matches(p, tokens, confine=True) for p in READONLY):
            return GROUPS["readonly"][0]
        if rules.build_test and any(matches(p, tokens) for p in BUILD_TEST):
            return GROUPS["build_test"][0]
        if rules.install and any(matches(p, tokens) for p in INSTALL):
            return GROUPS["install"][0]
        if rules.files and any(matches(p, tokens, confine=True) for p in FILES):
            return GROUPS["files"][0]
        if rules.docker and any(matches(p, tokens) for p in DOCKER):
            return GROUPS["docker"][0]
        if rules.git_pr and (
            any(matches(p, tokens) for p in GIT_PR) or _safe_push(tokens)
        ):
            return GROUPS["git_pr"][0]
    if rules.any_command and not DESTRUCTIVE.search(command):
        return "any command (except destructive ones)"
    return None
