# Pass 3, checkpoint A3b: CI/CD runs and opt-in polling (2026-11-26)

**Scope (approved design):** read recent runs of a connected GitHub Actions or Azure DevOps pipeline on request; Refresh button; polling switch that is off by default; "as of" label and error states; retention. **Not in A3b:** triggering or changing anything, logs or artifacts, test results from CI (import JUnit yourself), the office wall screen (A3c), agent tools.

| # | Check | Result | Evidence |
|---|---|---|---|
| A3b-1 | GitHub and Azure DevOps runs mapped to queued / running / passed / failed / cancelled / other; commit shortened to 7 characters | Pass | `apps/server/test/ci-runs.test.ts` |
| A3b-2 | The actor, requester, commit message, author and PR title in the provider's answer never reach the parsed runs, the database or the page | Pass | same, `e2e/ci-connections.test.ts` |
| A3b-3 | Links not on https and the provider's own site are dropped; text redacted, cleaned and capped; junk entries skipped; at most 30 runs | Pass | same |
| A3b-4 | The saved copy equals the latest answer (a run that dropped out is removed, never left "running"); nothing older than 30 days; "not modified" (ETag) keeps the runs and moves "as of" | Pass | same |
| A3b-5 | A failed refresh keeps the saved runs "as of" their last good read, with our own sentence and no provider text or token | Pass | same, browser test |
| A3b-6 | A rate limit makes the app wait as long as the provider asked and makes no request meanwhile | Pass | same |
| A3b-7 | Manual refresh at most every 10 seconds; polling off by default, refused when off or run out, never faster than 5 minutes (server side), stops after 2 hours, a click extends it | Pass | same |
| A3b-8 | The browser timer asks after 5 minutes and not before; the server refuses it when its own 5 minutes have not passed; switching off stops the requests | Pass | `e2e/ci-connections.test.ts` (fake clock) |
| A3b-9 | Person only (agent, system, agent token, hook token, no cookie refused); unknown fields refused; disconnect deletes the runs | Pass | `ci-runs.test.ts` |
| A3b-10 | Page: refresh, runs table with provider link, error state, polling switch and its stop time, 360 px (also fixed a layout rule so wide tables scroll inside their box) | Pass | `e2e/ci-connections.test.ts` |

**Not verified (needs you):** real GitHub and Azure DevOps answers (everything uses a local stand-in); how large a real answer is for 30 runs (the 1 MB cap would show "unexpectedly large" if exceeded); that the 2 hour and 5 minute rules feel right in daily use; the live test from A3a is still the first thing to do.
