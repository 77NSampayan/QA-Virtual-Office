# Test-case import from a Markdown table or spreadsheet paste (2026-11-23)

**What it does:** Manual QA → Test cases → **Import from table**. Paste a Markdown table, copy the cells from a spreadsheet, or load a `.md`/`.txt`/`.tsv` file. A preview shows what will be created, what already exists, what could not be read and which columns are ignored; nothing is written until you press Import. The column layout is the team's template (see `docs/templates/test-cases-template.md`).

**Rules kept:**
- Every imported case is a **draft written by the person**. There is no way to import as approved or in review, and no result is ever imported (the database has no execution rows after an import; a "Passed" in the sheet is ignored and reported as such).
- Only a signed-in person can import (agents and the system actor are refused in the service, not only the route).
- Re-importing is safe: a row whose Test Case ID already exists in the project is skipped. Rows with no ID are counted and the preview warns that importing them again adds them again.
- Nothing is guessed: an unknown type or priority falls back to a documented default and shows a warning per row; unknown requirement refs are reported, never created.
- Privacy: result, evidence, defect and automation columns are never read into memory beyond the table parse and are never stored or logged. Test Data is stored as typed (people should not paste real customer data; the template says so), and everything an agent reads is still redacted again on output.

**One schema change (needs your awareness, additive only):** migration `008` adds `test_cases.external_id` (default empty) and a unique index per project on `lower(external_id)` when set. Existing rows are unchanged.

| # | Check | Result | Evidence |
|---|---|---|---|
| TI-1 | Template columns are mapped; result/automation columns are ignored and listed | **Pass** | `packages/shared/test/testCaseImport.test.ts` (Markdown and spreadsheet paste incl. quoted multi-line cells; nothing from Status/Actual Result/Defect ID reaches a row) |
| TI-2 | Steps, long descriptions, `<br>`, escaped pipes, several tables, row cap (1000), requirement refs | **Pass** | same file |
| TI-3 | Preview writes nothing; import creates human-authored DRAFTS with `imported` history, no approval, no executions | **Pass** | `apps/server/test/qa-import-testcases.test.ts` |
| TI-4 | Re-import skips existing IDs; IDs independent per project; repeated IDs in the text keep the first; DB keeps IDs unique case-insensitively | **Pass** | same file |
| TI-5 | Only a human can import; bad input (no table, missing description column, oversize, extra fields such as `status`, unknown project) is refused and writes nothing | **Pass** | same file |
| TI-6 | In a real browser: preview, import, safe re-import, spreadsheet paste, file load, visible problems, search by sheet ID, no horizontal scroll at 360 px | **Pass** | `e2e/tc-import.test.ts` (5 tests) |

## Limits
- Markdown pipe tables and tab-separated pastes only (no `.xlsx` upload; copy the cells instead).
- Up to 1000 rows and 400 KB per import; split larger sheets.
- Updating an existing case from a re-import is deliberately not supported (it would overwrite reviewed work); edit it in the app.
