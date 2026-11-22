# Pass 1A: Validation Results (2026-11-22)

**Environment:** Windows 11 Pro 10.0.26300, Node 24.18.0, Claude Code 2.1.260. Data dir: `%LOCALAPPDATA%\QA Virtual Office\`.

**Automated suite:** `npm test` gives 8 files, **220 passed, 1 skipped**. `npm run typecheck` and `npm run lint` are clean.
- The one skip is the directory-symlink test. Creating a directory symlink needs a privilege this account doesn't have (EPERM). Junctions are tested in both directions instead.

| # | Criterion | Result | Evidence |
|---|---|---|---|
| A1 | Tests for matrix rows 1–32, sanitizer allowlist, redaction corpus, installer merge/uninstall | **Pass** | `statusMachine.test.ts` (61 tests, one or more per row; row 32 in `projects-collector.test.ts`), `sanitize.test.ts`, `redact.test.ts` (50 cases), `installer-e2e.test.ts` |
| A2 | Install: backup written; settings JSON-equal apart from our handlers; idempotent | **Pass (real machine)** | Backup `settings.2026-11-22T05-00-45-466Z.json`. Post-install minus our handlers equals pre-install (`True`). Re-run printed "Already installed (no changes)" and wrote no new backup |
| A3 | Real session appears live; status follows prompt → tool → permission → approval → Stop → exit | **Pass (real interactive session)** | Interactive `claude --permission-mode default` in registered *QA Office Dev* (session `9fb0480b`, robot Unit-04): SessionStart (1) → UserPromptSubmit (4) → Glob (5, 8) → Write test file (5, `~writing_tests`) → **PermissionRequest → `awaiting_permission` (11)** → permission_prompt Notification (12) → approved → PostToolUse (6, `~writing_tests`) → Stop (19) → internal SubagentStop, no drone drawn (22) → SessionEnd `prompt_input_exit` (23). High-priority "Permission required" notification created. Earlier headless `-p` runs and an auto-mode run produced no permission prompt, because Claude Code never showed one |
| A4 | Privacy canary: none in the data dir | **Pass (real machine)** | Fake secret, email, phone, prompt text, canary file contents and tool targets (`login.spec`, `canary.txt`) were found in no file (DB, WAL, logs). The project folder name appears only in `project_paths` and `capture-policy.json`, as designed |
| A5 | Collector down: Claude behaves normally; forwarder exits 0 | **Pass (real machine)** | Two real sessions with the collector stopped: exit 0, normal output, 5.6 s and 9.0 s (collector-up runs took 7.4–27.8 s; model latency dominates). Forwarder logged `failed:collector_unreachable`; direct forwarder runs exited 0 in ~240 ms. Hooks are async |
| A6 | Listens on 127.0.0.1 only; foreign Host / Origin rejected | **Pass** | `netstat`: `127.0.0.1:47821 LISTENING` only. curl: foreign Host → 403, Origin on hooks → 403, missing token → 401, foreign Origin on API → 403, mutation without CSRF header → 403. Plus 11 tests |
| A7 | Uninstall leaves settings equal to the pre-install backup | **Pass, with an external change noted** | All our handlers and the `hooks` key we created were removed (verified). The only difference from the pre-install snapshot is `model: "opus"` → `"opus[1m]"`, changed by something other than the installer between 05:00:45 and 05:07:41. The uninstaller keeps edits it didn't make (by design, and tested) |
| A8 | Current-user-only ACL on the data dir and token | **Pass (real machine)** | `icacls`: the dir shows `<MACHINE>\<USER>:(OI)(CI)(F)` only; `token` and `folder-key.secret` show `(I)(F)` for the same user only |
| A9 | Path matching + policy sync tests; real unregistered session sends nothing | **Pass** | 23 path tests (case, separators, trailing slash, boundary, junction both ways, missing dir, longest root, 8.3 short name ↔ long name seen in the real policy). Policy-sync tests: register, rename, path change, remove, corrupt file. Real sessions in an unregistered folder (and this IDE session in `c:\VirtualOffice`) were all `dropped:unregistered`; DB session count unchanged |
| A10 | Resume keeps robot; fork gets a new session and robot; parent only if carried | **Pass (real machine)** | `--resume`: same session `5f975b07`, same robot `Unit-01`, rule 2a. `--fork-session`: new session `40b508a2`, `origin=fork`, robot `Unit-02`, parent unknown. The key-name check shows the fork's SessionStart has **no parent-session field** (`context_tokens, cwd, estimated_cache_write_usd, hook_event_name, prompt_cache_likely_expired, scratchpad_dir, seconds_since_last_response, session_id, source, transcript_path`) |
| A11 | Path and folder names absent from events, logs, WS messages and ordinary API responses; folder-key behaviour | **Pass** | Leak test (`projects-collector.test.ts`) plus a real-DB table scan: only `project_paths` contains the folder name. Folder-key tests cover parent re-linking, PATCH re-linking, rotation (old key deleted, no re-link), registered-only (no keys), and a missing secret (`[]`) |
| A12 | Interrupt clears stale state | **Pass** | Row 9 test and the dedicated A12 test |

## Findings from real payloads

- **Exec-form hooks work on Claude Code 2.1.260.** Handlers of the form `command` + `args`, with `async: true`, fired and hot-reloaded without a restart.
- **`SessionStart` has no `model` key in these headless runs,** so the model column shows "—". This is expected with metadata from this mode.
- **Fork payloads carry no parent id.** Forks are shown as "forked, parent unknown".
- **Headless `-p` mode emits no PermissionRequest or permission Notification.**

## Defect found and fixed during validation

- **Duplicate permission notifications.** The real session sent the `permission_prompt` Notification about 6 s after `PermissionRequest`, outside the original 5 s dedupe window, so two "Permission required" notifications appeared for one prompt.
  - **Fix:** row 12 now allows one notification per unresolved permission episode, with no time window.
  - **Tests added:** a 6 s gap with a late repeat produces no extra notification; a new episode after approval notifies again. Suite: 220 passed, 1 skipped.

## Open items carried to 1B

- Events produced while the collector is down are dropped (by design for 1A). The sanitized spool and replay come in 1B.
- Fastify warns that `disableRequestLogging` is deprecated (`FSTDEP023`). Switch to `logController` in 1B.

## How to finish A3 interactively (about 2 minutes)

1. `npm run start` (if the server isn't running), then `npm run hooks:install`.
2. Open http://127.0.0.1:47821. The project **Sandbox Demo** is already registered.
3. In a terminal, `cd` to that project's folder and run `claude` (interactive). Accept the workspace-trust prompt if it appears.
4. Ask it to create `tests/demo.spec.ts`. When the permission dialog appears, the session should show **Awaiting permission (Write)** and the orange banner. Approve it: the status moves on to `~ Writing test cases` and then Completed. Exit with `/exit` to see Disconnected.
5. Run `npm run hooks:uninstall` when you're done.
