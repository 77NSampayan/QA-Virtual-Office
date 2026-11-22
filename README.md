# Claude Code QA Virtual Office

A local-first, privacy-focused QA command center for Windows. Real Claude Code sessions show up as robots in a pixel-art QA office, alongside manual QA and test-automation workspaces.

**Current checkpoint: Pass 1A, the real-data proof of concept.** Real Claude Code hook events are captured on Windows, persisted locally in SQLite and shown live on a plain web console. The pixel-art office arrives in Pass 1C and the Electron shell in Pass 1D.

## Quick start (Windows, Node ≥ 22.12)

```powershell
npm install                 # npm 11 allowScripts: only better-sqlite3 and esbuild may run install scripts
npm test                    # unit + integration tests
npm run start               # builds forwarder + web UI, serves http://127.0.0.1:47821
npm run hooks:install       # user-level hooks (shows the cross-project warning and asks to confirm)
```

1. Open http://127.0.0.1:47821 and register a project: give it a safe alias and its folder.
2. Start `claude` in that folder. The session appears live.
3. Remove the hooks with `npm run hooks:uninstall`. Your previous `settings.json` is restored exactly.

## Layout

| Path | Contents |
|---|---|
| `packages/shared` | Event schema, sanitizer, Windows path matching, redaction, status machine (browser-safe and Node-only subpaths) |
| `apps/forwarder` | Hook forwarder, bundled into one self-contained `forward.mjs` |
| `apps/server` | Fastify REST + WebSocket, SQLite, collector, policy writer, installer CLI |
| `apps/web` | React UI (Pass 1A console) |
| `docs/` | [decisions](docs/decisions.md), [privacy](docs/privacy.md), [security](docs/security.md), [event schema](docs/event-schema.md) |

## Data

Everything lives in `%LOCALAPPDATA%\QA Virtual Office\`, protected by a current-user-only ACL:

| Item | Contents |
|---|---|
| `data.db` | SQLite database |
| `token` | Hook auth token |
| `folder-key.secret` | Secret for opaque folder keys |
| `capture-policy.json` | Capture policy |
| `hooks\forward.mjs` | Installed forwarder |
| `logs\` | Server and forwarder logs |
| `backups\claude-settings\` | Backups of your Claude Code `settings.json` |

Capture is **metadata-only**. No prompts, tool inputs or outputs, file contents, transcripts or paths are collected.

## Environment variables

| Variable | Purpose |
|---|---|
| `QAVO_PORT` | Collector/UI port (default 47821) |
| `QAVO_DATA_DIR` | Override the data directory (tests) |
| `QAVO_DEBUG_KEYS=1` | Forwarder logs payload **key names only** (never values), for schema discovery |
| `CLAUDE_CONFIG_DIR` | Honoured by the installer |
