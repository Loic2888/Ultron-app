"""Workspace file endpoints: confinement and gates matter more than the happy path."""

from __future__ import annotations

import os
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from openjarvis.server import terminal_routes as tr
from openjarvis.server import workspace_routes as wr

posix_only = pytest.mark.skipif(os.name != "posix", reason="POSIX paths")

FRONTEND = "http://localhost:5173"
LOCAL_HOST = "localhost:8010"


@pytest.fixture()
def home(tmp_path, monkeypatch):
    monkeypatch.setenv("HOME", str(tmp_path))
    return tmp_path.resolve()


def _app(bind_host: str | None = "127.0.0.1") -> FastAPI:
    app = FastAPI()
    app.include_router(wr.create_workspace_router())
    app.state.allowed_origins = [FRONTEND]
    if bind_host is not None:
        app.state.bind_host = bind_host
    return app


def _client(app: FastAPI | None = None) -> tuple[TestClient, dict[str, str]]:
    app = app or _app()
    client = TestClient(app, base_url="http://localhost:8010")
    headers = {
        "origin": FRONTEND,
        "host": LOCAL_HOST,
        wr.TOKEN_HEADER: tr.get_terminal_token(app),
    }
    return client, headers


# ---------------------------------------------------------------------------
# Pure helpers
# ---------------------------------------------------------------------------


@posix_only
class TestResolveInsideHome:
    def test_default_is_home(self, home):
        assert wr.resolve_inside_home("", home) == home

    def test_relative_and_absolute(self, home):
        (home / "a").mkdir()
        assert wr.resolve_inside_home("a", home) == home / "a"
        assert wr.resolve_inside_home(str(home / "a"), home) == home / "a"

    def test_rejects_outside(self, home):
        with pytest.raises(ValueError, match="inside"):
            wr.resolve_inside_home("/etc", home)
        with pytest.raises(ValueError, match="inside"):
            wr.resolve_inside_home("../", home)

    def test_rejects_symlink_escape(self, home, tmp_path_factory):
        outside = tmp_path_factory.mktemp("outside")
        (home / "link").symlink_to(outside)
        with pytest.raises(ValueError, match="inside"):
            wr.resolve_inside_home("link", home)

    def test_missing_path(self, home):
        with pytest.raises(ValueError, match="exist"):
            wr.resolve_inside_home("nope", home)

    def test_new_file_needs_parent(self, home):
        with pytest.raises(ValueError, match="Parent"):
            wr.resolve_inside_home("no/dir/file.txt", home, must_exist=False)
        assert wr.resolve_inside_home("new.txt", home, must_exist=False) == (
            home / "new.txt"
        )

    def test_new_file_invalid_name(self, home):
        # "." and a trailing "/" are erased by pathlib; ".." must be refused.
        with pytest.raises(ValueError, match="Invalid"):
            wr.resolve_inside_home(f"{home}/..", home, must_exist=False)

    def test_new_file_through_escaping_symlink(self, home, tmp_path_factory):
        outside = tmp_path_factory.mktemp("outside")
        (outside / "target.txt").write_text("x")
        (home / "evil.txt").symlink_to(outside / "target.txt")
        with pytest.raises(ValueError, match="inside"):
            wr.resolve_inside_home("evil.txt", home, must_exist=False)


class TestHelpers:
    def test_decode_text(self):
        assert wr.decode_text("héllo".encode()) == "héllo"
        with pytest.raises(ValueError, match="Binary"):
            wr.decode_text(b"ab\x00cd")
        with pytest.raises(ValueError, match="UTF-8"):
            wr.decode_text(b"\xff\xfe\xfa")

    def test_inside_git_dir(self):
        assert wr.inside_git_dir(Path("/h/r/.git/config"))
        assert not wr.inside_git_dir(Path("/h/r/.github/x.yml"))

    def test_list_entries_order(self, tmp_path):
        (tmp_path / "b.txt").write_text("1")
        (tmp_path / "A.txt").write_text("22")
        (tmp_path / "zdir").mkdir()
        (tmp_path / "adir").mkdir()
        entries, truncated = wr.list_entries(tmp_path)
        assert [e["name"] for e in entries] == ["adir", "zdir", "A.txt", "b.txt"]
        assert entries[2]["size"] == 2
        assert not truncated
        dirs, _ = wr.list_entries(tmp_path, dirs_only=True)
        assert [e["name"] for e in dirs] == ["adir", "zdir"]

    def test_read_branch(self, tmp_path):
        assert wr.read_branch(tmp_path) is None
        git = tmp_path / ".git"
        git.mkdir()
        (git / "HEAD").write_text("ref: refs/heads/feat/x\n")
        assert wr.read_branch(tmp_path) == "feat/x"
        (git / "HEAD").write_text("0123456789abcdef\n")
        assert wr.read_branch(tmp_path) == "01234567"

    def test_read_branch_worktree(self, tmp_path):
        real = tmp_path / "real-git"
        real.mkdir()
        (real / "HEAD").write_text("ref: refs/heads/main\n")
        repo = tmp_path / "wt"
        repo.mkdir()
        (repo / ".git").write_text(f"gitdir: {real}\n")
        assert wr.read_branch(repo) == "main"

    def test_atomic_write_keeps_mode(self, tmp_path):
        target = tmp_path / "run.sh"
        target.write_text("old")
        target.chmod(0o755)
        wr.atomic_write(target, b"new")
        assert target.read_text() == "new"
        assert target.stat().st_mode & 0o777 == 0o755
        assert [p.name for p in tmp_path.iterdir()] == ["run.sh"]  # no temp left


