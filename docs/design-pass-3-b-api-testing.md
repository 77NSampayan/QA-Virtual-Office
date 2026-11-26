# Pass 3, B: API Testing workspace: design for approval (2026-11-26)

**Status: DESIGN ONLY. No code has been written.** Your answers are recorded: **definitions only (the app sends no requests); credentials as named references only; a structured JSON format of our own.** The design as a whole still needs your go-ahead before B1 starts.

## 1. What it is, and what it is not
A workspace where **Piper** (API Test Writer) drafts API tests, **Cole** (API Test Reviewer) reviews them, and **you** approve them, exactly like Axel, Vera and automation scripts (A4). An API test is a *description*: what request to make and what the answer must look like.

It does **not** send anything. No HTTP request is made by the app, the server or an agent. There is no "Run" button. Results come back the same way automation results do: you import a report file (B1 reuses the JUnit import from A1; other formats only if you ask). Sending requests is a possible later step (B2) and needs its own design and approval, because it is the first feature that would call a host you choose.

## 2. The test definition (structured JSON, ours)
One API test = one `ApiTestDefinition`, validated by a strict schema in `packages/shared/src/apiTests.ts` (unknown fields refused):

| Field | Rule |
|---|---|
| `title`, `description` | text, redacted, length-capped |
| `method` | `GET POST PUT PATCH DELETE HEAD OPTIONS` |
| `path` | starts with `/`, no scheme or host, no `..`, no `@`, no credentials, max 300 chars, `{{variable}}` placeholders allowed |
| `baseUrlRef` | a **name** (e.g. `staging`), never an address. Which address that name means is outside the app. |
| `query` | list of name and fake value |
| `headers` | list of name and value. Names that carry credentials (`Authorization`, `Cookie`, `X-API-Key`, `Proxy-Authorization`, any name matching the existing secret-key pattern) must use a secret reference as value, never a literal |
| `body` | JSON text up to 20 KB, checked by the same "why not fake" rules as Test Data (`whyNotFake`): real-looking e-mails, phone numbers, tokens, card numbers are refused |
| `auth` | `none` or `{ secretRef: "<name>" }`: a reference to a Test Data secret reference (D1). Only the name is stored. |
| `assertions` | list, at least one: `status` (equals or one of), `header` (present, equals, matches), `jsonPath` (exists, equals, type, matches), `schema` (a small JSON-schema subset: type, required, properties, enum, min/max; no `$ref` to the outside), `maxMs` (timing budget) |
| `linkedTestCaseId`, `requirementId` | optional links to existing records |
| `tags` | short words |

Why a fixed schema and not free text: it can be checked, redacted and reviewed mechanically, and nothing in it can hide an address or a secret.

## 3. Credentials
Tests reference a credential by name (`{{secret:staging_token}}` in a header or `auth.secretRef`). The name must already exist as a secret reference in Test Data (D1: names only, the value lives in the person's own environment or password manager). The value is never in the database, in a draft, in an agent's view, in a review, in an export or in a log. The server refuses a literal that looks like a token in any field (existing redaction patterns plus `whyNotFake`). Because nothing is sent in B1, no value is ever needed by the app.

## 4. Agents and who may do what
- **Piper** (writer) gets: read tools (requirements, approved test cases, test data profile names), `qa_create_api_test_draft`, `qa_revise_api_test`, `qa_list_my_api_test_changes`. **Cole** (reviewer) gets: `qa_list_api_tests_to_review`, `qa_read_api_test`, `qa_review_api_test`. The tool lists are enforced by the server by role, as for Axel and Vera.
- Writer and reviewer are different identities (same name or same run refused, in the service and by database trigger). Reviews are append-only and become "outdated" when the definition changes (content hash).
- A review is a recommendation only. **Only a signed-in person** approves, rejects or archives an API test (agent, run and hook tokens refused; DB CHECK as for scripts).
- Reviewer checklist (Cole): status, body and schema assertions present; at least one negative case in the set (401/403/404/400 type); no literal credentials; fake data only; timing budget sensible; linked to a requirement or test case; no path trickery.
- A draft that fails the schema or the fake-data rules is refused with a plain reason before it is stored.

## 5. The page (API Testing)
Same pattern as Test Automation scripts: project selector, list with status filter (Draft, Changes requested, Recommended, Approved, Rejected, Archived), side drawer with the readable request, assertions, links, review history and the human Approve and Reject buttons. A person can also create and edit a definition by form. A one-line plain summary is shown for each ("GET /orders/{{id}} must answer 200, have `id`, finish within 800 ms"). No Run button; a note says so and why. Results import: the Automation results import is reused, with a test-case-style name matching an API test's title linking the result to it.

## 6. Data model (migration 018)
- `api_tests` (id, project_id, title, definition JSON text, definition_hash, status, authored_by_kind, authored_by_name, authored_by_run, version, linked ids, timestamps, decided_by/at). CHECK: only `human` decides; status transitions as for scripts.
- `api_test_reviews` (append-only trigger, reviewer ≠ writer, run identity, verdict, notes, reviewed_hash).
- History rows reuse the existing history pattern. Retention and backup follow the other QA tables. Credentials: none stored.
- Playbooks `api_writer` and `api_reviewer` flip to `available: true` with the tool lists above.

## 7. Network and privacy
No outbound traffic at all in B1. Metadata-only capture is unchanged. All text passes the redaction engine and is control-character-stripped and length-capped. Agents see only definitions, never anything from an environment. The privacy and security documents get a section each.

## 8. Checkpoints (stop for your review after each)
1. **B1a: definitions.** Shared schema and checks, migration 018, service and routes, human-only decisions, page (list, drawer, form), tests (schema, fake-data and secret refusal, human-only, status rules), docs.
2. **B1b: Piper and Cole.** Tools, playbooks available, review table and checks, writer ≠ reviewer, outdated-by-hash, page review panel, tests, docs.
3. **B1c: results link.** Import of a report into API tests (via the JUnit path), shown per test, never changing approval status.
4. **B2 (separate approval, not planned now): sending.** Would need: a per-environment fixed address list entered by you, local and private address rules, Windows-protected credential values, timeouts, size caps, GET-only first, redacted run logs.

## 9. Threats considered
| Threat | Answer |
|---|---|
| Real credentials pasted into a test | Header and auth rules force references; patterns refused; redaction on all stored text |
| Real personal data in a body | `whyNotFake` refuses it; reviewer checklist; organisation rule on customer PII |
| Hidden addresses (SSRF later) | Path-only schema, no scheme or host, base is a name; nothing is sent in B1 |
| Agent approves its own work | Writer ≠ reviewer by trigger; approval human-only by CHECK |
| Oversized or hostile definition | Size caps, strict schema, unknown fields refused, text only |
| Schema with remote references | Subset without `$ref` |

## 10. What I will not know after building
No real API was ever called, so correctness of a test against a live service is not checked. The test of Piper and Cole through a live Claude Code session needs you, as for Axel and Vera.
