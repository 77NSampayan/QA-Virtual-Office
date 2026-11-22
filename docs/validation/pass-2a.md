# Pass 2A: Validation Results (2026-11-22)

**What 2A delivers:** the first part of the Manual QA department: **requirements** (manual entry, import from pasted BRD/FSD/user-story text, automatic ambiguity checks, human-reviewed flags), **test cases** (every specified field, ten test types, a human-only approval workflow with append-only history) and **traceability** (requirement coverage with its numerator, denominator and formula). Open it from **Manual QA** in the sidebar.

**Approved plan for Pass 2:** 2A requirements + test cases → 2B manual execution + evidence → 2C defects + exploratory + task board → 2D agent integration (MCP, drafts only). The rule "only a signed-in human approves test cases, marks tests PASSED or closes defects" was approved up front.

**Automated:** `npm test` → 21 files, **408 passed, 1 skipped** (the symlink-privilege skip from 1A). `npm run e2e` → 4 files, **61 passed** (15 new for 2A). Typecheck and lint clean.

| # | Acceptance criterion | Result | Evidence |
|---|---|---|---|
| 2A-1 | CRUD with validation | **Pass** | `qa-service.test.ts` (36) and `qa-api.test.ts` (10): every field validated (lengths, enums, unknown fields rejected, references unique per project case-insensitively, linked requirements must belong to the same project); proper status codes (400/403/404/409/422); UI forms exercised in a real browser |
| 2A-2 | **An agent identity cannot approve** (or reject, or move a test case through any workflow step) | **Pass** | The rule lives in the **service layer**, not the UI: agents/system get `403 human_required` for every transition, for resolving flags, for editing or deleting requirements, for archiving and for running checks; an agent may create requirements, create DRAFT test cases (marked agent-authored), raise flags, and edit only its own drafts that are still drafts. **The database enforces it too:** a CHECK constraint makes an approval impossible unless it is recorded as made by a human with a timestamp (direct SQL attempts fail). HTTP clients cannot choose their actor (an `x-qavo-actor` header is ignored; `authoredBy`/`status` in a body are rejected) |
| 2A-3 | Approval workflow rules | **Pass** | draft → in review → approved / rejected (and back to draft); a draft can never jump straight to approved; approval needs a title, a real step and an expected result (the missing items are named); rejection needs a reason; editing an approved or in-review case returns it to draft (the UI says so first) and bumps the version; archived cases cannot be edited or moved; a revoked approval clears its approver. Browser test walks the whole flow |
| 2A-4 | Coverage with a valid denominator and a visible formula | **Pass** | `coverageRatio` returns numerator, denominator and a percentage only when the denominator is positive; the Traceability screen shows "X of Y requirements" plus the formula text, and **"—" with "No requirements yet" when Y = 0** (browser-tested). Archived test cases do not count. Test cases without a requirement are counted separately |
| 2A-5 | History is append-only | **Pass** | Triggers abort any UPDATE or direct DELETE on `test_case_history`; tests try to tamper with direct SQL and fail. Each entry records who (human/agent/system), what, status change and which fields changed (before/after for short fields, field names only for long text) |
| 2A-6 | Requirements are never assumed correct | **Pass** | Deterministic checks (no AI) raise OPEN flags for vague wording ("user-friendly", "etc."), placeholders (TBD/TBC), weak modals ("may") and performance claims with no number ("quickly"); a precise requirement raises nothing; each hint is raised once and a dismissed hint is never raised again; only a human resolves or dismisses a flag; conflict flags link to the other requirement (same project). Imports never overwrite an existing reference and are previewed first |
| 2A-7 | Data safety | **Pass** | A project that holds requirements or test cases **cannot be removed** (409 with "archive it instead"; the Project Room shows the message); QA tables use RESTRICT foreign keys; deleting a requirement removes its flags and links but never the test cases |
| 2A-8 | Responsive | **Pass** | All three tabs checked at 360 px with a requirement and a test case open: no horizontal page scroll |
| 2A-9 | Real data only | **Pass** | The Overview gains one real KPI, "Test cases awaiting review". "Passed/failed/blocked tests", "Pending test cases" and "Open defects" still say "No data yet" until 2B/2C, and a test case's execution status is always **NOT RUN** until executions exist |

## Defects found and fixed during 2A

1. **The test case Edit form could never save.** It copied every field of the loaded test case (including `status`, `code`, `authoredBy`) into the form and sent them all back; the server correctly refuses fields a client may not set. Found by the browser test; the form now carries only the editable fields.
2. **Project removal returned a raw database error** when QA records exist. It now returns a clear 409 and the screen explains it (in the error colour, not the success colour).
3. A few layout and lint details (an "Archived" checkbox stacked above its label; comma-expression style).

## Not done / open

- **Not in 2A by plan:** execution board and evidence (2B), defects, exploratory sessions and the task board (2C), agent integration and "Launch Claude Code here" (2D).
- **QA records are not in the redacted JSON/CSV export yet.** Backups (full database copies) do include them. They will be added to the export, with redaction, together with the data they link to.
- **Free text is stored as typed.** Requirement text, steps and test data can contain sensitive information; the form says to use fake or masked test data. Redaction will be applied to anything an agent can read (2D).
- Per-user accounts do not exist (one local user): "assigned tester" is a free-text name.
