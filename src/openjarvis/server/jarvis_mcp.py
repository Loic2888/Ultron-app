"""Tiny MCP server (stdio) that gives the Ultron ``claude`` session its tools.

``claude`` starts this program itself (see ``claude_routes``) and talks to it in
newline-delimited JSON-RPC 2.0 on stdin/stdout. Each ``tools/call`` is forwarded
to the local Ultron server (``POST /v1/jarvis/tool``) with the secret of this
one Ultron session; the server decides what really happens, so this process
holds no power of its own.

Environment: ``JARVIS_API`` (``http://127.0.0.1:<port>``) and ``JARVIS_SECRET``.
"""

from __future__ import annotations

import json
import os
import sys
import urllib.error
import urllib.request
from typing import Any, Callable, Optional

from openjarvis.server.jarvis_policy import TOOLS

SERVER_INFO = {"name": "jarvis", "version": "1.0"}
DEFAULT_PROTOCOL = "2024-11-05"
HTTP_TIMEOUT = 200.0  # the longest tool (read_chat with a wait) stays below this

ToolCaller = Callable[[str, dict[str, Any]], dict[str, Any]]


def tool_list() -> list[dict[str, Any]]:
    return [
        {"name": name, "description": desc, "inputSchema": schema}
        for name, (_risk, _where, desc, schema) in TOOLS.items()
    ]


def call_api(name: str, arguments: dict[str, Any]) -> dict[str, Any]:
    """Forward one tool call to the Ultron server; always returns a dict."""
    base = os.environ.get("JARVIS_API", "")
    secret = os.environ.get("JARVIS_SECRET", "")
    if not base or not secret:
        return {"ok": False, "error": "Ultron server address is not configured."}
    req = urllib.request.Request(
        f"{base}/v1/jarvis/tool",
        data=json.dumps({"name": name, "input": arguments}).encode(),
        headers={"Content-Type": "application/json", "X-Jarvis-Secret": secret},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=HTTP_TIMEOUT) as res:  # noqa: S310
            return json.loads(res.read().decode() or "{}")
    except urllib.error.HTTPError as exc:
        try:
            detail = json.loads(exc.read().decode()).get("detail")
        except (ValueError, AttributeError):
            detail = None
        return {"ok": False, "error": detail or f"The server answered {exc.code}."}
    except (urllib.error.URLError, OSError, ValueError) as exc:
        return {"ok": False, "error": f"Cannot reach the Ultron server: {exc}"}


def handle(message: dict[str, Any], caller: ToolCaller = call_api) -> Optional[dict]:
    """Answer one JSON-RPC message (None for notifications)."""
    method = message.get("method")
    mid = message.get("id")
    if mid is None:  # notification: nothing to answer
        return None

    def ok(result: Any) -> dict[str, Any]:
        return {"jsonrpc": "2.0", "id": mid, "result": result}

    def err(code: int, text: str) -> dict[str, Any]:
        return {"jsonrpc": "2.0", "id": mid, "error": {"code": code, "message": text}}

    if method == "initialize":
        params = message.get("params") or {}
        return ok(
            {
                "protocolVersion": params.get("protocolVersion") or DEFAULT_PROTOCOL,
                "capabilities": {"tools": {}},
                "serverInfo": SERVER_INFO,
            }
        )
    if method == "ping":
        return ok({})
    if method == "tools/list":
        return ok({"tools": tool_list()})
    if method == "tools/call":
        params = message.get("params") or {}
        name = params.get("name")
        args = params.get("arguments") or {}
        if name not in TOOLS or not isinstance(args, dict):
            return err(-32602, f"Unknown tool: {name}")
        outcome = caller(name, args)
        good = bool(outcome.get("ok"))
        payload = outcome.get("result") if good else outcome.get("error")
        text = payload if isinstance(payload, str) else json.dumps(payload)
        return ok({"content": [{"type": "text", "text": text}], "isError": not good})
    return err(-32601, f"Method not found: {method}")


def main() -> None:  # pragma: no cover - exercised through a subprocess test
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            message = json.loads(line)
        except ValueError:
            continue
        if not isinstance(message, dict):
            continue
        reply = handle(message)
        if reply is not None:
            sys.stdout.write(json.dumps(reply) + "\n")
            sys.stdout.flush()


if __name__ == "__main__":  # pragma: no cover
    main()
