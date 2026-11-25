# Windows 10 compatibility review (2026-11-25)

**Status: reviewed in code, NOT tested on Windows 10.** This machine runs Windows 11 (10.0.26300); no Windows 10 machine or VM is available here, so nothing below has been run on Windows 10. Open item D4 stays open until the checklist at the end is done on a real Windows 10 PC.

**Review of what the app depends on**

| Area | What it uses | Windows 10 expectation |
|---|---|---|
| Windows tools | `cmd.exe /c start`, `icacls.exe`, `whoami.exe`, all from `%SystemRoot%\System32` | Present on every Windows 10; no Windows 11-only tools (no `wt.exe`, no PowerShell cmdlets, no `wmic`) |
| Data folder and permissions | `%LOCALAPPDATA%\QA Virtual Office`, owner-only ACL via `icacls /inheritance:r /grant:r` | Same on Windows 10 |
| Desktop shell | Electron 45 (Windows 10 and later), `setAppUserModelId`, Electron `Notification` for toasts | Supported; toast appearance and Focus Assist behaviour differ slightly from Windows 11 |
| Server | Node 22.12 or later, `better-sqlite3` 12 (prebuilt binary) | Node 22+ and the prebuilt binary target Windows 10; check `npm install` finds a binary rather than compiling |
| Web UI | Plain CSS and canvas, no OS-specific feature | Runs in any current Edge, Chrome or Electron |
| Launch Claude Code here | `cmd.exe start` in a new console window | Same on Windows 10 (classic console host rather than Windows Terminal; colours may differ) |
| Browser tests | Edge at `C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe` | Edge is preinstalled on current Windows 10, same path |

**Risks, in order:** (1) toast delivery with Focus Assist or a missing start-menu shortcut identity, (2) `better-sqlite3` install if no prebuilt binary matches, (3) console colours in the classic console host. No code path was found that would fail on Windows 10.

**Checklist for a person with a Windows 10 PC** (about 15 minutes): install and start the app; open Overview (robots walk, no console errors); register a project; run Reinstall hooks and start Claude Code in it (a robot appears); trigger a permission request (a toast appears; clicking it opens the Control Room); press "Launch Claude Code here"; confirm the data folder is owner-only (`icacls "%LOCALAPPDATA%\QA Virtual Office"`); run `npm test` and `npm run e2e`.
