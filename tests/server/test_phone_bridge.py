"""Phone access through Telegram, tested against a fake Telegram (no network)."""

# ruff: noqa: E501, F811

from __future__ import annotations

import asyncio
import json
import logging
import os
import stat
import sys

import httpx
import pytest
from fastapi import FastAPI

from openjarvis.server import phone_bridge as pb
from tests.server.test_claude_routes import home  # noqa: F401  (fixture)

posix_only = pytest.mark.skipif(os.name != "posix", reason="POSIX only")

OWNER = 4242
TOKEN = "123456:SECRET-TOKEN-VALUE"

# Fake `claude` for a Jarvis session. "tools: a|b@path" asks permission for each
# tool, "hang" waits for an interrupt, anything else is echoed.
FAKE = r"""#!{python}
import json, os, sys
def out(d): print(json.dumps(d), flush=True)
def result(**kw): out({{"type": "result", "subtype": "success", "is_error": False, "result": "ok", **kw}})
for line in sys.stdin:
    msg = json.loads(line)
    if msg.get("type") == "control_request" and msg["request"]["subtype"] == "interrupt":
        out({{"type": "result", "subtype": "error_during_execution", "is_error": True, "result": None}})
        continue
    if msg.get("type") != "user":
        continue
    text = msg["message"]["content"]
    out({{"type": "system", "subtype": "init", "session_id": "99999999-aaaa-bbbb-cccc-000000000000"}})
    out({{"type": "rate_limit_event", "rate_limit_info": {{"unifiedWindows": {{
        "five_hour": {{"utilization": float(os.environ.get("FAKE_FIVE", "0.1"))}},
        "seven_day": {{"utilization": 0.2}}}}}}}})
    if text == "hang":
        continue
    if text.startswith("tools:"):
        seen = []
        for i, name in enumerate(text.split("tools:", 1)[1].strip().split("|")):
            tool, _, path = name.partition("@")
            out({{"type": "control_request", "request_id": "q%d" % i, "request": {{
                "subtype": "can_use_tool", "tool_name": tool, "display_name": tool,
                "input": {{"path": path}} if path else {{}}}}}})
            reply = json.loads(sys.stdin.readline())
            seen.append(tool + ":" + reply["response"]["response"]["behavior"])
        out({{"type": "assistant", "message": {{"role": "assistant", "content": [
            {{"type": "text", "text": ";".join(seen)}}]}}}})
        result()
    else:
        out({{"type": "assistant", "message": {{"role": "assistant", "content": [
            {{"type": "text", "text": "echo: " + text}}]}}}})
        result()
"""


@pytest.fixture()
def fake_claude(tmp_path, monkeypatch):
    path = tmp_path / "fake-claude"
    path.write_text(FAKE.format(python=sys.executable))
    path.chmod(path.stat().st_mode | stat.S_IEXEC)
    monkeypatch.setenv("OPENJARVIS_CLAUDE_BIN", str(path))


class FakeTelegram:
    """Records what the bridge sends; replies like the Bot API."""

    def __init__(self):
        self.calls: list[tuple[str, dict]] = []
        self.updates: list[list[dict]] = []
        self.fail_next = None

    async def handler(self, request: httpx.Request) -> httpx.Response:
        method = request.url.path.rsplit("/", 1)[-1]
        params = json.loads(request.content or b"{}")
        self.calls.append((method, params))
        if self.fail_next:
            err, self.fail_next = self.fail_next, None
            raise err
        if method == "getUpdates":
            await asyncio.sleep(0.01)  # a real long poll waits; never spin the loop
            return httpx.Response(
                200,
                json={
                    "ok": True,
                    "result": self.updates.pop(0) if self.updates else [],
                },
            )
        if method == "sendMessage":
            n = sum(1 for m, _ in self.calls if m == "sendMessage")
            return httpx.Response(
                200, json={"ok": True, "result": {"message_id": 100 + n}}
            )
        return httpx.Response(200, json={"ok": True, "result": True})

    def sent(self):
        return [p["text"] for m, p in self.calls if m == "sendMessage"]

    def last_card(self):
        for m, p in reversed(self.calls):
            if m == "sendMessage" and "reply_markup" in p:
                return p
        return None


def msg(text, user=OWNER, chat=OWNER, chat_type="private", is_bot=False):
    return {
        "update_id": 1,
        "message": {
            "from": {"id": user, "is_bot": is_bot},
            "chat": {"id": chat, "type": chat_type},
            "text": text,
        },
    }


def press(data, user=OWNER, chat=OWNER, chat_type="private"):
    return {
        "update_id": 2,
        "callback_query": {
            "id": "cb1",
            "from": {"id": user},
            "data": data,
            "message": {"chat": {"id": chat, "type": chat_type}},
        },
    }


