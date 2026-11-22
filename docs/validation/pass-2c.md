# Pass 2C: Validation Results (2026-11-22)

**What 2C delivers (Manual QA tabs: Defects, Exploratory, Task board; the sidebar's Task Board opens the same board):**
- **Defects:** report a defect, or raise one straight from a failed test (title, steps, expected and actual result, environment and build are pre-filled and linked to the test case and run). Workflow: New → Open → In progress → Fixed → Ready to retest → **Closed**, with Rejected, Duplicate and Reopened.
- **Exploratory sessions:** plan a session with a charter and timebox, start it, add notes (note, bug, question, idea), turn a bug note into a defect, complete it with a summary.
- **Task board:** six stages (Backlog, Ready, In progress, Waiting for review, Blocked, Completed). Nothing is ever assigned automatically.
- The Overview's **Open defects** KPI is now real.

**Automated:** `npm test` → 28 files, **502 passed, 1 skipped** (+1 intermittent failure, see below). `npm run e2e` → 6 files, **79 passed** (7 new for 2C). Typecheck and lint clean.

| # | Acceptance criterion | Result | Evidence |
|---|---|---|---|
| 2C-1 | **An agent can never close, reject or reopen a defect, or change any defect status** | **Pass** | `checkDefectTransition` is tested for every allowed transition with agent and system actors (all refused); the service returns `403 human_required`; the database also refuses a CLOSED/REJECTED/DUPLICATE defect that is not recorded by a human (direct SQL with agent, system and NULL all fail; written with COALESCE, see ADR-039). An agent may report a defect (status New) and comment, and edit only its own defect while it is still New |
| 2C-2 | Defect workflow is enforced | **Pass** | No skipped steps (New cannot go straight to Closed, Open cannot go to Fixed); Rejected, Duplicate, Reopened and Closed need a note; a duplicate must name another defect in the same project; reopening clears the closure; finished defects cannot be edited until reopened; every change is in an append-only history (who, when, from → to, note) |
| 2C-3 | A failed test can raise a defect | **Pass** | Pre-filled and linked to the test case and execution (service, API and browser tests); the Execution screen lists the defects raised from the test; the link survives deleting nothing (SET NULL, never cascading) |
| 2C-4 | Exploratory sessions | **Pass** | Planned → running → completed, human only; notes only while running; a "bug" note becomes a defect exactly once and shows its DEF number; other note kinds cannot be raised; browser test walks the whole flow |
| 2C-5 | Task board | **Pass** | Created in Backlog and never auto-assigned (assignee is empty unless a person types one); **only a person completes a task** (service + DB CHECK); Blocked and reopening a completed task need a reason; an agent can create and move tasks but not complete them; links to a defect or test case must be in the same project |
| 2C-6 | Privacy | **Pass** | Every free-text field (titles, steps, notes, charters, comments, task text) is redacted before it is stored (emails, keys, tokens, cards): tested for defects and sessions. The forms say to use fake or masked data |
| 2C-7 | Real figures | **Pass** | "Open defects" says **No data yet** until a defect exists, then counts defects that are not closed, rejected or duplicate; the tooltip shows "N of M reported" and the open count by severity |
| 2C-8 | Data safety | **Pass** | A project that holds defects, sessions or tasks cannot be removed (409 "archive it instead"); histories are append-only (triggers) |
| 2C-9 | Access control and responsive | **Pass** | Every new route returns 401 without the session and 403 without the CSRF header; unknown ids 404; bad input 400; the three new tabs have properly spaced cards and no horizontal scroll at 360 px |

## Not done / open

- **Not in 2C by plan:** agent integration (MCP, agent-only routes and tokens) and "Launch Claude Code here" (2D). Agents already have the correct limited rights in the service layer, but no route exposes them yet.
- **Defects have no file attachments of their own.** Evidence (screenshots, logs) lives on the failed test execution that the defect links to. A defect created by hand has no attachment.
- **No export or backup of the new data beyond the database backup.** Redacted JSON/CSV export still excludes QA records.
- Task board columns are not drag-and-drop; tasks move with the buttons in the task detail (deliberate: keyboard and screen-reader friendly, and every move can carry a note).
- Per-user accounts do not exist: assignee is a free-text name or role.
- **The kill-9 database test (B6) fails intermittently when the whole suite runs** (Windows refuses to delete its temp folder, EPERM) and passes alone; it failed in the last full run again. Not a product defect, but worth fixing in the test harness.