# ---------------------------------------------------------------------------
# Gates
# ---------------------------------------------------------------------------


@posix_only
class TestGates:
    def test_missing_token(self, home):
        c, h = _client()
        h.pop(wr.TOKEN_HEADER)
        assert c.get("/v1/workspace/tree", headers=h).status_code == 403

    def test_wrong_token(self, home):
        c, h = _client()
        h[wr.TOKEN_HEADER] = "nope"
        assert c.get("/v1/workspace/tree", headers=h).status_code == 403

    def test_hostile_origin(self, home):
        c, h = _client()
        h["origin"] = "https://evil.example"
        assert c.get("/v1/workspace/tree", headers=h).status_code == 403

    def test_rebinding_host(self, home):
        c, h = _client()
        h["host"] = "evil.example:8010"
        assert c.get("/v1/workspace/tree", headers=h).status_code == 403

    def test_server_not_local(self, home):
        c, h = _client(_app("0.0.0.0"))
        assert c.get("/v1/workspace/tree", headers=h).status_code == 403

    def test_bind_host_unknown(self, home):
        c, h = _client(_app(None))
        assert c.get("/v1/workspace/tree", headers=h).status_code == 403

    @pytest.mark.parametrize(
        "method,url",
        [
            ("get", "/v1/workspace/home"),
            ("get", "/v1/workspace/repo?path=."),
            ("get", "/v1/workspace/file?path=x"),
            ("put", "/v1/workspace/file"),
        ],
    )
    def test_every_endpoint_is_guarded(self, home, method, url):
        c, _ = _client()
        res = getattr(c, method)(
            url,
            headers={"origin": FRONTEND, "host": LOCAL_HOST},
            **({"json": {"path": "x", "content": "y"}} if method == "put" else {}),
        )
        assert res.status_code == 403


# ---------------------------------------------------------------------------
# Behaviour
# ---------------------------------------------------------------------------


