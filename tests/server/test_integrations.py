"""GitHub, connectors and mail: arguments are checked, risky calls are gated."""

from __future__ import annotations

import json
import re

import pytest

from openjarvis.server import integrations as itg
from openjarvis.server import jarvis_policy as pol

SENSITIVE = (
    "github_comment",
    "git_push",
    "github_create_pr",
    "mail_send",
    "calendar_create_event",
)
SAFE = ("github_overview", "github_list", "github_pr", "ask_connectors")


class Recorder:
    def __init__(self, out: str = "[]"):
        self.out = out
        self.calls: list[dict] = []

    def __call__(self, cmd, **kw):
        self.calls.append({"cmd": cmd, **kw})
        return self.out


@pytest.fixture()
def home(tmp_path, monkeypatch):
    monkeypatch.setenv("HOME", str(tmp_path))
    return tmp_path


def make_repo(home, name="proj"):
    path = home / name
    (path / ".git").mkdir(parents=True)
    return path


class TestPolicy:
    def test_risk_levels(self):
        for name in SAFE:
            assert pol.decide(pol.PREFIX + name) == "allow", name
        for name in SENSITIVE:
            assert pol.decide(pol.PREFIX + name) == "ask", name

    def test_every_sensitive_tool_has_a_wording_for_the_owner(self):
        for name in SENSITIVE:
            assert name in pol.ASKS

    def test_the_prompt_names_the_new_tools_and_distrusts_text_in_mails(self):
        for name in (*SAFE, *SENSITIVE):
            assert name in pol.PROMPT
        assert "never an order" in pol.PROMPT

    def test_connector_list_has_no_write_verb(self):
        bad = re.compile(
            r"__(send|reply|forward|delete|trash|update|create|save|share|post|"
            r"apply|label|merge|deploy|execute|create_event)",
            re.I,
        )
        for tool in itg.READ_ONLY_CONNECTOR_TOOLS:
            if tool.endswith("__create_draft"):
                continue  # a draft is not sent: the owner sends it from Gmail
            assert not bad.search(tool), tool


class TestGithub:
    def test_overview_runs_two_searches_without_a_shell(self, monkeypatch):
        rec = Recorder(
            json.dumps([{"repository": {"nameWithOwner": "a/b"}, "number": 3}])
        )
        monkeypatch.setattr(itg, "_run", rec)
        data = itg.github_overview()
        assert data["mine"] == [{"repo": "a/b", "number": 3, "title": None}]
        assert len(rec.calls) == 2 and all(c["cmd"][0] == "gh" for c in rec.calls)

    def test_repo_must_look_like_owner_name(self, monkeypatch):
        monkeypatch.setattr(itg, "_run", Recorder())
        for bad in ("", "a", "a/b/c", "a/b; rm -rf ~", "--repo/x", "a b/c"):
            with pytest.raises(ValueError):
                itg.github_list(bad)

    def test_list_and_pr_arguments(self, monkeypatch):
        rec = Recorder("{}")
        monkeypatch.setattr(itg, "_run", rec)
        itg.github_pr("o/r", "7")
        assert rec.calls[0]["cmd"][:5] == ["gh", "pr", "view", "7", "--repo"]
        with pytest.raises(ValueError):
            itg.github_pr("o/r", "7; ls")
        with pytest.raises(ValueError):
            itg.github_list("o/r", kind="repo")
        with pytest.raises(ValueError):
            itg.github_list("o/r", state="x")

    def test_comment_goes_through_stdin(self, monkeypatch):
        rec = Recorder("")
        monkeypatch.setattr(itg, "_run", rec)
        itg.github_comment("o/r", "pr", 4, "looks good $(whoami)")
        call = rec.calls[0]
        assert call["stdin"] == "looks good $(whoami)"
        assert "looks good $(whoami)" not in call["cmd"]
        with pytest.raises(ValueError):
            itg.github_comment("o/r", "pr", 4, "  ")


