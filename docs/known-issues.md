# Known Issues and Carry-over Items

Tracked so nothing from a checkpoint is forgotten. Update this file when an item is fixed or a new one is found.

## Fixed in Pass 1A
| Item | Fix |
|---|---|
| Duplicate "Permission required" notifications (`permission_prompt` arrives ~6 s after `PermissionRequest`) | One notification per unresolved permission episode; tests added |
| Fastify `FSTDEP023` deprecation warning on server start | Switched to `logController` (verified: no warning on startup) |
| Leftover debug key-name log and throwaway test files from validation | Removed |
| Rejected WebSocket upgrades left the socket open | Explicit close in `security.ts` |

## Fixed in Pass 1B
| Item | Fix |
|---|---|
| Events sent while the server was down were dropped | Sanitized spool + exactly-once replay (`spool.ts`); validated with a real session |
| Model column showed "—" | Filled from the opt-in status line (needs an interactive session, see below) |
| UI/API reachable by any local process | One-time launch link + HttpOnly SameSite=Strict session cookie; Origin/CORP checks hold even for a hostile page on another port of the same host (browser-tested) |
| `openDb` leaked its file handle when a file was not a database, so recovery's rename failed on Windows | Handle closed on failure (found by the recovery tests) |
| A registered project's path typed into a prompt survived in opted-in content | Registered/excluded paths are masked as `<project>` inside the forwarder, any slash style/case |
| Backups left `-wal`/`-shm` sidecar files (found on the live data folder) | Each backup is converted to a single file; pruning removes sidecars; test added |
| Daily-backup age used file mtime | Uses the backup's own timestamp |

## Verified by hand in interactive sessions (2026-11-22)
| Item | Result |
|---|---|
| Real status-line snapshot | Confirmed: snapshots from real interactive sessions carry model, cost, context %, and 5-hour/7-day rate-limit usage; `sessions.model` is filled from them. (Headless `claude -p` never runs the status line, so this needs an interactive session) |
| Permission prompt in default mode | Confirmed on a live session: PermissionRequest → awaiting_permission (rule 11), follow-up Notification ~6 s later (rule 12), exactly one notification. Reads never prompt in default mode; a write or command is needed |
| Spool + replay after the server was stopped | Confirmed on real use: 22 events from 3 sessions replayed once, in order, 0 duplicates, 0 false notifications |

## Fixed in Pass 1C
| Item | Fix |
|---|---|
| Save confirmation on the Robots page vanished (editor remounted) | Stable key + form resync |
| Robots page overflowed 3 px at 360 px | Controls constrained to the column |
| Robots looked black (black outline + dark face) | Outlines tinted from the body colour |
| Permission robot animation had only 2 distinct frames | Wave and flash now out of phase |

## Fixed in Pass 1D
| Item | Fix |
|---|---|
| Electron crashed when launched from VS Code (`ELECTRON_RUN_AS_NODE`) | Launcher clears the variable |
| A failed test could leave a login item that starts the dev app at Windows login | Test cleans up in try/finally with a safety net; registry verified clean after each run |
| Stray `bun` dependency in `package.json` (from 1B) | Removed |
| **Blank desktop window**: a server started before a web rebuild served the HTML page for the new script file (static routes were only registered at startup) | Files are looked up per request; missing files are real 404s; regression tests added. Also explains the earlier unreproducible bad bundle |

## Open — not yet exercised
| Item | Notes |
|---|---|
| Content-capture opt-in against the LIVE install | Covered by automated tests with the real forwarder and server in an isolated data folder. It was not re-run on the live install because enabling content capture there was blocked by the session's permission classifier and deliberately not worked around |

## Open — limitations to remember
| Item | Notes |
|---|---|
| New robots default to the QA Analyst role | Roles are never guessed; change a robot's role on the Robots page to move it to another department |
| The office has been seen by a human only through screenshots of synthetic data | Run `npm run launch` to look at your real robots |
| Session cookie is not port-isolated | Another localhost app could read it from the browser; it still cannot be used by other web origins or cookie-less clients. Documented in `docs/security.md` |
| Same-user processes can read `token` | Inherent to a same-user file token; documented |
| A wrapped status line runs through `cmd.exe` | Status lines written for Git Bash/PowerShell syntax may not run when wrapped; a failing wrapped command falls back to our compact line |
| Our status-line command string assumes Git Bash | Claude Code uses Git Bash when present (true on this PC); PowerShell-only machines would need a different quoting |
| Spool is capped at 5 MB | Events beyond the cap are dropped (logged as `failed:spool_full`) rather than growing without bound |
| Replayed events older than the live state are recorded but not applied (`stale`) | By design: they cannot rewind a live status |
| Backups contain project folder paths | Needed for restore; same current-user ACL. Exports never contain them |
| Directory-symlink test skipped | This account lacks the privilege (EPERM); junctions are tested both ways |
| Windows 10 not tested (D4) | This machine runs Windows 11 |
| Toast visibility and the tray menu not seen by a human | Automated checks prove Windows accepted the toast in ~35 ms; confirm visually with a real permission prompt (Focus assist can hide toasts) |
| In development, toasts are attributed to the Electron host | A Start Menu shortcut with the AppUserModelID arrives with the installer (Pass 5) |
| The desktop app needs Node on PATH | Until the installer (Pass 5) bundles a Node runtime |
| Fork payloads carry no parent session id | Forks show "parent unknown" (nothing inferred) |
| Hooks only fire after Claude Code's workspace-trust prompt is accepted | Documented in `docs/security.md` and shown on the Settings screen |
| Uninstall keeps edits made by others to `settings.json` | By design; observed `model` changing during validation |
| Claude sign-in expiry notice | Claude Code printed "this sign-in ends between 2026-11-23 and 2026-11-26"; run `claude auth login` before then (not related to this app) |
