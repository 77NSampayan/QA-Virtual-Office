# Pass 1B: Validation Results (2026-11-22)

**Environment:** Windows 11 Pro, Node 24.18.0, Claude Code 2.1.260, Microsoft Edge (headless, via playwright-core).

**Automated:** `npm test` → 14 files, **285 passed, 1 skipped** (the directory-symlink privilege skip from 1A). `npm run e2e` → **5 passed** (real browser). `npm run typecheck` and `npm run lint` clean.

| # | Criterion | Result | Evidence |
|---|---|---|---|
| B1 | Events created while the collector is down are replayed exactly once, order preserved | **Pass (automated + real)** | *Automated* (`spool-replay.test.ts`): real forwarder processes against a stopped collector → 7 spooled events with no canary content → replay applies 7 in timestamp order with original times; a second replay of the same lines applies 0 and ignores 7 duplicates; a crash mid-replay is safe (dedupe); an older replayed event never rewinds a live status (`stale`); 5xx/429 spool but 4xx do not; the spool is size-capped. *Real:* with the server stopped, a real `claude -p` session produced 6 events in `spool.jsonl` (sanitized, 0 canary hits); on server start the spool was replayed, files removed, rules 1→4→5→8→19→23 identical to a live run, 0 notifications raised by replay, 0 duplicate event ids |
| B2 | 3 concurrent sessions in 2 projects plus a subagent tracked correctly | **Pass (automated + real)** | *Automated* (`concurrency.test.ts`): real forwarder processes, 3 interleaved sessions in 2 projects with a subagent, plus a burst of 8 sessions; no cross-contamination, distinct robots, DB integrity ok. *Real:* 3 concurrent `claude -p` sessions (2 in *Sandbox Demo*, 1 in *QA Office Dev*) → 3 distinct robots (Unit-01/02/04); a real **Explore subagent** was captured: SubagentStart (21) → its tool use applied to the drone (24) → its PermissionRequest moved the parent to awaiting-permission (25) → SubagentStop cleared it (22) → Stop (19) → SessionEnd removes drones (23) |
| B3 | Opt-in toggles work, purging works, canary repeated with opt-in on: everything redacted | **Pass (automated); not re-run on the live install** | `maintenance.test.ts` B3+B4: with all four toggles on, a real forwarder process + server store content redacted (`[REDACTED:anthropic_key/email/phone/card_number…]`); the registered project's path in prompts/tool inputs is masked to `<project>` (forwarder, any slash style/case); disabling a toggle offers a purge and purging removes the stored content; the server drops content for a toggle that is off; confirmation is required to enable content capture or "All sessions" scope. **Not run against the live install:** enabling content capture there was blocked by the session's permission classifier, and I did not work around that. Say the word if you want it run |
| B4 | Exports and backups pass the canary search | **Pass (automated)** | Same test: JSON export, CSV export, backup bytes and logs contain none of the canaries (secret, GitHub token, email, phone, card, project folder name). Exports contain no `project_paths`; the manifest states the capture policy; CSV cells never start with a formula character; the backup contains project paths **by design** (documented) but no captured secrets |
| B5 | Without the cookie REST/WS return 401; a cross-origin page cannot read data | **Pass (automated + real browser)** | `auth.test.ts` (11) + `e2e/b5-browser.test.ts` (5) in headless Edge: no cookie → UI shows "not signed in" and API 401; the one-time link signs in once (HttpOnly, SameSite=Strict, redirect strips the nonce, reuse → 401); a hostile page served from **another port on the same host** (same-site, so the cookie *is* attached) cannot read `/api/projects` (blocked), cannot use a custom header (no preflight), cannot read a no-cors response (blocked by `Cross-Origin-Resource-Policy: same-origin`), cannot open the WebSocket, and a no-cors POST created no backup; sign-out revokes the session. Session tokens are stored hashed |
| B6 | kill -9 during writes, restart: no data loss beyond in-flight events; integrity check passes | **Pass** | A child process ingesting events was killed with SIGKILL (TerminateProcess) after ≥200 events: restart needed no recovery, `integrity_check` = ok, ≥150 committed events present, no orphan events. Corruption recovery (garbage in `data.db`) moves the file aside and restores the newest *valid* backup, skips a corrupt backup, or creates a fresh DB when none is valid — all tested |

## Other 1B deliverables

| Deliverable | Status | Evidence |
|---|---|---|
| Sanitized spool + replay | Done | B1 |
| Subagent drones end to end | Done | B2 (real subagent) |
| Status line opt-in, wrapping an existing one | Done and **confirmed on real interactive sessions** | Install/wrap/uninstall tests restore `settings.json` exactly. In real interactive sessions the dashboard shows the model, context % and cost, and snapshots carry the 5-hour and 7-day rate-limit usage exactly as Claude Code reports it (headless sessions never run the status line) |
| Integration health | Done | `GET /api/integration/status` (last event per hook type, hooks/forwarder/status-line state, spool, last backup, recovery notice, workspace-trust hint); shown on Settings |
| Settings UI | Done | Screenshot-verified in headless Edge: install/uninstall with a dry-run plan (no paths) and a required acknowledgement, privacy toggles with confirmations, scope, excludes, retention, backups, export, sign out |
| Launch-token cookie auth | Done | B5 |
| Retention, daily backup (keep 7), redacted export, log rotation | Done | `maintenance.test.ts`; live server ran retention and created a verified backup at startup |
| DB integrity check and recovery | Done | B6 |

## Defects found and fixed during 1B validation

1. **File-handle leak in `openDb`.** A file that is not a valid database left the handle open, so recovery's rename failed with EPERM on Windows. Found by the recovery tests. Fixed.
2. **Project paths survived inside opted-in prompt text.** Fixed by masking registered and excluded paths in the forwarder; boundary-aware (`repo` ≠ `repo-old`).
3. **Backup sidecars.** The live data folder showed `-wal`/`-shm` files next to a backup. Backups are now single files, pruning removes sidecars, and a test guards it. The existing live backup was cleaned.
4. **Backup age** used file mtime instead of the backup's own timestamp.

## Confirmed by hand after the automated run

- Real status-line snapshots (model, ctx %, cost, rate limits) from interactive sessions.
- A live permission prompt in default mode: one notification per prompt (the 6-second follow-up no longer duplicates it).
- Spool + replay on real use: 22 events from 3 sessions, replayed once, in order, with no duplicates or false alerts.

## Not validated / open

- **Content-capture opt-in on the live install** (see B3).
- Windows 10 (1D).
