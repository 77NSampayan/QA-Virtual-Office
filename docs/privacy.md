# Privacy Model

The Virtual Office is local-first. It adds **no** external transmission of monitoring data. Claude Code itself still talks to Anthropic as it normally does.

## 1. What is collected

**Sanitized at the source.** The hook forwarder (`forward.mjs`, running inside the hook process) builds a metadata-only event *before* anything leaves that process. Raw hook stdin is never written anywhere.

**Default allowlist.** Everything else is dropped.

| Always | Tool events | Subagents | Event-specific |
|---|---|---|---|
| `session_id`, `hook_event_name`, `permission_mode`, `projectId` **or** `folderKeys` | `tool_name`, `tool_use_id`, `duration_ms`, `is_interrupt` | `agent_id`, `agent_type` | Notification `notification_type`; SessionStart `source`, `model`; SessionEnd `reason`; StopFailure `error` (fixed enum only); PostToolUseFailure `error` (only `Exit code N`, otherwise `tool_error`); Stop: count of running background tasks |

**Derived categories.** These are computed locally from `tool_input`; the raw input is then discarded:
- `fileCategory`: `test|source|doc|config|other`
- `commandCategory`: `test_run|build|git|install|other`

**Never collected by default:**
- prompts, `tool_input`, `tool_response`
- notification `message`/`title`, `last_assistant_message`, `error_details`
- `cwd`, `transcript_path`, transcript contents

The app does not read transcript files.

**Explicit opt-in (Pass 1B UI).** Separate toggles for prompts, tool inputs, tool outputs and notification text. All default to off. Opted-in content is redacted and truncated to 2,000 characters. The server re-checks the policy and drops content for toggles that are off.

## 2. Paths: actual paths vs safe aliases

- The `projects` table holds only safe display data: an **alias** chosen by the user, a description and a type.
- Actual paths live in `project_paths` (`path_entered`, `path_lexical`, `path_canonical`, `path_exists`). It is read only by:
  1. the policy writer,
  2. folder-key re-linking,
  3. `GET /api/projects/:id/path` (the edit form). That endpoint requires same-origin plus `X-QAVO-Client` and is logged by route pattern only.
- Ordinary API responses, WebSocket messages, notifications, logs and exports carry only `alias`, `pathConfigured` and `pathStatus`.
- If an alias contains a folder name from its path, the API returns a warning (`alias_matches_folder_name`).
- **Backups are not exports.** They are full DB copies needed for restore, so they *do* contain `project_paths`. They are stored under the same current-user ACL.

## 3. Windows path matching (`packages/shared/src/paths.ts`)

