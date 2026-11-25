"""Journal: logs, Claude Code memory and last known plan usage."""

from __future__ import annotations

import time

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from openjarvis.server import journal
from openjarvis.server import terminal_routes as tr
from openjarvis.server import workspace_routes as wr

FRONTEND = "http://localhost:5173"


@pytest.fixture()
def client():
    app = FastAPI()
    app.include_router(journal.create_journal_router())
    app.state.allowed_origins = [FRONTEND]
    app.state.bind_host = "127.0.0.1"
    c = TestClient(app, base_url="http://localhost:8010")
    headers = {
        "origin": FRONTEND,
        "host": "localhost:8010",
        wr.TOKEN_HEADER: tr.get_terminal_token(app),
    }
    return c, headers


class TestLogs:
    def test_routes_need_the_token(self, client):
        c, _ = client
        assert c.get("/v1/journal/logs").status_code in (401, 403)
        assert c.get("/v1/journal/memory").status_code in (401, 403)

    def test_add_read_and_clear(self, client):
        c, h = client
        r = c.post(
            "/v1/journal/logs",
            headers=h,
            json={"category": "repo", "message": "Repo ouvert : OpenJarvis"},
        )
        assert r.status_code == 200
        entries = c.get("/v1/journal/logs", headers=h).json()["entries"]
        assert entries[-1]["message"] == "Repo ouvert : OpenJarvis"
        assert entries[-1]["category"] == "repo"
        assert entries[-1]["level"] == "info"
        assert abs(entries[-1]["ts"] - time.time() * 1000) < 5000
        assert c.delete("/v1/journal/logs", headers=h).status_code == 200
        assert c.get("/v1/journal/logs", headers=h).json()["entries"] == []

    def test_empty_message_refused_and_unknown_level_is_info(self, client):
        c, h = client
        bad = c.post(
            "/v1/journal/logs", headers=h, json={"category": "x", "message": " "}
        )
        assert bad.status_code == 400
        c.post(
            "/v1/journal/logs",
            headers=h,
            json={"category": "x", "message": "m", "level": "weird"},
        )
        assert c.get("/v1/journal/logs", headers=h).json()["entries"][-1]["level"] == (
            "info"
        )

    def test_long_text_is_clipped_and_file_is_trimmed(self, tmp_path, monkeypatch):
        journal.log("x", "a" * 5000)
        assert len(journal.read_logs()[-1]["message"]) <= journal.MAX_TEXT
        monkeypatch.setattr(journal, "MAX_FILE_BYTES", 2_000)
        monkeypatch.setattr(journal, "KEEP_AFTER_TRIM", 5)
        for i in range(60):
            journal.log("x", f"line {i}")
        entries = journal.read_logs()
        assert len(entries) < 60
        assert entries[-1]["message"] == "line 59"

    def test_corrupt_line_is_skipped(self):
        journal.log("x", "good")
        path = journal.journal_dir() / "logs.jsonl"
        path.write_text(path.read_text() + "not json\n")
        assert [e["message"] for e in journal.read_logs()] == ["good"]


class TestMemoryAndUsage:
    def test_turn_is_remembered_with_repo_and_files(self, client):
        c, h = client
        journal.remember_turn(
            repo="/home/u/proj",
            chat="c1",
            prompt="fix the bug",
            files=["a.py"],
            tools={"Edit": 1},
            answer="Fixed it.",
            ok=True,
            started=time.time() - 3,
        )
        item = c.get("/v1/journal/memory", headers=h).json()["entries"][-1]
        assert item["repo"] == "/home/u/proj"
        assert item["files"] == ["a.py"]
        assert item["answer"] == "Fixed it."
        assert item["seconds"] >= 3

    def test_usage_round_trip(self):
        assert journal.load_usage() is None
        win = {"five_hour": {"utilization": 0.1, "resetsAt": 1}}
        journal.save_usage(win)
        data = journal.load_usage()
        assert data["windows"] == win
        assert data["seen_at"] <= time.time()


class TestInfoAndPhoneStatus:
    def test_info_gives_paths_only(self, client):
        c, h = client
        assert c.get("/v1/journal/info").status_code in (401, 403)
        body = c.get("/v1/journal/info", headers=h).json()
        assert body["journal_dir"].endswith("journal")
        assert body["memory_dir"].endswith("memory")

    def test_phone_status_never_shows_secrets(self, monkeypatch):
        from openjarvis.server.phone_bridge import create_phone_router

        monkeypatch.setenv("OPENJARVIS_PHONE_BOT_TOKEN", "123:SECRET")
        monkeypatch.setenv("OPENJARVIS_PHONE_OWNER_ID", "424242")
        app = FastAPI()
        app.include_router(create_phone_router())
        app.state.allowed_origins = [FRONTEND]
        app.state.bind_host = "127.0.0.1"
        c = TestClient(app, base_url="http://localhost:8010")
        h = {
            "origin": FRONTEND,
            "host": "localhost:8010",
            wr.TOKEN_HEADER: tr.get_terminal_token(app),
        }
        assert c.get("/v1/phone/status").status_code in (401, 403)
        res = c.get("/v1/phone/status", headers=h)
        assert res.json()["configured"] is True
        assert res.json()["running"] is False
        assert "SECRET" not in res.text and "424242" not in res.text