def make(app=None, **cfg):
    app = app or FastAPI()
    app.state.bind_port = 8010
    fake = FakeTelegram()
    api = pb.TelegramApi(
        TOKEN, client=httpx.AsyncClient(transport=httpx.MockTransport(fake.handler))
    )
    config = pb.PhoneConfig(token=TOKEN, owner_id=OWNER, **cfg)
    return pb.PhoneBridge(app, config, api, home=None), fake


async def settle(bridge, fake, until, secs=10):
    for _ in range(int(secs * 50)):
        if until():
            return True
        await asyncio.sleep(0.02)
    raise AssertionError(f"timed out; sent={fake.sent()}")


async def finish(bridge):
    await bridge._drop_session()
    await bridge.api.close()


# ---------------------------------------------------------------------------


class TestConfig:
    def test_needs_both_values(self):
        assert pb.PhoneConfig.from_env({}) is None
        assert pb.PhoneConfig.from_env({"OPENULTRON_PHONE_BOT_TOKEN": "t"}) is None
        assert pb.PhoneConfig.from_env({"OPENULTRON_PHONE_OWNER_ID": "5"}) is None

    def test_owner_must_be_a_positive_number(self):
        for bad in ("abc", "-100123", "0", "12.5", ""):
            assert (
                pb.PhoneConfig.from_env(
                    {
                        "OPENULTRON_PHONE_BOT_TOKEN": "t",
                        "OPENULTRON_PHONE_OWNER_ID": bad,
                    }
                )
                is None
            )

    def test_reads_values_and_limits(self):
        cfg = pb.PhoneConfig.from_env(
            {
                "OPENULTRON_PHONE_BOT_TOKEN": " t ",
                "OPENULTRON_PHONE_OWNER_ID": "77",
                "OPENULTRON_PHONE_MAX_PER_HOUR": "5",
                "OPENULTRON_PHONE_MAX_TEXT": "oops",
            }
        )
        assert (cfg.token, cfg.owner_id, cfg.max_per_hour, cfg.max_text) == (
            "t",
            77,
            5,
            2000,
        )

    def test_the_old_openjarvis_names_still_work(self):
        cfg = pb.PhoneConfig.from_env(
            {
                "OPENJARVIS_PHONE_BOT_TOKEN": "old",
                "OPENJARVIS_PHONE_OWNER_ID": "5",
                "OPENJARVIS_PHONE_MAX_PER_HOUR": "9",
            }
        )
        assert (cfg.token, cfg.owner_id, cfg.max_per_hour) == ("old", 5, 9)

    def test_the_openultron_names_win_over_the_old_ones(self):
        cfg = pb.PhoneConfig.from_env(
            {
                "OPENULTRON_PHONE_BOT_TOKEN": "new",
                "OPENJARVIS_PHONE_BOT_TOKEN": "old",
                "OPENULTRON_PHONE_OWNER_ID": "7",
                "OPENJARVIS_PHONE_OWNER_ID": "5",
            }
        )
        assert (cfg.token, cfg.owner_id) == ("new", 7)

    def test_both_prefixes_are_removed_from_child_environments(self):
        from openjarvis.server.terminal_routes import terminal_env

        env = terminal_env(
            {
                "PATH": "/bin",
                "OPENULTRON_PHONE_BOT_TOKEN": "secret",
                "OPENJARVIS_PHONE_BOT_TOKEN": "secret",
            }
        )
        assert not any("PHONE" in key or "secret" in env[key] for key in env)

    def test_token_is_never_printed(self):
        cfg = pb.PhoneConfig(token=TOKEN, owner_id=1)
        assert TOKEN not in repr(cfg) and TOKEN not in str(cfg)


class TestTelegramApi:
    def test_errors_never_contain_the_token(self):
        def boom(request):
            raise httpx.ConnectError(f"cannot connect to {request.url}")

        api = pb.TelegramApi(
            TOKEN, client=httpx.AsyncClient(transport=httpx.MockTransport(boom))
        )
        with pytest.raises(pb.TelegramError) as err:
            asyncio.run(api.call("getMe"))
        assert TOKEN not in str(err.value) and "network error" in str(err.value)

    def test_api_refusal_is_reported(self):
        def refuse(request):
            return httpx.Response(
                409, json={"ok": False, "description": "Conflict: another getUpdates"}
            )

        api = pb.TelegramApi(
            TOKEN, client=httpx.AsyncClient(transport=httpx.MockTransport(refuse))
        )
        with pytest.raises(pb.TelegramError, match="Conflict"):
            asyncio.run(api.get_updates(None, 0))

    def test_chunks(self):
        assert pb.chunks("a" * 9000) == ["a" * 3800, "a" * 3800, "a" * 1400]
        assert pb.chunks("   ") == ["(empty)"]


