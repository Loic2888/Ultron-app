"""The hub answers one poll for many chats, shells and the screen queue."""

from __future__ import annotations

import asyncio
import time
from types import SimpleNamespace

import pytest

from openjarvis.server import hub_routes as hub

pytestmark = pytest.mark.asyncio


def chat(events=(), closed=False):
    return SimpleNamespace(
        cond=asyncio.Condition(),
        events=[{"seq": i, "type": "x"} for i in events],
        first_seq=events[0] if events else 0,
        closed=closed,
    )


def shell(chunks=(), exit_code=None):
    return SimpleNamespace(
        cond=asyncio.Condition(),
        chunks=list(chunks),
        first_seq=chunks[0][0] if chunks else 0,
        exit_code=exit_code,
        closed=False,
        attached=0,
        touch=lambda: None,
    )


def bridge(commands=()):
    return SimpleNamespace(
        cond=asyncio.Condition(),
        commands=list(commands),
        first_seq=0,
        clients=0,
        last_screen=0.0,
    )


async def never():
    return False


def build(subs, chats=None, shells=None, br=None):
    return hub.build_sources(
        [hub.Sub(**s) for s in subs],
        find_chat=(chats or {}).get,
        find_term=(shells or {}).get,
        bridge=br or bridge(),
    )


async def test_returns_news_from_several_sources_at_once():
    sources, missing = build(
        [
            {"ch": "chat", "id": "c1", "after": 0},
            {"ch": "term", "id": "t1", "after": -1},
        ],
        chats={"c1": chat([0, 1, 2])},
        shells={"t1": shell([(0, "hi")])},
    )
    out = await hub.poll(sources, missing, 1, disconnected=never)
    by = {i["ch"]: i for i in out["items"]}
    assert [e["seq"] for e in by["chat"]["events"]] == [1, 2]
    assert by["term"]["events"] == [{"seq": 0, "data": "hi"}]


async def test_waits_then_wakes_when_something_arrives():
    c = chat([0])
    sources, missing = build([{"ch": "chat", "id": "c", "after": 0}], chats={"c": c})

    async def later():
        await asyncio.sleep(0.1)
        async with c.cond:
            c.events.append({"seq": 1, "type": "x"})
            c.cond.notify_all()

    asyncio.ensure_future(later())
    start = time.monotonic()
    out = await hub.poll(sources, missing, 5, disconnected=never)
    assert time.monotonic() - start < 2
    assert [e["seq"] for e in out["items"][0]["events"]] == [1]


async def test_empty_answer_after_the_wait():
    sources, missing = build(
        [{"ch": "chat", "id": "c", "after": 0}], chats={"c": chat([0])}
    )
    out = await hub.poll(sources, missing, 0.2, disconnected=never)
    assert out == {"items": [], "ended": []}


async def test_unknown_things_are_reported_as_missing_at_once():
    sources, missing = build(
        [{"ch": "chat", "id": "gone"}, {"ch": "term", "id": "gone2"}]
    )
    out = await hub.poll(sources, missing, 5, disconnected=never)
    assert {m["id"] for m in out["ended"]} == {"gone", "gone2"}
    assert all(m["ended"] == "missing" for m in out["ended"])


async def test_closed_chat_and_exited_shell_end():
    sources, missing = build(
        [{"ch": "chat", "id": "c", "after": 5}, {"ch": "term", "id": "t", "after": 9}],
        chats={"c": chat([5], closed=True)},
        shells={"t": shell([(9, "x")], exit_code=3)},
    )
    out = await hub.poll(sources, missing, 1, disconnected=never)
    by = {i["ch"]: i for i in out["items"]}
    assert by["chat"]["ended"] == "closed"
    assert by["term"]["ended"] == "exit"
    assert by["term"]["events"] == [{"exit": 3}]


async def test_screen_commands_mark_the_screen_as_present():
    br = bridge([{"seq": 0, "id": "c0", "name": "n", "args": {}}])
    sources, missing = build([{"ch": "cmd", "after": -1}], br=br)
    out = await hub.poll(sources, missing, 1, disconnected=never)
    assert out["items"][0]["events"][0]["id"] == "c0"
    assert br.clients == 0 and br.last_screen > 0


async def test_shell_is_counted_as_attached_only_while_polling():
    sh = shell([(0, "a")])
    sources, missing = build([{"ch": "term", "id": "t", "after": -1}], shells={"t": sh})
    await hub.poll(sources, missing, 1, disconnected=never)
    assert sh.attached == 0


async def test_gone_page_stops_the_wait():
    async def gone():
        return True

    sources, missing = build(
        [{"ch": "chat", "id": "c", "after": 0}], chats={"c": chat([0])}
    )
    start = time.monotonic()
    await hub.poll(sources, missing, 20, disconnected=gone)
    assert time.monotonic() - start < 8