**`normalize(p)`:**
- strips the `\\?\` and `\\?\UNC\` prefixes (`\\?\UNC\srv\share` → `\\srv\share`);
- converts `/` → `\` and collapses duplicate separators;
- drops trailing `\`, except for a bare drive root (`c:\`);
- lowercases.

**Path forms:**
- **Lexical form** = `normalize(path.win32.resolve(p))`. This is string-only, with no filesystem access.
- **Canonical form** = `normalize(fs.realpathSync.native(p))`. This resolves symlinks and junctions. It is `null` if the path is missing or unreadable.

**Matching:**
- The cwd's {lexical, canonical} forms are compared against each project's {lexical, canonical} forms. That's up to 4 comparisons, which covers both junction→target and target→junction.
- A comparison matches only at a directory boundary: `cwd === root || cwd.startsWith(root + "\")`. So `C:\proj` never matches `C:\project2`.
- The longest matching root wins. On a tie, a canonical↔canonical match wins.
- Exclude rules use the same function and take precedence over project matches.

**Refresh and missing paths:**
- Project forms are recomputed on create and update, and refreshed on every server start (in case a junction target changed).
- A project whose folder is missing still matches, lexically only, and is shown as "folder missing".

**Not supported (documented):**
- per-directory case-sensitive NTFS folders;
- expanding mapped drive letters or `subst` drives (they are compared as written).

## 4. capture-policy.json synchronization

- **Single writer.** The server is the only writer. It regenerates the file atomically (temp file + rename, retried on transient Windows locks):
  - on startup;
  - on every project create, update (alias, path, type), archive or remove;
  - on every scope or privacy change.
- **Contents.** `version` (monotonic), `generatedAt`, `scope`, the `capture` toggles, `projects` (id + forms), `excludes`, and the collector port.
- **Reading.** The forwarder re-reads the file on **every** invocation, with no cache, so a change applies from the next hook event.
- **Fails closed.** If the file is missing or corrupt, the forwarder uses registered-only scope, metadata-only capture and an empty project list, so nothing is sent.
- **Reporting.** `GET /api/integration/status` reports the current policy version.

## 5. Folder keys (All-sessions scope only)

- In "All sessions" scope, an event from an unregistered folder carries `projectId: null` and `folderKeys`:
  - each key is `kid:HMAC-SHA256(secret, form)`, truncated to 128 bits;
  - keys cover the cwd's lexical and canonical forms and up to 8 ancestors (drive and share roots are excluded).
- **What they reveal.** No folder names are revealed. Only nesting depth is implied.
- **What they're used for:**
  - The first key groups sessions in the UI ("Unregistered folder #a1b2").
  - Registering a folder later re-links sessions whose keys (same `kid`) include that folder's root key. This also works for a *parent* of where the sessions ran.
- **Registered-only scope** (the default) never computes keys. Historical re-linking therefore applies only to sessions collected under All-sessions scope.

**Secret lifecycle:**
- **Creation.** `folder-key.secret` holds `{kid, key, createdAt}`. The key is 256 bits from `crypto.randomBytes`, generated by the server at first-run bootstrap.
- **Storage and access.** The file lives in the data dir under the current-user ACL, separate from the policy file. The forwarder reads it only when the scope is All sessions and the cwd is unmatched. The server reads it only to re-link.
- **Missing or unreadable.** The forwarder sends `folderKeys: []` ("Unregistered folder (unknown)"). It never falls back to sending a path.
- **Rotation.**
  - Rotation is manual only: `POST /api/integration/folder-key/rotate` or `npm run folder-key:rotate`.
  - It writes a new `{kid, key}` atomically and **deletes** the old key.
  - Sessions grouped under the old key keep their grouping but can never be re-linked to a path. The server never re-links across kids.

## 6. Redaction engine (`packages/shared/src/redact.ts`)

Used on opted-in content, log lines and (Pass 1B) export output. Matches are replaced with typed placeholders such as `[REDACTED:email]`.

**Secrets:**
- Provider keys: Anthropic, OpenAI, Google, Stripe, npm, PyPI.
- Tokens: GitHub (all formats), GitLab, Slack (tokens and webhooks), JWTs.
- Cloud credentials: AWS access keys plus secret keys in context; Azure connection strings, account keys and SAS signatures.
- Credentials in context: private key blocks, `Authorization` headers, bearer tokens, credentials embedded in URLs, connection-string passwords.
- Key/value pairs whose key looks like a secret (password, secret, token, api key, auth, credential, cookie, session), in JSON, env, YAML, query-string and CLI forms.

**PII:**
- emails;
- phone numbers (international, PH and US formats);
- payment cards (Luhn-validated);
- IBAN;
- US SSN and PH TIN/SSS/UMID patterns;
- labelled dates of birth;
- IPv4/IPv6 (configurable; loopback addresses are kept) and MAC addresses;
- Windows user-profile names (`C:\Users\<name>` → `~`).

**Fallback and customization.** A high-entropy fallback catches long random strings. Users can add their own regex patterns and an allowlist.

## 7. Where the rules apply

| Surface | Rule |
|---|---|
| Hook → collector | Sanitized allowlist only; the cwd is never sent |
| DB (`agent_events`, `sessions`, `notifications`) | Sanitized fields only; notifications are rendered from metadata plus the alias |
| WebSocket broadcasts | The same DTOs as the API (no paths) |
| Server log (`logs/server.log`) | Route pattern, status and duration only. No URLs with ids, no bodies. Every string is redacted and `path*`/`cwd` keys are dropped |
| Forwarder logs | Decision, event name and 8-character session-id prefix. In debug-keys mode, key **names** only |
| Backups (1B) | Copy of the sanitized DB under the same ACL (includes `project_paths`, which is needed for restore) |
| Exports (1B) | Redaction re-applied, aliases only, never `project_paths`, plus a manifest stating the capture policy |
| Retention (1B) | Events kept 30 days by default; opted-in content 7 days |