class TestWhoMayTalk:
    @pytest.mark.parametrize(
        "update",
        [
            msg("hello", user=999, chat=999),
            msg(
                "hello", user=999, chat=OWNER
            ),  # someone writing into the owner's chat id
            msg("hello", user=OWNER, chat=-5, chat_type="group"),
            msg("hello", user=OWNER, chat=OWNER, chat_type="supergroup"),
            msg("hello", is_bot=True),
            {"update_id": 3, "channel_post": {"chat": {"id": OWNER}, "text": "hi"}},
            {
                "update_id": 4,
                "message": {
                    "chat": {"id": OWNER, "type": "private"},
                    "text": "no sender",
                },
            },
            {"update_id": 5, "message": "garbage"},
            press("y:abcd", user=999, chat=999),
            press("y:abcd", user=OWNER, chat=-5, chat_type="group"),
        ],
    )
    def test_everyone_else_is_ignored_silently(self, update, home, fake_claude):
        async def go():
            bridge, fake = make()
            await bridge.handle_update(update)
            assert fake.calls == []  # not even an answer
            assert bridge.session is None
            await finish(bridge)

        asyncio.run(go())

    def test_rejections_are_counted(self, home, fake_claude):
        async def go():
            bridge, fake = make()
            await bridge.handle_update(msg("x", user=1, chat=1))
            await bridge.handle_update(msg("x", user=2, chat=2))
            assert bridge.rejected == 2
            await finish(bridge)

        asyncio.run(go())


@posix_only
class TestOwnerTasks:
    def test_help_and_unknown_commands(self, home, fake_claude):
        async def go():
            bridge, fake = make()
            await bridge.handle_update(msg("/start"))
            await bridge.handle_update(msg("/bogus"))
            assert "Ultron on your phone" in fake.sent()[0]
            assert fake.sent()[1].startswith("Unknown command")
            assert bridge.session is None  # commands do not start a session
            await finish(bridge)

        asyncio.run(go())

    def test_a_message_gets_jarvis_answer(self, home, fake_claude):
        async def go():
            bridge, fake = make()
            await bridge.handle_update(msg("hello jarvis"))
            await settle(bridge, fake, lambda: "echo: hello jarvis" in fake.sent())
            assert bridge.session.kind == "jarvis"
            await finish(bridge)

        asyncio.run(go())

    def test_status(self, home, fake_claude):
        async def go():
            bridge, fake = make()
            await bridge.handle_update(msg("hi"))
            await settle(bridge, fake, lambda: "echo: hi" in fake.sent())
            await bridge.handle_update(msg("/status"))
            status = fake.sent()[-1]
            assert "Idle" in status and "10%" in status and "20%" in status
            assert "closed" in status and "39" in status
            await finish(bridge)

        asyncio.run(go())

    def test_new_starts_a_fresh_conversation(self, home, fake_claude):
        async def go():
            bridge, fake = make()
            await bridge.handle_update(msg("one"))
            await settle(bridge, fake, lambda: "echo: one" in fake.sent())
            first = bridge.session.id
            await bridge.handle_update(msg("/new"))
            assert bridge.session is None
            await bridge.handle_update(msg("two"))
            await settle(bridge, fake, lambda: "echo: two" in fake.sent())
            assert bridge.session.id != first
            await finish(bridge)

        asyncio.run(go())


