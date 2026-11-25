"""``jarvis desktop``: open the workbench as a desktop application window.

No Vite and no Node process: the API server (one light Python process) serves
the built workbench itself, and the page opens in its own browser window
without tabs or address bar (Edge/Chrome "app" mode). The server it starts stops
by itself when the window is closed (see ``server/presence.py``); a server that
was already running is left alone, and ``jarvis stop`` always ends it.
"""

from __future__ import annotations

import os
import re
import shutil
import subprocess
import sys
from pathlib import Path

import click
from rich.console import Console

from openjarvis.cli.gui_cmd import (
    _api_healthy,
    _daemon_pid_alive,
    _frontend_dir,
    _wait_for_api,
)

_LINUX_BROWSERS = (
    "microsoft-edge",
    "microsoft-edge-stable",
    "google-chrome",
    "google-chrome-stable",
    "chromium",
    "chromium-browser",
)
_MACOS_APPS = ("Microsoft Edge", "Google Chrome", "Chromium")
_WINDOWS_BROWSERS = ("msedge", "chrome")


def is_wsl(release: str | None = None) -> bool:
    """True inside WSL (Linux kernel built by Microsoft)."""
    text = release if release is not None else os.uname().release
    return "microsoft" in text.lower()


def app_window_commands(
    url: str, *, platform: str, wsl: bool, which=None, app_id: str | None = None
):
    """Commands to try, in order, to open *url* as an application window.

    Pure function (the lookup of programs is injected) so it can be tested.
    """
    which = which or shutil.which
    # An installed app (see docs) opens without a title bar: its buttons are
    # drawn inside the page. `--app-id` launches that installed app.
    app = f"--app-id={app_id}" if app_id else f"--app={url}"
    if wsl and which("cmd.exe"):
        # `start` finds msedge/chrome through the Windows "App Paths".
        return [
            ["cmd.exe", "/c", "start", "", browser, app]
            for browser in _WINDOWS_BROWSERS
        ]
    if platform == "win32":
        return [
            ["cmd", "/c", "start", "", browser, app] for browser in _WINDOWS_BROWSERS
        ]
    if platform == "darwin":
        return [["open", "-na", name, "--args", app] for name in _MACOS_APPS]
    return [[found, app] for name in _LINUX_BROWSERS if (found := which(name))]


def open_app_window(url: str, *, run=subprocess.run) -> bool:
    """Open *url* in an application window; False if no browser accepted."""
    cwd = "/mnt/c" if is_wsl() and Path("/mnt/c").is_dir() else None
    app_id = (os.environ.get("JARVIS_APP_ID") or "").strip() or None
    for command in app_window_commands(
        url, platform=sys.platform, wsl=is_wsl(), app_id=app_id
    ):
        try:
            result = run(
                command,
                cwd=cwd,
                check=False,
                capture_output=True,
                timeout=20,
            )
        except (OSError, subprocess.SubprocessError):
            continue
        if result.returncode == 0:
            return True
    return False


def shortcut_script(
    *,
    distro: str,
    jarvis: str,
    icon_src: str | None,
    name: str = "Ultron",
    app_id: str | None = None,
) -> str:
    """PowerShell that puts a *name* icon on the Windows desktop.

    Clicking it runs ``jarvis desktop`` inside WSL (starts the server if needed,
    then opens the window). The console is minimised and closes by itself.
    """
    quote = lambda text: "'" + text.replace("'", "''") + "'"  # noqa: E731
    # With an installed Edge app, its id makes the window open without a title bar.
    env = f"JARVIS_APP_ID={app_id} " if app_id else ""
    args = f'-d {distro} --cd ~ -- bash -lc "{env}{jarvis} desktop"'
    icon = ""
    if icon_src:
        icon = (
            "$dir = Join-Path $env:LOCALAPPDATA 'Ultron'; "
            "New-Item -ItemType Directory -Force $dir | Out-Null; "
            # A name that changes with the picture: Windows caches icons by path.
            f"$h = (Get-FileHash {quote(icon_src)}).Hash.Substring(0, 8); "
            "$ico = Join-Path $dir ('jarvis-' + $h + '.ico'); "
            f"Copy-Item -Force {quote(icon_src)} $ico; "
            "$s.IconLocation = $ico; "
        )
    return (
        "$desk = [Environment]::GetFolderPath('Desktop'); "
        "$sh = New-Object -ComObject WScript.Shell; "
        f"$s = $sh.CreateShortcut((Join-Path $desk {quote(name + '.lnk')})); "
        "$s.TargetPath = 'wsl.exe'; "
        f"$s.Arguments = {quote(args)}; "
        "$s.WindowStyle = 7; "
        f"{icon}"
        "$s.Save(); "
        "& ie4uinit.exe -show; "
        "Write-Output $s.FullName"
    )


