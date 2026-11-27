"""Talk to Ultron from a phone, through a private Telegram bot.

Safety design (the phone is the riskiest door into the app):

* **No port is opened.** The server only *calls out* to Telegram (long polling),
  so nothing on the network can reach the app because of this feature.
* **One person only.** An update is handled only when the sender, the chat and
  the chat type all match the owner's numeric Telegram id and the chat is a
  private one. Everyone else is ignored without any answer (the bot does not
  even confirm that it exists).
* **Off unless configured.** It needs ``OPENULTRON_PHONE_BOT_TOKEN`` and
  ``OPENULTRON_PHONE_OWNER_ID`` (the older ``OPENJARVIS_PHONE_*`` names still
  work). These ``OPENULTRON_*`` / ``OPENJARVIS_*`` variables are removed
  from the environment of every terminal and ``claude`` child.
* **Same rules as the screen.** The phone talks to an Ultron session: it has no
  shell and every sensitive action (create / delete) shows up as a message with
  Accept / Refuse buttons that only the owner can press. The Claude Code chats
  it opens keep asking for approval on the PC screen.
* **Caps** on what can be launched remotely: messages per hour, message size,
  a stop when the subscription windows are nearly used up, and a time limit per
  task.
* **No stale orders.** Messages that arrived while the server was off are
  discarded at start: a deletion typed yesterday must not run today.
* The bot token is part of Telegram's URLs, so request logging is silenced and
  errors never contain the URL.

What goes through Telegram's servers is the text of your messages and Ultron's
answers. Nothing else leaves the machine because of this feature.
"""

from __future__ import annotations

import asyncio
import logging
import os
import secrets
import time
from collections import deque
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Mapping, Optional

import httpx
from fastapi import APIRouter, Request

from openjarvis.server import jarvis_policy
from openjarvis.server.claude_routes import SessionLimit, make_session, manager_of

logger = logging.getLogger("openjarvis.phone")

TELEGRAM_API = "https://api.telegram.org"
POLL_SECONDS = 25
MAX_REPLY_CHARS = 3800  # Telegram refuses more than 4096 per message

HELP = (
    "Ultron on your phone.\n\n"
    "Write what you want done (open a project, start a Claude Code chat, "
    "send it instructions...). Creating or deleting anything asks you first, "
    "with buttons.\n\n"
    "/status  usage and state\n"
    "/stop    interrupt the current task\n"
    "/new     start a fresh conversation\n"
    "/help    this text"
)


@dataclass(frozen=True)
class PhoneConfig:
    token: str = field(repr=False)  # never printed
    owner_id: int
    max_per_hour: int = 40
    max_text: int = 2000
    five_hour_stop: float = 0.85  # refuse new tasks above this share of the 5 h window
    week_stop: float = 0.95
    turn_timeout: float = 900.0
    api_base: str = TELEGRAM_API

    @classmethod
    def from_env(cls, environ: Mapping[str, str]) -> Optional["PhoneConfig"]:
        def lookup(suffix: str) -> str:
            # The OPENULTRON_ name wins; the old OPENJARVIS_ name is a fallback.
            for prefix in ("OPENULTRON_PHONE_", "OPENJARVIS_PHONE_"):
                value = environ.get(prefix + suffix, "").strip()
                if value:
                    return value
            return ""

        token = lookup("BOT_TOKEN")
        raw_owner = lookup("OWNER_ID")
        if not token or not raw_owner.lstrip("-").isdigit():
            return None
        owner = int(raw_owner)
        if owner <= 0:  # a negative id is a group, never a person
            return None

        def number(name: str, default: float) -> float:
            try:
                value = float(lookup(name) or default)
            except ValueError:
                return default
            return value if value > 0 else default

        return cls(
            token=token,
            owner_id=owner,
            max_per_hour=int(number("MAX_PER_HOUR", 40)),
            max_text=int(number("MAX_TEXT", 2000)),
            turn_timeout=number("TURN_SECONDS", 900.0),
        )