@posix_only
class TestApprovalsOnThePhone:
    async def _ask(self, bridge, fake, target):
        await bridge.handle_update(msg(f"tools: mcp__jarvis__delete_path@{target}"))
        await settle(bridge, fake, lambda: fake.last_card() is not None)
        return fake.last_card()

    def test_card_has_buttons_and_nothing_happens_before_the_answer(
        self, home, fake_claude
    ):
        async def go():
            bridge, fake = make()
            card = await self._ask(bridge, fake, str(home / "x"))
            assert (
                "move to the trash" in card["text"] and str(home / "x") in card["text"]
            )
            buttons = card["reply_markup"]["inline_keyboard"][0]
            assert [b["text"] for b in buttons] == ["Accept", "Refuse"]
            assert all(len(b["callback_data"]) < 64 for b in buttons)
            assert bridge.session.pending  # still waiting
            await finish(bridge)

        asyncio.run(go())

    def test_accept_grants_exactly_this_call(self, home, fake_claude):
        async def go():
            bridge, fake = make()
            target = str(home / "x")
            card = await self._ask(bridge, fake, target)
            yes = card["reply_markup"]["inline_keyboard"][0][0]["callback_data"]
            await bridge.handle_update(press(yes))
            await settle(bridge, fake, lambda: any("allow" in t for t in fake.sent()))
            assert bridge.session.grants.consume(
                "mcp__jarvis__delete_path", {"path": target}
            )
            assert any(
                m == "answerCallbackQuery" and p["text"] == "Accepted."
                for m, p in fake.calls
            )
            await settle(
                bridge,
                fake,
                lambda: any(m == "editMessageReplyMarkup" for m, _ in fake.calls),
            )
            await finish(bridge)

        asyncio.run(go())

    def test_refuse_grants_nothing(self, home, fake_claude):
        async def go():
            bridge, fake = make()
            target = str(home / "x")
            card = await self._ask(bridge, fake, target)
            no = card["reply_markup"]["inline_keyboard"][0][1]["callback_data"]
            await bridge.handle_update(press(no))
            await settle(bridge, fake, lambda: any("deny" in t for t in fake.sent()))
            assert not bridge.session.grants.consume(
                "mcp__jarvis__delete_path", {"path": target}
            )
            await finish(bridge)

        asyncio.run(go())

    def test_only_the_owner_can_press_the_buttons(self, home, fake_claude):
        async def go():
            bridge, fake = make()
            card = await self._ask(bridge, fake, str(home / "x"))
            yes = card["reply_markup"]["inline_keyboard"][0][0]["callback_data"]
            before = len(fake.calls)
            await bridge.handle_update(press(yes, user=999, chat=999))
            await bridge.handle_update(press(yes, user=999, chat=OWNER))
            assert len(fake.calls) == before and bridge.session.pending
            await finish(bridge)

        asyncio.run(go())

    def test_stale_or_forged_buttons_do_nothing(self, home, fake_claude):
        async def go():
            bridge, fake = make()
            await self._ask(bridge, fake, str(home / "x"))
            await bridge.handle_update(press("y:ffffffff"))
            await bridge.handle_update(press("z:whatever"))
            await bridge.handle_update(press("nonsense"))
            answers = [p["text"] for m, p in fake.calls if m == "answerCallbackQuery"]
            assert answers == ["This request is no longer open."] * 3
            assert bridge.session.pending
            await finish(bridge)

        asyncio.run(go())

    def test_cannot_talk_over_a_pending_approval(self, home, fake_claude):
        async def go():
            bridge, fake = make()
            await self._ask(bridge, fake, str(home / "x"))
            await bridge.handle_update(msg("and also this"))
            assert "Answer the approval above" in fake.sent()[-1]
            await finish(bridge)

        asyncio.run(go())


@posix_only
class TestCaps:
    def test_too_long(self, home, fake_claude):
        async def go():
            bridge, fake = make(max_text=20)
            await bridge.handle_update(msg("x" * 21))
            assert "Too long" in fake.sent()[-1] and bridge.session is None
            await finish(bridge)

        asyncio.run(go())

    def test_hourly_limit_and_window_slides(self, home, fake_claude):
        async def go():
            now = [0.0]
            bridge, fake = make(max_per_hour=2)
            bridge.clock = lambda: now[0]
            for i in range(2):
                await bridge.handle_update(msg(f"m{i}"))
                await settle(bridge, fake, lambda i=i: f"echo: m{i}" in fake.sent())
            await bridge.handle_update(msg("m2"))
            assert "Hourly limit" in fake.sent()[-1]
            now[0] = 3601.0
            await bridge.handle_update(msg("m3"))
            await settle(bridge, fake, lambda: "echo: m3" in fake.sent())
            await finish(bridge)

        asyncio.run(go())

    def test_pauses_when_the_subscription_is_nearly_used_up(
        self, home, fake_claude, monkeypatch
    ):
        monkeypatch.setenv("FAKE_FIVE", "0.9")

        async def go():
            bridge, fake = make()
            await bridge.handle_update(msg("first"))  # learns the usage
            await settle(bridge, fake, lambda: "echo: first" in fake.sent())
            await bridge.handle_update(msg("second"))
            assert "paused" in fake.sent()[-1] and "90%" in fake.sent()[-1]
            assert "echo: second" not in fake.sent()
            await finish(bridge)

        asyncio.run(go())

    def test_busy_message_and_stop(self, home, fake_claude):
        async def go():
            bridge, fake = make()
            await bridge.handle_update(msg("hang"))
            await settle(bridge, fake, lambda: bridge.session.busy)
            await bridge.handle_update(msg("another"))
            assert "Still working" in fake.sent()[-1]
            await bridge.handle_update(msg("/stop"))
            await settle(bridge, fake, lambda: "Stopped." in fake.sent())
            await settle(bridge, fake, lambda: not bridge.session.busy)
            await finish(bridge)

        asyncio.run(go())

    def test_stop_with_nothing_running(self, home, fake_claude):
        async def go():
            bridge, fake = make()
            await bridge.handle_update(msg("/stop"))
            assert fake.sent() == ["Nothing is running."]
            await finish(bridge)

        asyncio.run(go())

    def test_a_task_that_runs_too_long_is_stopped(self, home, fake_claude):
        async def go():
            bridge, fake = make(turn_timeout=0.3)
            await bridge.handle_update(msg("hang"))
            await settle(
                bridge, fake, lambda: any("longer than" in t for t in fake.sent())
            )
            await settle(bridge, fake, lambda: not bridge.session.busy)
            await finish(bridge)

        asyncio.run(go())

    def test_a_missing_claude_program_is_explained(self, home, monkeypatch):
        monkeypatch.setenv("OPENJARVIS_CLAUDE_BIN", "")
        monkeypatch.setenv("PATH", "/nonexistent")

        async def go():
            bridge, fake = make()
            await bridge.handle_update(msg("hello"))
            assert (
                "Could not start" in fake.sent()[-1]
                and "claude login" in fake.sent()[-1]
            )
            await finish(bridge)

        asyncio.run(go())