def create_desktop_shortcut(*, run=subprocess.run, app_id: str | None = None) -> str:
    """Create the desktop icon (WSL only). Returns the Windows path of the .lnk."""
    if app_id is not None and not re.fullmatch(r"[a-p]{32}", app_id):
        raise click.ClickException("The app id is 32 letters (see edge://apps).")
    powershell = shutil.which("powershell.exe")
    distro = os.environ.get("WSL_DISTRO_NAME")
    if not is_wsl() or powershell is None or not distro:
        raise click.ClickException(
            "The desktop icon is created from WSL (Ubuntu on Windows)."
        )
    launcher = Path.home() / ".local" / "bin" / "jarvis"
    jarvis = str(launcher) if launcher.is_file() else shutil.which("jarvis")
    if not jarvis:
        raise click.ClickException("The `jarvis` command was not found.")
    ico = _frontend_dir()
    icon_src = None
    if ico is not None and (ico / "public" / "favicon.ico").is_file():
        icon_src = subprocess.run(
            ["wslpath", "-w", str(ico / "public" / "favicon.ico")],
            capture_output=True,
            text=True,
            check=False,
        ).stdout.strip()
    result = run(
        [
            powershell,
            "-NoProfile",
            "-Command",
            shortcut_script(
                distro=distro,
                jarvis=jarvis,
                icon_src=icon_src or None,
                app_id=app_id,
            ),
        ],
        capture_output=True,
        text=True,
        check=False,
    )
    if result.returncode != 0:
        raise click.ClickException(
            "Could not create the icon: " + (result.stderr or "").strip()[:300]
        )
    return (result.stdout or "").strip()


def _static_dir() -> Path:
    return Path(__file__).resolve().parents[1] / "server" / "static"


@click.command()
@click.option("--api-port", default=8010, show_default=True, help="Port of the API.")
@click.option("--no-window", is_flag=True, help="Only start the server.")
@click.option(
    "--create-shortcut",
    is_flag=True,
    help="Put an Ultron icon on the Windows desktop (from WSL), then stop.",
)
@click.option(
    "--app-id",
    default=None,
    help="Edge app id (edge://apps): the icon then opens the installed app window.",
)
def desktop(
    api_port: int, no_window: bool, create_shortcut: bool, app_id: str | None
) -> None:
    """Open Ultron as a desktop application window (light: no Node process)."""
    console = Console(stderr=True)
    if create_shortcut:
        path = create_desktop_shortcut(
            app_id=(app_id or os.environ.get("JARVIS_APP_ID") or "").strip() or None
        )
        console.print(f"[green]Desktop icon created:[/green] {path}")
        return
    if not (_static_dir() / "index.html").is_file():
        frontend = _frontend_dir()
        npm = shutil.which("npm") or shutil.which("npm.cmd")
        if frontend is None or npm is None:
            raise click.ClickException(
                "The workbench is not built. From the source checkout run: "
                "cd frontend && npm install && npm run build"
            )
        console.print("Building the workbench once (about a minute)…")
        built = subprocess.run([npm, "run", "build"], cwd=frontend, check=False)
        if built.returncode != 0:
            raise click.ClickException("The build failed; see the messages above.")

    uv = shutil.which("uv")
    if _api_healthy(api_port):
        if not _daemon_pid_alive(api_port, require_ready=True):
            raise click.ClickException(
                f"Port {api_port} is served by something other than Ultron's server."
            )
        # Never restarted from here: stopping and starting is done by hand.
        console.print(
            f"[green]Using the server already running on port {api_port}.[/green]"
        )
    if not _api_healthy(api_port):
        if uv is None:
            raise click.ClickException("uv is required to start the server.")
        root = Path(__file__).resolve().parents[3]
        started = subprocess.run(
            [
                uv,
                "run",
                "--extra",
                "desktop",
                "jarvis",
                "start",
                "--port",
                str(api_port),
            ],
            cwd=root,
            check=False,
            # This server stops by itself when the app window is closed.
            env={**os.environ, "JARVIS_STOP_WHEN_CLOSED": "1"},
        )
        if started.returncode != 0 or not _wait_for_api(api_port):
            raise click.ClickException("Could not start the Ultron server.")

    url = f"http://localhost:{api_port}/workspace"
    if no_window:
        console.print(f"Server ready: {url}")
        return
    if open_app_window(url):
        console.print(f"[green]Ultron opened in its own window:[/green] {url}")
    else:
        console.print(
            f"[yellow]No Edge or Chrome could open an application window. "
            f"Open {url} in your browser.[/yellow]"
        )
