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
- **Pass 1B adds** the one-time launch-token cookie (HttpOnly, SameSite=Strict). Until then, any local process running as the same user can read GET endpoints. Ordinary GET responses never contain paths or captured content.

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

**Handler guarantees.** The forwarder always exits 0, never writes to stdout, and has a 5 s hard deadline. It cannot approve, deny or block anything. Claude Code permissions are never bypassed.

**Workspace trust.** Claude Code holds back hooks in a folder until its workspace-trust prompt has been accepted. If a session in a new folder doesn't show up, accept the trust prompt.

## Electron (Pass 1D, planned)

- `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`, strict CSP.
- Navigation and `window.open` locked to the app origin; the permission handler denies everything.
- Minimal `contextBridge` API.
- Single instance; fuses disabling RunAsNode and NODE_OPTIONS.
- Secrets stored in `safeStorage` (DPAPI).