@posix_only
class TestEndpoints:
    def test_home(self, home):
        c, h = _client()
        assert c.get("/v1/workspace/home", headers=h).json() == {"home": str(home)}

    def test_repo_info(self, home):
        repo = home / "proj"
        (repo / ".git").mkdir(parents=True)
        (repo / ".git" / "HEAD").write_text("ref: refs/heads/dev\n")
        c, h = _client()
        data = c.get("/v1/workspace/repo", params={"path": str(repo)}, headers=h).json()
        assert data == {
            "path": str(repo),
            "name": "proj",
            "is_git": True,
            "branch": "dev",
        }

    def test_repo_errors(self, home):
        (home / "f.txt").write_text("x")
        c, h = _client()
        assert (
            c.get("/v1/workspace/repo", params={"path": "/etc"}, headers=h).status_code
            == 403
        )
        assert (
            c.get("/v1/workspace/repo", params={"path": "zz"}, headers=h).status_code
            == 404
        )
        assert (
            c.get("/v1/workspace/repo", params={"path": "f.txt"}, headers=h).status_code
            == 400
        )

    def test_tree(self, home):
        (home / "d").mkdir()
        (home / "f.txt").write_text("x")
        c, h = _client()
        data = c.get("/v1/workspace/tree", headers=h).json()
        assert [e["name"] for e in data["entries"]] == ["d", "f.txt"]
        assert (
            c.get("/v1/workspace/tree", params={"path": "/etc"}, headers=h).status_code
            == 403
        )
        assert (
            c.get("/v1/workspace/tree", params={"path": "f.txt"}, headers=h).status_code
            == 400
        )

    def test_read_write_roundtrip(self, home):
        c, h = _client()
        target = home / "notes.txt"
        res = c.put(
            "/v1/workspace/file",
            json={"path": str(target), "content": "salut\n"},
            headers=h,
        )
        assert res.status_code == 200
        assert target.read_text() == "salut\n"
        got = c.get(
            "/v1/workspace/file", params={"path": str(target)}, headers=h
        ).json()
        assert got["content"] == "salut\n"

    def test_dirs_only_flags_repositories(self, home):
        (home / "repo" / ".git").mkdir(parents=True)
        (home / "plain").mkdir()
        c, h = _client()
        data = c.get("/v1/workspace/tree", params={"dirs_only": True}, headers=h).json()
        flags = {e["name"]: e["is_git"] for e in data["entries"]}
        assert flags == {"plain": False, "repo": True}

    def test_stale_write_is_refused(self, home):
        c, h = _client()
        target = home / "a.txt"
        first = c.put(
            "/v1/workspace/file", json={"path": str(target), "content": "v1"}, headers=h
        ).json()
        # someone else (Claude Code, a terminal...) changes the file
        target.write_text("changed elsewhere")
        os.utime(target, ns=(1, int(first["mtime"]) + 5_000_000_000))
        res = c.put(
            "/v1/workspace/file",
            json={
                "path": str(target),
                "content": "v2",
                "expected_mtime": first["mtime"],
            },
            headers=h,
        )
        assert res.status_code == 409
        assert target.read_text() == "changed elsewhere"

    def test_write_with_current_mtime_succeeds(self, home):
        c, h = _client()
        target = home / "a.txt"
        first = c.put(
            "/v1/workspace/file", json={"path": str(target), "content": "v1"}, headers=h
        ).json()
        read = c.get(
            "/v1/workspace/file", params={"path": str(target)}, headers=h
        ).json()
        assert read["mtime"] == first["mtime"]
        res = c.put(
            "/v1/workspace/file",
            json={
                "path": str(target),
                "content": "v2",
                "expected_mtime": read["mtime"],
            },
            headers=h,
        )
        assert res.status_code == 200
        assert target.read_text() == "v2"

    def test_write_outside_home(self, home):
        c, h = _client()
        res = c.put(
            "/v1/workspace/file",
            json={"path": "/tmp/jarvis-evil.txt", "content": "x"},
            headers=h,
        )
        assert res.status_code == 403
        assert not Path("/tmp/jarvis-evil.txt").exists()

    def test_write_inside_dot_git_refused(self, home):
        (home / "r" / ".git").mkdir(parents=True)
        c, h = _client()
        res = c.put(
            "/v1/workspace/file",
            json={"path": str(home / "r" / ".git" / "config"), "content": "x"},
            headers=h,
        )
        assert res.status_code == 403
        assert not (home / "r" / ".git" / "config").exists()

    def test_write_onto_folder_refused(self, home):
        (home / "d").mkdir()
        c, h = _client()
        res = c.put(
            "/v1/workspace/file",
            json={"path": str(home / "d"), "content": "x"},
            headers=h,
        )
        assert res.status_code == 400

    def test_read_binary_and_big(self, home, monkeypatch):
        (home / "b.bin").write_bytes(b"\x00\x01\x02")
        (home / "big.txt").write_text("x" * 50)
        monkeypatch.setattr(wr, "MAX_READ_BYTES", 10)
        c, h = _client()
        assert (
            c.get("/v1/workspace/file", params={"path": "b.bin"}, headers=h).status_code
            == 415
        )
        assert (
            c.get(
                "/v1/workspace/file", params={"path": "big.txt"}, headers=h
            ).status_code
            == 413
        )

    def test_write_too_large(self, home, monkeypatch):
        monkeypatch.setattr(wr, "MAX_WRITE_BYTES", 5)
        c, h = _client()
        res = c.put(
            "/v1/workspace/file",
            json={"path": str(home / "a.txt"), "content": "123456"},
            headers=h,
        )
        assert res.status_code == 413
        assert not (home / "a.txt").exists()

    def test_no_delete_or_rename_route(self, home):
        c, h = _client()
        assert (
            c.delete("/v1/workspace/file", params={"path": "x"}, headers=h).status_code
            == 405
        )
