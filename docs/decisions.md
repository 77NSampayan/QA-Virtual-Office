# Architecture Decision Log

Status key: **Approved** = confirmed by the product owner during planning (plan revisions 1–3, 2026-11-22).

| # | Decision | Status | Rationale |
|---|---|---|---|
| ADR-001 | **Real-data core first.** Pass 1 delivers foundation → Claude Code collector → office UI before the QA workspaces. | Approved | Robots must reflect real events; building the data path first avoids mock-driven UI. |
| ADR-002 | **Pass 1 checkpoints 1A → 1B → 1C → 1D.** Each checkpoint has acceptance criteria and stops for review before the next begins. | Approved | Incremental validation; no checkpoint starts until the previous one is demonstrated. |
| ADR-003 | **Electron** for the desktop shell (Pass 1D). | Approved | Tauri would need Rust + MSVC build tools, which this machine doesn't have. Electron offers built-in tray, Windows toasts and DPAPI (`safeStorage`). |
| ADR-004 | **User-level Claude Code hooks**, installed by the app with a backup, merging only its own handlers. | Approved | One install covers every session. The cross-project implication is mitigated by ADR-007 and stated on install. |
| ADR-005 | **Code-drawn pixel sprites** (pixel matrices + palettes rendered to canvas). | Approved | Fully recolorable and no asset licensing. Sprite sheets can be swapped in later. |
| ADR-006 | Data directory **`%LOCALAPPDATA%\QA Virtual Office\`** with a current-user-only NTFS ACL. | Approved | Per-user, non-roaming, local-first. |
| ADR-007 | Default monitoring scope **"Registered projects only"**. The forwarder drops events from unregistered folders *before sending*. | Approved | User-level hooks fire everywhere, so the safest default is to capture nothing outside registered projects. |
| ADR-008 | **Metadata-only capture by default.** Prompts, tool inputs, tool outputs, notification text and transcripts are never collected unless explicitly opted in; opted-in content is redacted and truncated. | Approved | Privacy is mandatory, and org policy forbids customer PII in data provided to Claude. |
| ADR-009 | **Forwarder-side project resolution.** The cwd never leaves the hook process: only a `projectId` (or opaque HMAC folder keys in All-sessions scope) is sent. Users choose a safe display alias. | Approved | Even home-masked paths reveal folder names. |
| ADR-010 | **Async `command` hooks only** (never `http` hooks). The forwarder always exits 0 and the collector always replies `204` with an empty body. | Approved | HTTP hooks are synchronous, so a hung collector would stall Claude. This way the app can't block, approve or deny anything. |
| ADR-011 | **One-time launch-token cookie authentication** for the UI and API (implemented in Pass 1B). | Approved | Stops other local web pages and processes from reading QA data through the API. |
| ADR-012 | **Synthetic E2E fixtures isolated from the production DB**: they're used only in automated tests and in a separate `demo.db`. | Approved | Production monitoring must never mix real and mock data. |
| ADR-013 | Forked sessions get a **new session and robot identity**. Resumed sessions keep theirs. A parent link is stored only if the payload actually carries one. | Approved | Concurrent forks must be represented independently, and nothing is inferred. |
| ADR-014 | Stack: npm workspaces, TypeScript, Fastify + `@fastify/websocket`, better-sqlite3 with plain-SQL migrations, React + Vite, Vitest. | Approved (rev 1) | Minimal dependencies that are well supported on Windows and Node 24. |

## Pass 1B decisions (within the approved scope)

| # | Decision | Rationale |
|---|---|---|
| ADR-015 | The forwarder spools **already-sanitized** events only (never raw stdin) to `spool.jsonl` (5 MB cap) on connection errors and 5xx/429; 4xx rejections are not spooled. The server claims the file by renaming it, applies events in timestamp order and relies on the event id for exactly-once. | Nothing is lost while the server is down and the privacy guarantees hold on disk. |
| ADR-016 | A replayed event **older than the session's latest state is recorded but not applied** ("stale"); replay never raises notifications. | Replay must never rewind a live status or raise stale alerts. |
| ADR-017 | Registered and excluded project paths are masked as `<project>` inside opted-in content, in the forwarder. | Users can type a project's path into a prompt; opt-in content must not reintroduce paths. |
| ADR-018 | The status line is opt-in, **wraps** an existing one and restores it exactly; it forwards numbers only. | Usage figures come only from what Claude Code reports; the user's own status line must keep working. |
| ADR-019 | Backups are single files (non-WAL) verified with `integrity_check`; a database failing `quick_check` is moved aside (never deleted) and the newest valid backup restored. | Self-contained backups; no silent data loss on corruption. |
| ADR-020 | Enabling content capture or "All sessions" scope needs explicit confirmation in the API (not only the UI). | The privacy-widening choices cannot be flipped by an accidental request. |

## Notes recorded during Pass 1A

- **npm 11 `allowScripts`.** Install scripts are allowed only for `better-sqlite3` (prebuilt native binary) and `esbuild` (platform binary). They're recorded in the root `package.json`.
- **Symlinks.** Creating a directory symlink needs a privilege this account doesn't have (EPERM), so that test skips and reports. Junctions (`mklink /J`) work and are tested in both directions.
