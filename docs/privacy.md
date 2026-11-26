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

**Explicit opt-in (Settings screen).** Separate toggles for prompts, tool inputs, tool outputs and notification text. All default to off. Opted-in content is redacted and truncated to 2,000 characters. **Registered project paths and excluded paths are also masked as `<project>`** inside that content, in any slash style, case or doubled separators (boundary-aware: `repo` does not match `repo-old`). Enabling any content type requires a confirmation; turning it off offers to purge what was stored. The server re-checks the policy and drops content for toggles that are off.

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
| Spool (`spool.jsonl`) | Only already-sanitized events (never raw stdin), capped at 5 MB, replayed exactly once and deleted |
| Backups | One self-contained, verified file per backup under the same ACL (includes `project_paths`, which is needed for restore); newest 7 kept |
| Exports | Redaction re-applied to free-text fields, aliases only, never `project_paths`, plus a manifest stating the capture policy; CSV cells are protected against formula injection |
| Retention | Events kept 30 days by default; opted-in content 7 days (both configurable); expired sessions, notifications and auth sessions are removed too |

## Agents and QA data (Pass 2D)

When a person enables agent access, a connected Claude Code agent can read QA records (requirements, test cases, defects, tasks, notes) and the model provider processes what the agent reads. To limit exposure: everything returned to an agent is redacted again (emails, phone numbers, cards, keys, tokens…), project folder paths and internal ids are never returned, evidence files and screenshots are not available to agents, and the audit log records only which tool ran, on which project, with what outcome. Keep test data fictional or masked: redaction is a safety net, not a licence to enter customer data.

## Permission requests (V4b)

If you turn on the permission bridge, a request shows a short redacted description of what Claude Code wants to do (only when tool-input capture is on; paths are masked and nothing from inside a file is shown). It exists only while the request is open and is erased when you answer or it expires; afterwards only the tool name, project and result are kept for a week. Nothing from a permission request is sent anywhere outside this PC.


## Playbook runs (Pass P)

- A session launched from a playbook has a random **run id** in its environment. The hook forwarder adds that id (and nothing else about the run) to the sanitized event; it is validated against a fixed pattern and is not stored on events. The server uses it only to name the session's robot.
- The **run credential** is never in an event, a log, an export or any API response. Only its SHA-256 hash is in the database; the credential itself is in a per-run MCP config file in the data folder (current-user ACL) and is deleted when the run is stopped or on the next launch.
- The agent's activity log records the agent's name and role, the tool, the project and the outcome: never the arguments or results.

## Automation results (Pass 3, A1)

A person imports a JUnit XML file. Kept: suite, class and test name, status, duration and the first line of a failure message, all passed through the redaction engine and length-capped. Never kept: stack traces, system-out/system-err, screenshots, attachments, file paths or the file itself (only a hash, to refuse a duplicate import). DOCTYPE and entity declarations are ignored, never expanded. Nothing is read from project folders and nothing is sent anywhere.

### Framework scan (Pass 3, A2)

Only when a person presses Scan project. Reads file names (up to three folders deep, no links, no node_modules, virtualenvs or hidden folders) and, from at most 40 small dependency lists (package.json, requirements, pyproject.toml, pom.xml, build.gradle), only dependency names and declared versions. Never reads source, tests, .env files or anything else. The result (framework, evidence kind, file base name, root or subfolder, version) is shown once and not stored or logged.

### Automation script drafts (Pass 3, A4)

An Automation Writer agent can save the text of a script it drafted (up to 50,000 characters, with a title and notes). Like other agent-written QA text it is stored as typed after redaction: secrets, tokens, e-mail addresses and similar are masked before saving and again when an agent reads it back, and the writer is told when something was masked. Scripts are kept only in the local database and are never executed, never written into a project folder and never sent anywhere. A reviewer agent sees only the script, its linked test case and review notes.

### Test data profiles (Pass 3, D1)

Test data profiles are for FAKE data only. A fixed value that looks like real personal data (e-mail, phone, card, ID number, IP address) or a secret is refused with a reason and not stored; clearly fictional values are accepted (example.test/.com addresses, 555-01xx phone numbers, documentation IP ranges, published test card numbers). Passwords, tokens and keys are never stored: a field named like a secret can only be a placeholder or a secret reference, and a secret reference is only the NAME of an environment variable in capitals. The masking helper processes a pasted text in memory and returns it with personal data masked; nothing pasted there is stored or logged.

### CI/CD connections (Pass 3, A3a)

What leaves this computer: an HTTPS request to `api.github.com` or `dev.azure.com` containing the access token and the repository (or organisation and project) name you typed, plus a generic client name. No project alias, folder path, user name, machine name, QA record or test data is sent. What is stored: provider, the target name you typed and the result of the last connection test. The token is stored only in Windows protected storage, never in the database, backups, exports or logs. This step reads no pipeline data at all; it only checks that the connection works.

### CI/CD runs (Pass 3, A3b)

Read only when a person presses Refresh runs, or while automatic refresh is switched on (off by default; every 5 minutes at most; it stops by itself after 2 hours without a click). Kept for the latest 30 runs per connection and no older than 30 days: the provider's run id, pipeline name, branch, status, start and finish time, the first 7 characters of the commit id and a link on the provider's own website. Never read or kept: who triggered the run, commit messages, pull request titles, logs, artifacts. Text that is kept is passed through the redaction engine. Disconnecting deletes the saved runs and the token.
