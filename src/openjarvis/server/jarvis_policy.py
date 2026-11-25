"""What the Jarvis assistant may do, and what needs the owner's approval.

Jarvis is a ``claude`` session with *no built-in tools*: it can only act through
the small set of tools defined here (served to it by ``jarvis_mcp``). Each tool
is either

* ``safe`` -- it only moves things around on the owner's screen or reads
  folders inside ``$HOME`` (open a repo, open a chat, send a prompt to a Claude
  Code chat, ...). Allowed without asking: the chat it talks to has its own
  Accept / Refuse buttons for anything risky; or
* ``sensitive`` -- it creates or removes things on disk (new repo, deletion).
  The owner must click Accept first.

The rule is enforced *in code*, in two independent places, so a clever prompt
cannot bypass it:

1. when ``claude`` asks to use a tool, :func:`decide` says allow / ask / deny
   (anything that is not a known Jarvis tool is denied);
2. when the tool is actually executed, the server checks that the owner's
   approval for exactly this call exists (:class:`Grants`) and consumes it.
"""

from __future__ import annotations

import hashlib
import json
import time
from typing import Any, Literal

PREFIX = "mcp__jarvis__"
GRANT_SECONDS = 120.0

Risk = Literal["safe", "sensitive"]
Where = Literal["screen", "server"]

PATH = {"type": "string", "description": "Absolute path, inside the home folder."}
CHAT = {
    "type": "string",
    "description": "Chat id, as returned by list_workspace or new_claude_tab.",
}

# name -> (risk, where it runs, description, JSON schema of the arguments)
TOOLS: dict[str, tuple[Risk, Where, str, dict[str, Any]]] = {
    "list_workspace": (
        "safe",
        "screen",
        "List the repositories open on screen, with their Claude Code chats and "
        "terminals. Use it first to know what exists.",
        {"type": "object", "properties": {}},
    ),
    "find_repos": (
        "safe",
        "server",
        "Search the home folder for git repositories whose name contains the "
        "text (at most 3 levels deep). Use it when the owner names a project "
        "without giving its path.",
        {
            "type": "object",
            "properties": {"query": {"type": "string"}},
            "required": ["query"],
        },
    ),
    "open_repo": (
        "safe",
        "screen",
        "Open an existing folder as a repository on screen and switch to it.",
        {"type": "object", "properties": {"path": PATH}, "required": ["path"]},
    ),
    "new_claude_tab": (
        "safe",
        "screen",
        "Open a new Claude Code chat tab in a repository (the active one when "
        "`repo` is omitted). If `prompt` is given it is sent right away.",
        {
            "type": "object",
            "properties": {
                "repo": PATH,
                "prompt": {"type": "string", "description": "First message."},
            },
        },
    ),
    "new_terminal": (
        "safe",
        "screen",
        "Open a new terminal tab in a repository (the active one when `repo` is "
        "omitted). It only opens the terminal; it does not type anything.",
        {"type": "object", "properties": {"repo": PATH}},
    ),
    "send_prompt": (
        "safe",
        "screen",
        "Send a message to a Claude Code chat. That chat shows its own "
        "Accept / Refuse buttons to the owner for edits and commands.",
        {
            "type": "object",
            "properties": {"chat": CHAT, "text": {"type": "string"}},
            "required": ["chat", "text"],
        },
    ),
    "read_chat": (
        "safe",
        "screen",
        "Read the state of a Claude Code chat: working or idle, whether it waits "
        "for the owner's approval, and its latest answer. `wait_seconds` (max "
        "120) waits until it has finished.",
        {
            "type": "object",
            "properties": {
                "chat": CHAT,
                "wait_seconds": {"type": "number"},
                "max_chars": {"type": "number"},
            },
            "required": ["chat"],
        },
    ),
    "create_repo": (
        "sensitive",
        "server",
        "Create a new folder and run `git init` in it. The owner must approve.",
        {"type": "object", "properties": {"path": PATH}, "required": ["path"]},
    ),
    "delete_path": (
        "sensitive",
        "server",
        "Delete a file or folder by moving it to ~/.jarvis-trash (recoverable). "
        "The owner must approve.",
        {"type": "object", "properties": {"path": PATH}, "required": ["path"]},
    ),
}

# How the two approvals are worded to the owner (screen and phone).
ASKS: dict[str, str] = {
    "create_repo": "create a new repository",
    "delete_path": "move to the trash",
}

PROMPT = (
    "You are Jarvis, the assistant that drives this developer workbench for its "
    "owner. You have no shell and no file access: you act only through the "
    "jarvis tools (list_workspace, find_repos, open_repo, new_claude_tab, "
    "send_prompt, read_chat, new_terminal, create_repo, delete_path). "
    "For coding work, open a Claude Code tab in the right repository and give it "
    "the instructions with send_prompt, then follow it with read_chat. "
    "Never say an action is done unless the tool result confirms it. "
    "create_repo and delete_path need the owner's approval, which the app asks "
    "for by itself: never try to get around a refusal. "
    "Answer briefly, in the language the owner writes in."
)


def short_name(tool_name: str) -> str:
    """``mcp__jarvis__open_repo`` -> ``open_repo`` (other names unchanged)."""
    return tool_name[len(PREFIX) :] if tool_name.startswith(PREFIX) else tool_name


def risk_of(tool_name: str) -> Risk | None:
    """Risk of a Jarvis tool, or None for anything that is not one."""
    if not tool_name.startswith(PREFIX):
        return None
    entry = TOOLS.get(short_name(tool_name))
    return entry[0] if entry else None


def decide(tool_name: str) -> Literal["allow", "ask", "deny"]:
    """What to do when ``claude`` asks to use *tool_name* in a Jarvis session."""
    risk = risk_of(tool_name)
    if risk == "safe":
        return "allow"
    if risk == "sensitive":
        return "ask"
    return "deny"  # built-in tools, other MCP servers, unknown names


def grant_key(tool_name: str, tool_input: Any) -> str:
    """Identity of one exact call: the tool and its arguments."""
    blob = json.dumps(tool_input or {}, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(f"{short_name(tool_name)}\n{blob}".encode()).hexdigest()


class Grants:
    """Owner approvals for sensitive calls: exact match, single use, expiring."""

    def __init__(self, ttl: float = GRANT_SECONDS) -> None:
        self.ttl = ttl
        self._items: dict[str, float] = {}

    def add(self, tool_name: str, tool_input: Any, now: float | None = None) -> None:
        now = time.monotonic() if now is None else now
        self._prune(now)
        self._items[grant_key(tool_name, tool_input)] = now + self.ttl

    def consume(
        self, tool_name: str, tool_input: Any, now: float | None = None
    ) -> bool:
        now = time.monotonic() if now is None else now
        self._prune(now)
        return self._items.pop(grant_key(tool_name, tool_input), None) is not None

    def _prune(self, now: float) -> None:
        for key in [k for k, until in self._items.items() if until <= now]:
            del self._items[key]
