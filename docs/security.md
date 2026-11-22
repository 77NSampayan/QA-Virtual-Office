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

## Electron (Pass 1D, planned)

- `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`, strict CSP.
- Navigation and `window.open` locked to the app origin; the permission handler denies everything.
- Minimal `contextBridge` API.
- Single instance; fuses disabling RunAsNode and NODE_OPTIONS.
- Secrets stored in `safeStorage` (DPAPI).