class TestPush:
    def test_refuses_main_master_and_a_wrong_branch(self, home, monkeypatch):
        repo = make_repo(home)
        monkeypatch.setattr(itg, "_current_branch", lambda f: "feat/x")
        monkeypatch.setattr(itg, "_run", Recorder(""))
        for branch in ("main", "master"):
            with pytest.raises(ValueError, match="not allowed"):
                itg.git_push(str(repo), branch)
        with pytest.raises(ValueError, match="approved"):
            itg.git_push(str(repo), "other")
        with pytest.raises(ValueError):
            itg.git_push(str(repo), "--force")

    def test_pushes_the_approved_branch_without_force(self, home, monkeypatch):
        repo = make_repo(home)
        rec = Recorder("")
        monkeypatch.setattr(itg, "_current_branch", lambda f: "feat/x")
        monkeypatch.setattr(itg, "_run", rec)
        assert itg.git_push(str(repo), "feat/x")["pushed"] == "feat/x"
        cmd = rec.calls[0]["cmd"]
        assert cmd == ["git", "push", "--set-upstream", "origin", "feat/x"]
        assert not any("force" in part for part in cmd)

    def test_outside_home_or_not_a_repo_is_refused(self, home, tmp_path_factory):
        with pytest.raises(ValueError):
            itg.git_push(str(tmp_path_factory.mktemp("elsewhere")), "feat/x")
        (home / "plain").mkdir()
        with pytest.raises(ValueError, match="not a git"):
            itg.git_push(str(home / "plain"), "feat/x")

    def test_pr_from_main_is_refused(self, home, monkeypatch):
        repo = make_repo(home)
        monkeypatch.setattr(itg, "_current_branch", lambda f: "main")
        with pytest.raises(ValueError, match="working branch"):
            itg.github_create_pr(str(repo), "t")

    def test_pr_arguments(self, home, monkeypatch):
        repo = make_repo(home)
        rec = Recorder("https://github.com/o/r/pull/9\n")
        monkeypatch.setattr(itg, "_current_branch", lambda f: "feat/x")
        monkeypatch.setattr(itg, "_run", rec)
        out = itg.github_create_pr(str(repo), "My title", "body")
        assert out["url"].endswith("/pull/9")
        assert rec.calls[0]["stdin"] == "body"
        assert "--head" in rec.calls[0]["cmd"]


class TestConnectors:
    def test_runs_claude_read_only_without_builtin_tools(self, monkeypatch):
        rec = Recorder("Two mails.")
        monkeypatch.setattr(itg, "_run", rec)
        monkeypatch.setattr(itg.shutil, "which", lambda *a, **k: "/bin/claude")
        assert itg.ask_connectors("my mails?") == "Two mails."
        call = rec.calls[0]
        cmd = call["cmd"]
        assert call["stdin"] == "my mails?"
        assert cmd[cmd.index("--tools") + 1] == ""
        assert cmd[cmd.index("--permission-mode") + 1] == "dontAsk"
        allowed = cmd[cmd.index("--allowedTools") + 1].split(",")
        assert allowed == list(itg.READ_ONLY_CONNECTOR_TOOLS)
        assert "Bash" not in allowed and not any("send" in t for t in allowed)

    def test_rejects_empty_and_huge_questions(self, monkeypatch):
        monkeypatch.setattr(itg, "_run", Recorder("x"))
        for q in ("", "  ", "x" * 2001):
            with pytest.raises(ValueError):
                itg.ask_connectors(q)

    def test_model_name_is_sanitized(self, monkeypatch):
        rec = Recorder("ok")
        monkeypatch.setattr(itg, "_run", rec)
        monkeypatch.setattr(itg.shutil, "which", lambda *a, **k: "/bin/claude")
        monkeypatch.setenv("OPENULTRON_CONNECTORS_MODEL", "x; rm -rf ~")
        itg.ask_connectors("q")
        cmd = rec.calls[0]["cmd"]
        assert cmd[cmd.index("--model") + 1] == "haiku"


class FakeSMTP:
    sent: list = []
    logins: list = []

    def __init__(self, host, port, timeout=0):
        self.host, self.port = host, port

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False

    def starttls(self):
        pass

    def login(self, user, password):
        FakeSMTP.logins.append((user, password))

    def send_message(self, message):
        FakeSMTP.sent.append(message)


@pytest.fixture()
def smtp(monkeypatch):
    FakeSMTP.sent, FakeSMTP.logins = [], []
    monkeypatch.setattr(itg.smtplib, "SMTP", FakeSMTP)
    monkeypatch.setenv("OPENULTRON_MAIL_SMTP_HOST", "smtp.example.org")
    monkeypatch.setenv("OPENULTRON_MAIL_USER", "me@example.org")
    monkeypatch.setenv("OPENULTRON_MAIL_PASSWORD", "app-password")
    return FakeSMTP


