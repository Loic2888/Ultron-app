@echo off
rem Ultron on Windows: starts the server inside WSL (Ubuntu) if it is not running,
rem then opens the workbench in its own Edge window (no tabs, no address bar).
rem NOT tested on a real Windows machine: adjust DISTRO and PORT if yours differ.
rem Prerequisite (once, in WSL): cd ~/OpenJarvis/frontend && npm run build

set DISTRO=Ubuntu
set PORT=8010
set URL=http://localhost:%PORT%/workspace

powershell -NoProfile -Command "try { exit ([int]((Invoke-WebRequest -UseBasicParsing http://localhost:%PORT%/health -TimeoutSec 2).StatusCode -ne 200)) } catch { exit 1 }" >nul 2>&1
if errorlevel 1 (
  start "" /min wsl.exe -d %DISTRO% --cd ~ -- bash -lc "nohup ~/.local/bin/jarvis serve --port %PORT% > /tmp/jarvis-serve.log 2>&1"
  for /l %%i in (1,1,60) do (
    powershell -NoProfile -Command "try { exit ([int]((Invoke-WebRequest -UseBasicParsing http://localhost:%PORT%/health -TimeoutSec 2).StatusCode -ne 200)) } catch { exit 1 }" >nul 2>&1
    if not errorlevel 1 goto ready
    timeout /t 1 /nobreak >nul
  )
  echo The Ultron server did not start. See /tmp/jarvis-serve.log inside WSL.
  pause
  exit /b 1
)
:ready
start "" msedge --app=%URL%