@posix_only
class TestRunLoop:
    def test_old_messages_are_discarded_at_start_and_new_ones_handled(
        self, home, fake_claude
    ):
        async def go():
            bridge, fake = make()
            stale = [
                {
                    "update_id": 10,
                    "message": msg("delete everything yesterday")["message"],
                }
            ]
            fresh = [{"update_id": 11, "message": msg("hello now")["message"]}]
            fake.updates = [stale, [], fresh]  # backlog probe, first poll, second poll
            task = asyncio.create_task(bridge.run())
            await settle(bridge, fake, lambda: "echo: hello now" in fake.sent())
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)
            assert "Ultron is online" in fake.sent()[0]
            assert not any("yesterday" in t for t in fake.sent())
            polls = [p for m, p in fake.calls if m == "getUpdates"]
            assert polls[0]["offset"] == -1 and polls[0]["timeout"] == 0
            assert polls[2]["offset"] == 11  # acknowledges the discarded backlog
            await finish(bridge)

        asyncio.run(go())

    def test_a_network_error_is_retried(self, home, fake_claude):
        async def go():
            bridge, fake = make()
            fake.fail_next = httpx.ConnectError("down")
            fake.updates = [
                [],
                [],
                [{"update_id": 1, "message": msg("after outage")["message"]}],
            ]
            task = asyncio.create_task(bridge.run())
            await settle(
                bridge, fake, lambda: "echo: after outage" in fake.sent(), secs=20
            )
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)
            await finish(bridge)

        asyncio.run(go())


class TestInstall:
    def test_disabled_without_configuration(self):
        from fastapi.testclient import TestClient

        app = FastAPI()
        pb.install_phone_bridge(app, environ={})
        with TestClient(app):
            assert not hasattr(app.state, "phone_bridge")

    def test_enabled_when_configured_and_stopped_cleanly(self, monkeypatch, caplog):
        from fastapi.testclient import TestClient

        calls = []

        class Stub(pb.PhoneBridge):
            async def run(self):
                calls.append("run")
                await asyncio.sleep(3600)

        monkeypatch.setattr(pb, "PhoneBridge", Stub)
        app = FastAPI()
        pb.install_phone_bridge(
            app,
            environ={
                "OPENULTRON_PHONE_BOT_TOKEN": TOKEN,
                "OPENULTRON_PHONE_OWNER_ID": str(OWNER),
            },
        )
        with caplog.at_level(logging.INFO):
            with TestClient(app):
                assert hasattr(app.state, "phone_bridge")
        assert calls == ["run"]
        assert TOKEN not in caplog.text
        assert logging.getLogger("httpx").level >= logging.WARNING

    def test_children_never_see_the_phone_secrets(self):
        from openjarvis.server.terminal_routes import terminal_env

        env = terminal_env(
            {
                "OPENULTRON_PHONE_BOT_TOKEN": "x",
                "OPENULTRON_PHONE_OWNER_ID": "1",
                "TELEGRAM_BOT_TOKEN": "y",
                "PATH": "/bin",
            }
        )
        assert env.get("PATH") == "/bin"
        assert not [k for k in env if "PHONE" in k or "TELEGRAM" in k]