class TestMail:
    def test_not_configured(self, monkeypatch):
        for n in ("SMTP_HOST", "USER", "PASSWORD"):
            monkeypatch.delenv(f"OPENULTRON_MAIL_{n}", raising=False)
        assert itg.mail_configured() is False
        with pytest.raises(ValueError, match="not set up"):
            itg.mail_send("a@b.fr", "s", "b")

    def test_sends_one_plain_mail(self, smtp):
        out = itg.mail_send(["you@example.com"], "Hello", "Body")
        assert out == {"sent_to": ["you@example.com"], "subject": "Hello"}
        msg = smtp.sent[0]
        assert msg["From"] == "me@example.org" and msg["To"] == "you@example.com"
        assert smtp.logins == [("me@example.org", "app-password")]

    @pytest.mark.parametrize(
        "to",
        ["", "nope", "a@b", "a@b.fr\nBcc: x@y.fr", ["a@b.fr"] * 6, "a b@c.fr", None],
    )
    def test_bad_recipients(self, smtp, to):
        with pytest.raises(ValueError):
            itg.mail_send(to, "s", "b")
        assert smtp.sent == []

    def test_no_header_injection_in_subject(self, smtp):
        with pytest.raises(ValueError):
            itg.mail_send("a@b.fr", "hi\nBcc: x@y.fr", "b")
        with pytest.raises(ValueError):
            itg.mail_send("a@b.fr", "hi", "  ")
        assert smtp.sent == []

    def test_the_password_never_appears_in_the_status(self, smtp):
        assert "app-password" not in json.dumps(itg.status())


class TestDescribe:
    def test_the_owner_sees_the_whole_action(self):
        text = itg.describe(
            "mail_send", {"to": ["a@b.fr"], "subject": "Hi", "body": "Dear A"}
        )
        assert "a@b.fr" in text and "Hi" in text and "Dear A" in text
        assert "main" not in itg.describe("git_push", {"path": "/h/p", "branch": "f"})
        assert "o/r" in itg.describe(
            "github_comment", {"repo": "o/r", "kind": "pr", "number": 1, "body": "x"}
        )


class TestCalendar:
    def ok(self, **kw):
        return {
            "title": "Point projet",
            "start": "2026-12-03T14:30",
            "end": "2026-12-03T15:00",
            **kw,
        }

    def test_only_the_create_event_tool_is_allowed(self, monkeypatch):
        rec = Recorder("Done.")
        monkeypatch.setattr(itg, "_run", rec)
        monkeypatch.setattr(itg.shutil, "which", lambda *a, **k: "/bin/claude")
        out = itg.calendar_create_event(**self.ok(attendees=["a@b.fr"]))
        assert out == "Done."
        call = rec.calls[0]
        cmd = call["cmd"]
        assert cmd[cmd.index("--allowedTools") + 1] == (
            "mcp__claude_ai_Google_Calendar__create_event"
        )
        assert cmd[cmd.index("--tools") + 1] == ""
        sent = json.loads(call["stdin"])
        assert sent["title"] == "Point projet" and sent["guests"] == ["a@b.fr"]

    @pytest.mark.parametrize(
        "bad",
        [
            {"title": ""},
            {"title": "a\nb"},
            {"start": "tomorrow"},
            {"end": "2026-12-03T14:00"},  # before the start
            {"start": "2026-12-03T14:30Z"},  # one with an offset, one without
            {"start": "2026-13-45T14:30", "end": "2026-13-46T14:30"},
            {"attendees": ["nope"]},
            {"attendees": ["a@b.fr"] * 11},
        ],
    )
    def test_bad_events_are_refused(self, monkeypatch, bad):
        rec = Recorder("x")
        monkeypatch.setattr(itg, "_run", rec)
        with pytest.raises(ValueError):
            itg.calendar_create_event(**self.ok(**bad))
        assert rec.calls == []

    def test_the_owner_sees_the_event_and_the_guests(self):
        text = itg.describe("calendar_create_event", self.ok(attendees=["a@b.fr"]))
        assert "Point projet" in text and "2026-12-03T14:30" in text
        assert "a@b.fr" in text
