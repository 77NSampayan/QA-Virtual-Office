# Claude Code QA Virtual Office

A local-first, privacy-focused QA command center for Windows. Real Claude Code sessions show up as robots in a pixel-art QA office, alongside manual QA and test-automation workspaces.

**Current checkpoint: Pass 2B, Manual QA: test execution and evidence.** (Pass 1, the office and desktop app, is complete.) Real Claude Code sessions appear as animated pixel-art robots at their workstations, grouped into Manual QA and Automation departments, with Project Rooms, a QA Control Room, robot customization and a notification center. Everything shown comes from real hook events; unbuilt modules say so. `npm run desktop` opens it as a Windows app with a tray icon, toast notifications and start-with-Windows. **Manual QA** (sidebar) manages requirements, test cases with a human-only approval workflow, traceability, and manual test runs with evidence (Execution tab).

## Quick start (Windows, Node ≥ 22.12)

```powershell
npm install                 # npm 11 allowScripts: only better-sqlite3 and esbuild may run install scripts
npm test                    # unit + integration tests
npm run start               # builds forwarder + web UI, serves http://127.0.0.1:47821 and opens a ONE-TIME login link
npm run hooks:install       # user-level hooks (shows the cross-project warning and asks to confirm)
```

1. The dashboard only opens through the one-time link printed (and opened) by `npm run start`. For a fresh link later: `npm run launch`.
2. Register a project: give it a safe alias and its folder.
3. Start `claude` in that folder. The session appears live.
4. Settings has install/uninstall (with a dry-run review), privacy toggles, scope, excluded folders, retention, backups and export.
5. Remove the hooks with `npm run hooks:uninstall`. Your previous `settings.json` is restored exactly.

Desktop app: `npm run desktop` starts (or attaches to) the server and opens the app; `npm run desktop:build` only bundles it.

Other commands: `npm run statusline:install` / `statusline:uninstall` (opt-in usage line; wraps an existing one), `npm run db:backups` / `db:check` / `db:restore -- <name>`, `npm run e2e` (browser tests; needs Microsoft Edge).

## Layout

| Path | Contents |
|---|---|
| `packages/shared` | Event schema, sanitizer, Windows path matching, redaction, status machine (browser-safe and Node-only subpaths) |
| `apps/forwarder` | Hook forwarder, bundled into one self-contained `forward.mjs` |
| `apps/server` | Fastify REST + WebSocket, SQLite, collector, policy writer, installer CLI |
| `apps/desktop` | Electron shell: secure window, tray, toasts, login item, single instance; runs the server as a child process on system Node |
| `apps/web` | React UI: office, rooms, control room, robots, notifications, settings; code-drawn pixel sprites (`src/sprites`) |
| `docs/` | [decisions](docs/decisions.md), [privacy](docs/privacy.md), [security](docs/security.md), [event schema](docs/event-schema.md) |

## Data

Everything lives in `%LOCALAPPDATA%\QA Virtual Office\`, protected by a current-user-only ACL:

| Item | Contents |
|---|---|
| `data.db` | SQLite database |
| `token` | Hook auth token |
| `spool.jsonl` | Sanitized events waiting for replay while the server was down |
| `folder-key.secret` | Secret for opaque folder keys |
| `capture-policy.json` | Capture policy |
| `hooks\forward.mjs` | Installed forwarder |
| `logs\` | Server and forwarder logs |
| `backups\` | Daily verified database backups (newest 7); `backups\claude-settings\` holds backups of your Claude Code `settings.json` |

Capture is **metadata-only**. No prompts, tool inputs or outputs, file contents, transcripts or paths are collected.

## Environment variables

| Variable | Purpose |
|---|---|
| `QAVO_PORT` | Collector/UI port (default 47821) |
| `QAVO_DATA_DIR` | Override the data directory (tests) |
| `QAVO_DEBUG_KEYS=1` | Forwarder logs payload **key names only** (never values), for schema discovery |
| `CLAUDE_CONFIG_DIR` | Honoured by the installer |
