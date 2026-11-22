# Known Issues and Carry-over Items

Tracked so nothing from a checkpoint is forgotten. Update this file when an item is fixed or a new one is found.

## Fixed in Pass 1A
| Item | Fix |
|---|---|
| Duplicate "Permission required" notifications (`permission_prompt` arrives ~6 s after `PermissionRequest`) | One notification per unresolved permission episode; tests added |
| Fastify `FSTDEP023` deprecation warning on server start | Switched to `logController` (verified: no warning on startup) |
| Leftover debug key-name log and throwaway test files from validation | Removed |
| Rejected WebSocket upgrades left the socket open | Explicit close in `security.ts` |

## Open — scheduled for 1B (agreed scope)
| Item | Notes |
|---|---|
| Events sent while the server is down are dropped | Sanitized spool + replay, exactly once, order preserved |
| Model column shows "—" | `SessionStart` has no `model` in these payloads; fill from the status line (opt-in) |
| UI/API reachable by any local process of the same user | One-time launch-token cookie auth |
| Retention, backups, redacted export, Settings UI, integrity check | As listed in the 1B plan |

## Open — limitations to remember
| Item | Notes |
|---|---|
| Directory-symlink test skipped | This account lacks the privilege (EPERM); junctions are tested both ways |
| Windows 10 not testable on this machine | Listed as open validation item for 1D |
| Fork payloads carry no parent session id | Forks show "parent unknown" (nothing inferred) |
| Hooks only fire after Claude Code's workspace-trust prompt is accepted | Documented in `docs/security.md` |
| Uninstall keeps edits made by others to `settings.json` | By design; observed `model` changing during validation |
