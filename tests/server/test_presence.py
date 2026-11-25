"""The server stops itself when the app is closed (desktop icon only)."""

from __future__ import annotations

from fastapi import FastAPI
from fastapi.testclient import TestClient

from openjarvis.server import presence as pr
from openjarvis.server import terminal_routes as tr
from openjarvis.server import workspace_routes as wr


class Clock:
    def __init__(self) -> None:
        self.now = 1000.0

    def __call__(self) -> float:
        return self.now


def make(enabled=True):
    clock = Clock()
    stops: list[int] = []
    p = pr.Presence(enabled=enabled, stop=lambda: stops.append(1), clock=clock)
    return p, clock, stops


class TestDecision:
    def test_stops_after_the_grace_period_once_the_last_page_is_gone(self):
        p, clock, stops = make()
        p.connect()
        clock.now += 3600
        assert not p.tick(busy=False, phone=False)  # a page is open
        p.disconnect()
        clock.now += pr.GRACE_SECONDS - 1
        assert not p.tick(busy=False, phone=False)
        clock.now += 2
        assert p.tick(busy=False, phone=False)
        assert stops == [1]
        assert not p.tick(busy=False, phone=False)  # only once
        assert stops == [1]

    def test_a_reload_within_the_grace_period_keeps_the_server(self):
        p, clock, stops = make()
        p.connect()
        p.disconnect()
        clock.now += pr.GRACE_SECONDS - 5
        p.connect()  # the page came back
        clock.now += 3600
        assert not p.tick(busy=False, phone=False)
        assert stops == []

    def test_two_pages_need_both_to_close(self):
        p, clock, _ = make()
        p.connect()
        p.connect()
        p.disconnect()
        clock.now += 3600
        assert not p.should_stop(busy=False, phone=False)
        p.disconnect()
        clock.now += pr.GRACE_SECONDS + 1
        assert p.should_stop(busy=False, phone=False)

    def test_never_stops_while_claude_works_or_when_the_phone_needs_it(self):
        p, clock, _ = make()
        p.connect()
        p.disconnect()
        clock.now += 3600
        assert not p.should_stop(busy=True, phone=False)
        assert not p.should_stop(busy=False, phone=True)
        assert p.should_stop(busy=False, phone=False)  # as soon as the work is done

    def test_a_server_nobody_ever_opened_stops_after_the_first_delay(self):
        p, clock, _ = make()
        clock.now += pr.FIRST_SECONDS - 1
        assert not p.should_stop(busy=False, phone=False)
        clock.now += 2
        assert p.should_stop(busy=False, phone=False)

    def test_a_server_not_started_by_the_icon_never_stops(self):
        p, clock, stops = make(enabled=False)
        clock.now += 10**6
        assert not p.tick(busy=False, phone=False)
        assert stops == []


class TestRoute:
    def _client(self, monkeypatch):
        monkeypatch.delenv(pr.ENV_FLAG, raising=False)
        app = FastAPI()
        pr.install_presence(app)
        app.include_router(pr.create_presence_router())
        app.state.allowed_origins = ["http://localhost:5173"]
        app.state.bind_host = "127.0.0.1"
        headers = {
            "origin": "http://localhost:5173",
            "host": "localhost:8010",
            wr.TOKEN_HEADER: tr.get_terminal_token(app),
        }
        return app, TestClient(app, base_url="http://localhost:8010"), headers

    def test_needs_the_token(self, monkeypatch):
        _, client, _ = self._client(monkeypatch)
        assert client.get("/v1/app/presence").status_code in (401, 403)