class TelegramError(Exception):
    """A Telegram call failed. The message never contains the bot token."""


class TelegramApi:
    def __init__(
        self,
        token: str,
        base: str = TELEGRAM_API,
        client: Optional[httpx.AsyncClient] = None,
    ) -> None:
        self._url = f"{base}/bot{token}/"
        self._client = client or httpx.AsyncClient(timeout=POLL_SECONDS + 15)

    async def call(self, method: str, **params: Any) -> Any:
        try:
            res = await self._client.post(self._url + method, json=params)
            data = res.json()
        except httpx.HTTPError as exc:
            # str(exc) can contain the URL, which holds the token.
            raise TelegramError(f"network error ({type(exc).__name__})") from None
        except ValueError:
            raise TelegramError(f"bad answer (HTTP {res.status_code})") from None
        if not data.get("ok"):
            raise TelegramError(str(data.get("description") or "Telegram refused"))
        return data.get("result")

    async def get_updates(self, offset: Optional[int], timeout: int) -> list[dict]:
        params: dict[str, Any] = {
            "timeout": timeout,
            "allowed_updates": ["message", "callback_query"],
        }
        if offset is not None:
            params["offset"] = offset
        return await self.call("getUpdates", **params)

    async def send(
        self, chat_id: int, text: str, buttons: Optional[list[list[dict]]] = None
    ) -> dict:
        params: dict[str, Any] = {"chat_id": chat_id, "text": text}
        if buttons:
            params["reply_markup"] = {"inline_keyboard": buttons}
        return await self.call("sendMessage", **params)

    async def answer_callback(self, callback_id: str, text: str = "") -> None:
        await self.call("answerCallbackQuery", callback_query_id=callback_id, text=text)

    async def clear_buttons(self, chat_id: int, message_id: int) -> None:
        await self.call(
            "editMessageReplyMarkup",
            chat_id=chat_id,
            message_id=message_id,
            reply_markup={"inline_keyboard": []},
        )

    async def close(self) -> None:
        await self._client.aclose()


def chunks(text: str, size: int = MAX_REPLY_CHARS) -> list[str]:
    text = text.strip() or "(empty)"
    return [text[i : i + size] for i in range(0, len(text), size)]


