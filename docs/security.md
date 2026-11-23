# Security Model

## Network surface

- **Binding.** The server binds to `127.0.0.1` only (default port 47821; override with `QAVO_PORT`).
- **Host header.** It must be `127.0.0.1:<port>` or `localhost:<port>`. Anything else gets 403. This blocks DNS rebinding.
- **`POST /api/hooks`:**
  - rejects any request that carries an `Origin` header (browsers always send one);
  - requires `X-QAVO-Token` (compared in constant time);
  - caps the body at 64 KB and validates it against a strict schema (unknown fields → 400);
  - is rate-limited by a token bucket (200/s, burst 600);
  - always replies `204` with an empty body.
- **Other `/api/*` routes and `/ws`:**
  - `Origin`, if present, must be the app origin;
  - `Sec-Fetch-Site: cross-site` is rejected;
  - `/ws` requires the app origin.
- **CSRF.** Mutating requests and `GET /api/projects/:id/path` require `X-QAVO-Client: 1`. Cross-origin pages can't send that header without a CORS preflight, which the server never answers.
- **Rejected WebSocket upgrades.** The raw socket is closed explicitly. Upgraded sockets aren't tracked by the HTTP server.
- **Response headers:** `nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, CORP/COOP same-origin, `Cache-Control: no-store` on the API, and a strict CSP on HTML (self only, no eval, no framing).
- **Token routes** (`/api/hooks`, `/api/statusline`, `/api/auth/launch-nonce`) accept only requests with the hook token and **no `Origin` header**, and are rate-limited.
- **UI session auth (1B).** Everything else under `/api` and `/ws` needs a session cookie (`/api/health` and `/api/auth/status` are open). The cookie is obtained from a **one-time launch link** (`/launch?k=<nonce>`: single use, 5 minutes) printed by `npm run start` or requested with `npm run launch` (which proves it is the same user by presenting the hook token). The cookie is `HttpOnly; SameSite=Strict; Path=/`, lasts 30 days, and only its SHA-256 is stored. `POST /api/auth/logout` revokes it.
- **Hostile page on another port of the same host.** Cookies are not port-isolated, so such a page *is* sent the cookie (same-site). It is still stopped by the `Origin` allowlist (403), by the absence of CORS headers (the page cannot read responses), by `X-QAVO-Client` (a custom header forces a preflight that is never answered), by `Cross-Origin-Resource-Policy: same-origin`, and by the WebSocket origin check. This is exercised in a real browser (`e2e/b5-browser.test.ts`).
- **Residual risk (documented).** Another *localhost application running as you* could read the cookie jar or the `token` file. That is inherent to same-user local software.

## Data directory

- **Location.** `%LOCALAPPDATA%\QA Virtual Office\` (override with `QAVO_DATA_DIR`).
- **ACL.** Bootstrap runs `icacls <dir> /inheritance:r /grant:r <DOMAIN\user>:(OI)(CI)F`, and existing children are reset so they inherit it. `verifyOwnerOnlyAcl()` checks that the only principal is the current user.
- **Hook token.** `token` holds a 256-bit random value. *Limitation:* any process running as the same Windows user can read it. It protects against other users and against browsers, not against malware running as you.

## Hook installation (`npm run hooks:install`)

**Scope.** Hooks are installed at **user level** (`%USERPROFILE%\.claude\settings.json`, or `CLAUDE_CONFIG_DIR`), so they run for Claude Code sessions in **every folder** on this PC. The installer prints this warning and asks for confirmation. Pass `--yes` for non-interactive runs, and `--dry-run` to preview.

**Safety rules:**
1. Refuse to modify a `settings.json` that is not valid JSON.
2. Write a timestamped backup to `backups\claude-settings\` before any change.
3. Merge only our handlers. They are identified by the absolute forwarder path, and every other key and hook is preserved.
4. Re-check the file's mtime before an atomic write (temp file + rename), so concurrent edits are never clobbered.
5. Be idempotent: a second install is a no-op.
6. Record an install manifest (which keys we created), so uninstall restores the file exactly. Uninstall removes only our handlers and the keys we created, then verifies the result.
7. Use exec form with the absolute `node.exe` path and `args`, so no shell is involved. Handlers use `async: true` and `timeout: 10`.

**Status line (opt-in, `npm run statusline:install` or Settings).** Written to `statusLine` in the same safe way (backup, atomic, manifest, verified). An existing status line is **wrapped**: its command is saved and run with the same input, its output is shown, and it is restored exactly on uninstall. The status-line script forwards only a numbers-only snapshot (model, context %, cost as reported by Claude Code, rate-limit percentages) using the same local project resolution and scope rules; it always exits 0 and has a hard deadline. Billing and subscription spend are not available through Claude Code and are never shown.

**Handler guarantees.** The forwarder always exits 0, never writes to stdout, and has a 5 s hard deadline. It cannot approve, deny or block anything. Claude Code permissions are never bypassed.

**Workspace trust.** Claude Code holds back hooks in a folder until its workspace-trust prompt has been accepted. If a session in a new folder doesn't show up, accept the trust prompt.

## Electron desktop shell (Pass 1D, implemented)

- `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`, strict CSP.
- Navigation and `window.open` locked to the app origin; the permission handler denies everything.
- Minimal `contextBridge` API.
- Single instance; fuses disabling RunAsNode and NODE_OPTIONS.
- Secrets stored in `safeStorage` (DPAPI).

## Agent surface (Pass 2D, implemented)

- **Who can call it:** only the local `qa-office` MCP server (or anything else that holds the agent token). `/api/agent/*` needs `X-QAVO-Agent-Token` (256-bit, file `agent-token`, current-user-only ACL, separate from the hook token and the UI cookie), no `Origin` header (never a browser), the usual Host check, and its own rate limit (20 calls/s, burst 60).
- **What the token opens:** the `/api/agent/*` routes only. It is refused (401) on the UI API, settings, hooks and launch routes. Access is OFF until a person turns it on (cookie + CSRF header + confirmation) and can be revoked at any time ("Revoke and replace token": the old token dies immediately).
- **What an agent can do:** 17 allow-listed `qa_*` tools; strict schemas; actor `agent`. No tool approves, passes, closes, rejects, completes, archives, deletes, launches or installs anything, and the services and database constraints behind them refuse the agent actor even if a tool were added by mistake.
- **What an agent sees:** safe project aliases and entity codes only (no paths, no internal ids), redacted text, at most 200 rows per list.
- **Audit:** one append-only row per call (tool, project, outcome, code), never content.
- **Same-user limitation:** any process running as the same Windows user can read `agent-token` (same as the hook token). It stops other users, browsers and remote hosts. Turn access off, or replace the token, if you suspect misuse.
- **Launch Claude Code here:** confirmed, fixed `cmd.exe /c start … cmd /k claude` in the project folder; folder names with `% ^ & | < > " !` are refused; not available in demo mode; not reachable with the agent token.

## Permission bridge (V4b, implemented, optional, off by default)

- **What it is:** one SYNCHRONOUS command hook on `PermissionRequest` only (every other hook we install is asynchronous and can never decide anything). It lets a person allow or deny a permission request from the office.
- **It never decides by itself.** It prints a decision only after the server reports that the signed-in person decided. In every other case it prints nothing and exits 0, which leaves Claude Code's normal permission prompt untouched (documented: staying silent does not approve). It never uses exit code 2 (not honoured for this event) and never exits non-zero.
- **Gates, all required:** the hook is installed (by you, with a dry-run plan and acknowledgement); the bridge is turned on (you confirm); the session's folder is a registered, non-excluded project (an unregistered folder is never contacted, even in "All sessions" scope); the hook token is present.
- **Who can decide:** only the signed-in UI (session cookie + CSRF header). The hook token can create and wait for a request but not decide; the agent token cannot reach any of these routes; a decision is final and single-use; the database refuses an allowed/denied row not decided by a human.
- **Allow needs the details.** Allow is refused (422) when the request carries no summary (tool-input capture off). The summary is built locally by the hook (command on one line; for file tools a verb and a project-relative or home-masked path; for other tools field names only), redacted again by the server, stored only while the request is open, and erased when answered or expired. Only tool, project and result are kept, for 7 days.
- **Bounded waiting:** requests expire after 110 s; the script stops after at most 115 s (Claude Code's limit is configured to 130 s); a request also expires when its session carries on (the same tool finished, the turn or session ended): subagent events never expire a request.
- **Limits:** at most 20 requests wait at once; request bodies are capped at 8 KB; no permanent allow rules are ever written (`updatedPermissions` is never sent).
- **Same-user limitation:** as with every token in this app, any process running as your Windows user can read the hook token and could create requests (not answer them). Answering needs your signed-in session.
- **Not verified against a live Claude Code session** in this environment; see `docs/validation/v4b-permissions.md` for what to test.


## Named agents (Pass P2)

- `/api/agent/*` accepts either the shared agent token (unattributed, all agent tools, all projects) or a **run credential** (`X-QAVO-Run-Token`: one role, one project, 8 hours). A bad run credential is refused and never falls back to the shared token. Both are rejected on any request with an `Origin` header and share the agent rate limit.
- A run credential cannot reach the person's API (no session cookie, no client header), cannot start, stop or list runs, and cannot rename agents. Only the signed-in person can launch and stop runs.
- Credentials are random 256-bit values, hashed (SHA-256) at rest, compared by hash, shown nowhere, and removed with the run's config file when the run is stopped.
- Limitation: the per-run config file holds the credential in clear for the lifetime of the run (any process running as the same Windows user can read it, as with the hook token). It is deleted when the run is stopped and on the next launch, and the credential expires after 8 hours.
