# Pass 2B: Validation Results (2026-11-22)

**What 2B delivers:** manual **test execution with evidence**. Open **Manual QA → Execution**. You create a *test run* (a round of testing: name, environment, build), which starts with every **approved** test case. For each test you set a result (In progress, Passed, Failed, Blocked, Skipped), record the actual result and a note, and attach **evidence** (notes, screenshots, PDFs, text logs). Closing a run locks it. The Overview result KPIs and the Test cases tab now show real results.

**Automated:** `npm test` → 25 files, **466 passed, 1 skipped** (the symlink-privilege skip from 1A). `npm run e2e` → 5 files, **70 passed** (9 new for 2B). Typecheck and lint clean.

| # | Acceptance criterion | Result | Evidence |
|---|---|---|---|
| 2B-1 | Only approved test cases can be tested | **Pass** | Drafts, in-review, rejected and archived cases are never added; they are reported as "skipped (not approved)" rather than silently dropped. Cases from another project are refused. Adding a case twice is a reported no-op (`qa-exec-service.test.ts`, browser test: a draft is absent from the run) |
| 2B-2 | **An agent can never mark a test PASSED** (or SKIPPED) | **Pass** | Enforced in the service (`403 human_required` for agent and system, with or without a note) **and by the database** (`CHECK` that PASSED requires `executed_by = 'human'`; direct SQL attempts with agent, system and NULL all fail). An agent may only start a test or report FAILED/BLOCKED with a note, and that is recorded as *agent assisted*. Only a person can create or close runs and delete evidence. HTTP routes under `/api` are always the human; agent routes arrive in 2D |
| 2B-3 | Results are explained | **Pass** | FAILED, BLOCKED and SKIPPED need a note; changing a finished result (re-testing) needs a note; setting the same result again is refused. Every change is in an append-only history (who, when, from → to, note); the browser test shows the history entries |
| 2B-4 | Evidence is safe | **Pass** | Allowed types only (png, jpg, gif, webp, pdf, txt, log, json, csv), checked by extension **and file signature**; max 5 MB, 20 items per test; stored under random names in `%LOCALAPPDATA%\QA Virtual Office\evidence\` (never the original name or path); SHA-256 and size recorded; downloads are **attachments** with `nosniff` and a sandboxing CSP; a tampered stored name can never serve a file outside the evidence folder (tested). Notes, actual results and text files are **redacted** (emails, keys, tokens, cards) before they are stored. Images and PDFs cannot be redacted: the screen says so and asks you to check them |
| 2B-5 | Closed runs are immutable | **Pass** | A closed run rejects results, new cases, evidence and evidence deletion with `409 run_closed` (service, API and browser tests) |
| 2B-6 | Real figures with visible denominators | **Pass** | Overview "Passed / Failed / Blocked tests" say **"No data yet"** until a test has actually been executed. After that they count the **latest finished result per approved test case** (re-testing in a later run replaces, never double-counts); pending = approved cases without a finished result. The tooltip shows the formula and denominator, e.g. "of 3 approved… passed / (passed + failed + blocked)"; skipped tests are shown but left out of the pass rate; with nothing decided the rate is "—". Archived or un-approved cases drop out (tested) |
| 2B-7 | A changed test case is not trusted silently | **Pass** | Each execution remembers the test case version it started from; if the case is later edited or un-approved, the run shows a "changed" badge and a warning |
| 2B-8 | Test cases show their result | **Pass** | The Test cases tab shows PASSED / FAILED / BLOCKED / SKIPPED / IN PROGRESS / NOT RUN from the latest result (browser-tested) |
| 2B-9 | Access control and responsive | **Pass** | Every new route returns 401 without the session and 403 without the CSRF header; unknown ids are 404; uploads over the limit are 413. The execution board has no horizontal scroll at 360 px |

## Defect found in 2A and fixed during 2B (please read)

**2A's "the database enforces human-only approval" was not fully true.** The CHECK constraint on `test_cases` let a row through when the approver was *missing* (NULL): in SQLite a CHECK that evaluates to NULL passes. A direct SQL write could mark a case `approved` with no approver. The service layer always blocked this, and the application never wrote such a row, so nothing in your data is affected. Migration 004 adds triggers that refuse an approved case unless the approver is `human` and a timestamp exists (tested for NULL, agent and missing timestamp). The new PASSED constraint was written with the same care (`COALESCE`). The 2A validation text should be read with this correction.

## Not done / open

- **Not in 2B by plan:** defects, exploratory sessions and the task board (2C), agent integration and "Launch Claude Code here" (2D). "Open defects" still says "No data yet".
- **Evidence is not in exports.** Redacted JSON/CSV exports do not include QA records or evidence files yet. **Backups copy the database only, not the evidence folder**; copy `evidence\` yourself if you need it.
- **Screenshots and PDFs are stored as received** (they cannot be redacted). Do not attach images that show real customer data.
- No thumbnail previews: evidence files are downloaded, not displayed in the page (deliberate, for safety).
- Per-user accounts do not exist (one local user).

## Also fixed alongside 2B

- **Layout:** the requirement-reference checkboxes were stacked above their text (a CSS specificity clash), and cards inside the Manual QA tabs touched each other (the tab wrapper had no spacing). Both are fixed and covered by browser regression tests.
- **Importer:** `VR-` (field validation rule) references now import as kind FSD, like FR and NFR.
- **Build note:** build the web app from a terminal opened at `C:\VirtualOffice`; building through the lower-case `/c/VirtualOffice` path produced a broken bundle on this machine.
