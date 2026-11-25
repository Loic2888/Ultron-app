"""Per-repo memory folders: creation, naming, the "no prompt" rule, reading."""

from __future__ import annotations

import os

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from openjarvis.server import repo_memory as rm
from openjarvis.server import workspace_routes as wr


def test_folder_is_created_once_with_starter_files(tmp_path):
    repo = tmp_path / "proj"
    repo.mkdir()
    first = rm.ensure_repo_memory(repo)
    (first / "notes.md").write_text("# mine\n")
    again = rm.ensure_repo_memory(repo)
    assert again == first
    assert (first / "INDEX.md").is_file()
    assert (first / "fonctionne").is_dir()
    assert (first / "ne-fonctionne-pas").is_dir()
    assert (first / "notes.md").read_text() == "# mine\n"  # never overwritten


def test_two_repos_with_the_same_name_do_not_share_memory(tmp_path):
    a, b = tmp_path / "a" / "app", tmp_path / "b" / "app"
    a.mkdir(parents=True)
    b.mkdir(parents=True)
    da, db = rm.ensure_repo_memory(a), rm.ensure_repo_memory(b)
    assert da != db
    assert rm.ensure_repo_memory(a) == da
    assert rm.ensure_repo_memory(b) == db


def test_only_files_inside_the_folder_skip_the_question(tmp_path):
    repo = tmp_path / "proj"
    repo.mkdir()
    mem = rm.ensure_repo_memory(repo)
    ok = {"file_path": str(mem / "notes.md")}
    assert rm.allows("Edit", ok, mem)
    assert rm.allows("Write", {"file_path": str(mem / "new.md")}, mem)
    assert not rm.allows("Bash", {"command": "ls"}, mem)
    assert not rm.allows("Edit", {"file_path": str(repo / "x.py")}, mem)
    assert not rm.allows("Edit", {"file_path": str(mem / ".." / "x.md")}, mem)
    assert not rm.allows("Edit", {"file_path": "notes.md"}, mem)  # relative
    assert not rm.allows("Edit", {"file_path": str(mem)}, mem)  # the folder itself
    assert rm.allows(
        "Write", {"file_path": str(mem / "fonctionne" / "lancer-les-tests.md")}, mem
    )
    assert not rm.allows("Write", {"file_path": str(mem / "repo.json")}, mem)
    assert not rm.allows("Edit", ok, None)


@pytest.mark.skipif(os.name != "posix", reason="symlinks")
def test_a_symlink_cannot_lead_out_of_the_folder(tmp_path):
    repo = tmp_path / "proj"
    repo.mkdir()
    mem = rm.ensure_repo_memory(repo)
    outside = tmp_path / "outside.txt"
    outside.write_text("x")
    (mem / "link.md").symlink_to(outside)
    assert not rm.allows("Write", {"file_path": str(mem / "link.md")}, mem)


def test_listing_and_reading_are_limited_to_known_files(tmp_path):
    repo = tmp_path / "proj"
    repo.mkdir()
    mem = rm.ensure_repo_memory(repo)
    (mem / "fonctionne" / "lancer-les-tests.md").write_text("pytest -q marche\n")
    repos = rm.list_repos()
    assert [r["name"] for r in repos] == ["proj"]
    assert {f["name"] for f in repos[0]["files"]} >= {
        "INDEX.md",
        "notes.md",
        "fonctionne/lancer-les-tests.md",
    }
    slug = repos[0]["slug"]
    assert rm.read_file(slug, "fonctionne/lancer-les-tests.md") == "pytest -q marche\n"
    assert rm.read_file(slug, "../repo.json") is None
    assert rm.read_file("..", "notes.md") is None
    assert rm.read_file(slug, "repo.json") is None


def test_routes_need_the_token(tmp_path):
    from openjarvis.server import terminal_routes as tr

    repo = tmp_path / "proj"
    repo.mkdir()
    rm.ensure_repo_memory(repo)
    app = FastAPI()
    app.include_router(rm.create_repo_memory_router())
    app.state.allowed_origins = ["http://localhost:5173"]
    app.state.bind_host = "127.0.0.1"
    client = TestClient(app, base_url="http://localhost:8010")
    good = {
        "origin": "http://localhost:5173",
        "host": "localhost:8010",
        wr.TOKEN_HEADER: tr.get_terminal_token(app),
    }
    assert client.get("/v1/memory/repos").status_code in (401, 403)
    res = client.get("/v1/memory/repos", headers=good)
    assert res.status_code == 200
    slug = res.json()["repos"][0]["slug"]
    ok = client.get(f"/v1/memory/repos/{slug}/files/notes.md", headers=good)
    assert ok.status_code == 200 and "Notes du repo" in ok.json()["text"]
    assert (
        client.get(f"/v1/memory/repos/{slug}/files/repo.json", headers=good).status_code
        == 404
    )