class PhoneBridge:
    def __init__(
        self,
        app: Any,
        cfg: PhoneConfig,
        api: Any,
        *,
        home: Optional[Path] = None,
        clock=time.monotonic,
    ) -> None:
        self.app = app
        self.cfg = cfg
        self.api = api
        self.home = (home or Path.home()).resolve()
        self.clock = clock
        self.session = None
        self.pump: Optional[asyncio.Task] = None
        self.timer: Optional[asyncio.Task] = None
        self.sent_at: deque[float] = deque()
        self.usage: dict[str, Optional[float]] = {"five_hour": None, "seven_day": None}
        self.cards: dict[str, dict[str, Any]] = {}  # short token -> approval card
        self.rejected = 0

    # ---- who may talk ------------------------------------------------------

    def _is_owner(self, user: Any, chat: Any) -> bool:
        owner = self.cfg.owner_id
        return (
            isinstance(user, dict)
            and isinstance(chat, dict)
            and user.get("id") == owner
            and chat.get("id") == owner
            and chat.get("type") == "private"
            and user.get("is_bot") is not True
        )

    # ---- main loop -----------------------------------------------------------

    async def run(self) -> None:
        offset: Optional[int] = None
        pause = 2.0
        # Discard what piled up while the server was off.
        while True:
            try:
                stale = await self.api.get_updates(-1, 0)
                if stale:
                    offset = stale[-1]["update_id"] + 1
                await self.api.send(
                    self.cfg.owner_id,
                    "Ultron is online. Messages sent while it was off were ignored.",
                )
                break
            except TelegramError as exc:
                logger.warning("phone bridge cannot start yet: %s", exc)
                await asyncio.sleep(pause)
                pause = min(60.0, pause * 2)
        pause = 2.0
        while True:
            try:
                updates = await self.api.get_updates(offset, POLL_SECONDS)
                pause = 2.0
                await asyncio.sleep(0.05)  # never spin if Telegram answers at once
                for update in updates:
                    offset = update["update_id"] + 1
                    try:
                        await self.handle_update(update)
                    except Exception:  # noqa: BLE001 - one bad update must not stop the bridge
                        logger.exception("phone bridge: update failed")
            except asyncio.CancelledError:
                raise
            except TelegramError as exc:
                logger.warning("phone bridge: %s", exc)
                await asyncio.sleep(pause)
                pause = min(60.0, pause * 2)

    async def handle_update(self, update: dict) -> None:
        msg = update.get("message")
        if isinstance(msg, dict):
            if not self._is_owner(msg.get("from"), msg.get("chat")):
                self.rejected += 1
                return
            text = msg.get("text")
            if isinstance(text, str) and text.strip():
                await self._on_text(text.strip())
            return
        cb = update.get("callback_query")
        if isinstance(cb, dict):
            holder = cb.get("message") if isinstance(cb.get("message"), dict) else {}
            if not self._is_owner(cb.get("from"), holder.get("chat")):
                self.rejected += 1
                return
            await self._on_button(cb)

    # ---- owner text ----------------------------------------------------------

    async def say(self, text: str) -> None:
        for part in chunks(text):
            await self.api.send(self.cfg.owner_id, part)

    async def _on_text(self, text: str) -> None:
        command = text.split()[0].lower().split("@")[0] if text.startswith("/") else ""
        if command in ("/start", "/help"):
            return await self.say(HELP)
        if command == "/status":
            return await self.say(self._status())
        if command == "/stop":
            if self.session is not None and self.session.busy:
                await self.session.interrupt()
                return await self.say("Stopping…")
            return await self.say("Nothing is running.")
        if command == "/new":
            await self._drop_session()
            return await self.say("Fresh conversation. What now?")
        if command:
            return await self.say("Unknown command.\n\n" + HELP)
        await self._task(text)

    def _status(self) -> str:
        def pct(v: Optional[float]) -> str:
            return "unknown yet" if v is None else f"{round(v * 100)}%"

        bridge = getattr(self.app.state, "jarvis_bridge", None)
        screen = bridge is not None and bridge.clients > 0
        busy = self.session is not None and self.session.busy
        screen_text = "open" if screen else "closed (open the app for screen actions)"
        left = max(0, self.cfg.max_per_hour - self._recent())
        return (
            f"{'Working' if busy else 'Idle'}.\n"
            f"Subscription: 5 h window {pct(self.usage['five_hour'])}, "
            f"7 days {pct(self.usage['seven_day'])}.\n"
            f"Screen on the PC: {screen_text}.\n"
            f"Messages left this hour: {left}."
        )

    def _recent(self) -> int:
        now = self.clock()
        while self.sent_at and now - self.sent_at[0] > 3600:
            self.sent_at.popleft()
        return len(self.sent_at)

    async def _task(self, text: str) -> None:
        if len(text) > self.cfg.max_text:
            return await self.say(
                f"Too long ({len(text)} characters, the limit is {self.cfg.max_text})."
            )
        if self._recent() >= self.cfg.max_per_hour:
            return await self.say(
                f"Hourly limit reached ({self.cfg.max_per_hour} messages). Try later."
            )
        five, week = self.usage["five_hour"], self.usage["seven_day"]
        if five is not None and five >= self.cfg.five_hour_stop:
            return await self.say(
                "Remote tasks are paused: the 5 h subscription window is at "
                f"{round(five * 100)}%."
            )
        if week is not None and week >= self.cfg.week_stop:
            return await self.say(
                "Remote tasks are paused: the weekly window is at "
                f"{round(week * 100)}%."
            )
        session = await self._ensure_session()
        if session is None:
            return
        if session.pending:
            return await self.say("Answer the approval above first (Accept or Refuse).")
        if session.busy:
            return await self.say("Still working. Send /stop to interrupt.")
        try:
            await session.send(text)
        except Exception as exc:  # noqa: BLE001 - tell the owner, whatever it is
            detail = getattr(exc, "detail", None) or str(exc) or type(exc).__name__
            return await self.say(f"Could not start: {detail}")
        self.sent_at.append(self.clock())
        self._arm_timer(session)

    # ---- the Ultron session ----------------------------------------------------

    async def _ensure_session(self):
        if self.session is not None and not self.session.closed:
            return self.session
        port = getattr(self.app.state, "bind_port", None)
        if not port:
            await self.say(
                "The server does not know its own port; cannot start Ultron."
            )
            return None
        try:
            self.session = await make_session(
                manager_of(self.app),
                cwd=self.home,
                mode="auto",
                model=None,
                resume=None,
                kind="jarvis",
                api_port=int(port),
            )
        except SessionLimit as exc:
            await self.say(str(exc))
            return None
        self.pump = asyncio.create_task(self._pump(self.session))
        return self.session

    async def _drop_session(self) -> None:
        if self.timer:
            self.timer.cancel()
        if self.pump:
            self.pump.cancel()
        session, self.session = self.session, None
        if session is not None:
            await session.close()
            manager_of(self.app).sessions.pop(session.id, None)
        self.cards.clear()

    def _arm_timer(self, session) -> None:
        if self.timer:
            self.timer.cancel()

        async def limit() -> None:
            await asyncio.sleep(self.cfg.turn_timeout)
            if session.busy:
                try:
                    await session.interrupt()
                except Exception:  # noqa: BLE001
                    pass
                await self.say(
                    "Stopped: the task ran longer than "
                    f"{round(self.cfg.turn_timeout / 60)} minutes."
                )

        self.timer = asyncio.create_task(limit())

    # ---- what Ultron says ---------------------------------------------------------

    async def _pump(self, session) -> None:
        cursor = session.next_seq
        texts: list[str] = []
        try:
            while not session.closed:
                async with session.cond:
                    start = max(cursor, session.first_seq)
                    batch = session.events[start - session.first_seq :]
                    if not batch:
                        try:
                            await asyncio.wait_for(session.cond.wait(), 5.0)
                        except asyncio.TimeoutError:
                            pass
                        continue
                for event in batch:
                    cursor = event["seq"] + 1
                    await self._on_event(session, event, texts)
        except asyncio.CancelledError:
            pass
        except Exception:  # noqa: BLE001
            logger.exception("phone bridge: event pump failed")

    async def _on_event(self, session, event: dict, texts: list[str]) -> None:
        kind = event.get("type")
        if kind == "assistant" and not event.get("replayed"):
            for block in (event.get("message") or {}).get("content") or []:
                if isinstance(block, dict) and block.get("type") == "text":
                    if str(block.get("text", "")).strip():
                        texts.append(str(block["text"]).strip())
        elif kind == "rate_limit_event":
            windows = ((event.get("rate_limit_info") or {}).get("unifiedWindows")) or {}
            for name in ("five_hour", "seven_day"):
                value = (windows.get(name) or {}).get("utilization")
                if isinstance(value, (int, float)):
                    self.usage[name] = float(value)
        elif kind == "result":
            if self.timer:
                self.timer.cancel()
            failed = event.get("is_error") is True
            if (
                failed
                and event.get("subtype") == "error_during_execution"
                and not event.get("result")
            ):
                body = "Stopped."
            elif texts:
                body = "\n\n".join(texts)
            elif failed:
                why = event.get("result") or event.get("subtype") or "unknown error"
                body = f"Failed: {why}"
            else:
                body = "Done."
            texts.clear()
            await self.say(body)
        elif kind == "jarvis":
            await self._on_jarvis_event(session, event)

    async def _on_jarvis_event(self, session, event: dict) -> None:
        what = event.get("kind")
        if what == "approval":
            tool = str(event.get("tool_name") or "")
            ask = jarvis_policy.ASKS.get(
                jarvis_policy.short_name(tool), jarvis_policy.short_name(tool)
            )
            detail = (event.get("input") or {}).get("path") or ""
            token = secrets.token_hex(4)
            card = await self.api.send(
                self.cfg.owner_id,
                f"Ultron asks your permission to {ask}:\n{detail}".rstrip(),
                [
                    [
                        {"text": "Accept", "callback_data": f"y:{token}"},
                        {"text": "Refuse", "callback_data": f"n:{token}"},
                    ]
                ],
            )
            self.cards[token] = {
                "request_id": event.get("request_id"),
                "session": session,
                "message_id": (card or {}).get("message_id"),
            }
        elif what == "approval_resolved":
            for token, card in list(self.cards.items()):
                if card["request_id"] == event.get("request_id"):
                    del self.cards[token]
                    if card["message_id"]:
                        try:
                            await self.api.clear_buttons(
                                self.cfg.owner_id, card["message_id"]
                            )
                        except TelegramError:
                            pass
        elif what == "process_exit" and event.get("during_turn"):
            detail = str(event.get("stderr") or "").strip()
            await self.say(f"Ultron stopped unexpectedly. {detail}".strip())

    async def _on_button(self, cb: dict) -> None:
        data = str(cb.get("data") or "")
        verb, _, token = data.partition(":")
        card = self.cards.get(token)
        if verb not in ("y", "n") or card is None:
            return await self.api.answer_callback(
                cb.get("id", ""), "This request is no longer open."
            )
        try:
            await card["session"].decide(str(card["request_id"]), verb == "y")
        except Exception:  # noqa: BLE001 - e.g. the request was answered on the PC
            self.cards.pop(token, None)
            return await self.api.answer_callback(cb.get("id", ""), "Already answered.")
        await self.api.answer_callback(
            cb.get("id", ""), "Accepted." if verb == "y" else "Refused."
        )


