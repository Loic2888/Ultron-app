"""jarvis desktop: which program opens the application window."""

from __future__ import annotations

import subprocess

from openjarvis.cli import desktop_cmd as dc

URL = "http://localhost:8010/workspace"


def test_wsl_uses_windows_edge_then_chrome():
    cmds = dc.app_window_commands(
        URL, platform="linux", wsl=True, which=lambda n: "/x/" + n
    )
    assert cmds[0] == ["cmd.exe", "/c", "start", "", "msedge", f"--app={URL}"]
    assert cmds[1][4] == "chrome"


def test_linux_picks_installed_browsers_only():
    have = {"chromium": "/usr/bin/chromium"}
    cmds = dc.app_window_commands(
        URL, platform="linux", wsl=False, which=lambda n: have.get(n)
    )
    assert cmds == [["/usr/bin/chromium", f"--app={URL}"]]


def test_linux_without_browser_gives_nothing():
    assert (
        dc.app_window_commands(URL, platform="linux", wsl=False, which=lambda n: None)
        == []
    )


def test_macos_and_windows():
    mac = dc.app_window_commands(
        URL, platform="darwin", wsl=False, which=lambda n: None
    )
    assert mac[0][:3] == ["open", "-na", "Microsoft Edge"]
    win = dc.app_window_commands(URL, platform="win32", wsl=False, which=lambda n: None)
    assert win[0][-2:] == ["msedge", f"--app={URL}"]


def test_open_app_window_tries_next_browser(monkeypatch):
    monkeypatch.setattr(dc, "is_wsl", lambda release=None: False)
    monkeypatch.setattr(dc.sys, "platform", "linux")
    monkeypatch.setattr(
        dc.shutil,
        "which",
        lambda n: "/b/" + n if n.startswith(("microsoft-edge", "chromium")) else None,
    )
    seen = []

    def run(command, **kw):
        seen.append(command[0])
        code = 1 if "edge" in command[0] else 0
        return subprocess.CompletedProcess(command, code)

    assert dc.open_app_window(URL, run=run) is True
    assert any("edge" in c for c in seen) and seen[-1].endswith("chromium")


def test_open_app_window_false_when_all_fail(monkeypatch):
    monkeypatch.setattr(dc, "is_wsl", lambda release=None: False)
    monkeypatch.setattr(dc.sys, "platform", "linux")
    monkeypatch.setattr(dc.shutil, "which", lambda n: "/b/" + n)

    def run(command, **kw):
        raise OSError("nope")

    assert dc.open_app_window(URL, run=run) is False


def test_is_wsl():
    assert dc.is_wsl("6.6.87.2-microsoft-standard-WSL2")
    assert not dc.is_wsl("6.8.0-generic")


def test_installed_app_is_launched_by_its_id():
    cmds = dc.app_window_commands(
        "http://localhost:8010/workspace",
        platform="linux",
        wsl=True,
        which=lambda name: "/x/cmd.exe" if name == "cmd.exe" else None,
        app_id="abcdefghijklmnopabcdefghijklmnop",
    )
    assert cmds[0][-1] == "--app-id=abcdefghijklmnopabcdefghijklmnop"
    assert all("--app=" not in part for cmd in cmds for part in cmd)


def test_shortcut_script_runs_jarvis_desktop_in_the_right_distro():
    script = dc.shortcut_script(
        distro="Ubuntu", jarvis="/home/u/.local/bin/jarvis", icon_src=r"C:\a\f.ico"
    )
    assert "wsl.exe" in script
    assert "-d Ubuntu --cd ~ --" in script
    assert "/home/u/.local/bin/jarvis desktop" in script
    assert "Jarvis.lnk" in script and "WindowStyle = 7" in script
    assert "IconLocation" in script


def test_shortcut_script_escapes_quotes_and_works_without_icon():
    script = dc.shortcut_script(distro="U'x", jarvis="/j", icon_src=None)
    assert "U''x" in script
    assert "IconLocation" not in script


def test_shortcut_script_passes_the_app_id_to_the_launcher():
    app_id = "l" * 32
    script = dc.shortcut_script(distro="U", jarvis="/j", icon_src=None, app_id=app_id)
    assert f"JARVIS_APP_ID={app_id} /j desktop" in script