def install_phone_bridge(app: Any, environ: Optional[Mapping[str, str]] = None) -> None:
    """Start the bridge with the server, when (and only when) it is configured."""
    env = os.environ if environ is None else environ
    state: dict[str, Any] = {}

    @app.on_event("startup")
    async def _start_phone() -> None:
        cfg = PhoneConfig.from_env(env)
        if cfg is None:
            return
        # The bot token is inside Telegram's URLs: never let a library log them.
        for name in ("httpx", "httpcore"):
            logging.getLogger(name).setLevel(logging.WARNING)
        api = TelegramApi(cfg.token, cfg.api_base)
        bridge = PhoneBridge(app, cfg, api)
        state.update(api=api, bridge=bridge, task=asyncio.create_task(bridge.run()))
        app.state.phone_bridge = bridge
        logger.info("phone bridge enabled (Telegram, one owner)")

    @app.on_event("shutdown")
    async def _stop_phone() -> None:
        task = state.get("task")
        if task is not None:
            task.cancel()
            try:
                await task
            except (asyncio.CancelledError, Exception):  # noqa: BLE001
                pass
        bridge = state.get("bridge")
        if bridge is not None:
            await bridge._drop_session()
        api = state.get("api")
        if api is not None:
            await api.close()


def create_phone_router() -> Any:
    """``GET /v1/phone/status``: is the phone bot on? (never returns a secret)."""
    from openjarvis.server.workspace_routes import guard

    router = APIRouter(tags=["phone"])

    @router.get("/v1/phone/status")
    async def phone_status(request: Request) -> dict[str, Any]:
        guard(request)
        cfg = PhoneConfig.from_env(os.environ)
        return {
            "configured": cfg is not None,
            "running": getattr(request.app.state, "phone_bridge", None) is not None,
            "max_per_hour": cfg.max_per_hour if cfg else None,
            "max_text": cfg.max_text if cfg else None,
            "turn_seconds": cfg.turn_timeout if cfg else None,
            "five_hour_stop": cfg.five_hour_stop if cfg else None,
            "week_stop": cfg.week_stop if cfg else None,
        }

    return router
