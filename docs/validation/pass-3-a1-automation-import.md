# Pass 3, checkpoint A1: automation results import (2026-11-25)

**Scope (agreed):** import JUnit XML a person chooses; store runs and per-test results (metadata only, failures "unknown" until classified); Test Automation page with run list, pass rate with its denominator, details in the side drawer. **Not in A1:** project-folder scanning or framework detection, CI/CD polling, any agent tools (Axel and Vera stay "Arrives in Pass 3"), Playwright/Allure/Robot-native formats beyond JUnit export.

**What was built**
- `packages/shared/src/junit.ts`: small defensive reader (no XML parser: no DOCTYPE/entity expansion, text bodies never read), caps of 20,000 results and 5 MB, redaction of names and messages.
- Migration 013 (`automation_runs`, `automation_results`; classification CHECK; duplicate-file refused by a unique content hash).
- `apps/server/src/qaAutomation.ts` and routes: import (with dry run), list, detail, classify, delete. Person-only at the service layer.
- `apps/web/src/pages/Automation.tsx`: import (file or paste, preview, name, environment), runs table, drawer with filter and per-failure classification.
- Fix found on the way: `button.danger` had no background (rendered as a cyan button with red text).

| # | Check | Result | Evidence |
|---|---|---|---|
| A1-1 | Statuses, names, durations, suites read; `>` in attributes; pytest/Playwright-style roots | Pass | `packages/shared/test/junit.test.ts` |
| A1-2 | No stack trace, log, path, secret or e-mail survives; DOCTYPE bomb and external entity not expanded | Pass | same, and `apps/server/test/qa-automation-service.test.ts` |
| A1-3 | Pass rate shows its numbers; skipped not counted; zero denominator shows no percentage | Pass | service test, `e2e/automation.test.ts` |
| A1-4 | Agent and system refused for import, classify, delete; failures only can be classified | Pass | service test |
| A1-5 | Same file refused twice (dry run says which run); changed file accepted | Pass | service and browser tests |
| A1-6 | Import never changes a manual test case; link only by code or Test Case ID in the name | Pass | service and browser tests |
| A1-7 | Project with runs cannot be removed (archive instead); deleting a run removes its results | Pass | service test |
| A1-8 | Agent token, hook token and cookie-less request cannot import | Pass | `e2e/automation.test.ts` |
| A1-9 | No sideways scroll at 360 px; screen works at five desktop sizes | Pass | `e2e/automation.test.ts`, `e2e/a11y-responsive.test.ts` |

**Not verified:** real exports from each tool (only hand-written JUnit samples were used; real files from your own projects are the next test); large files near the 5 MB cap in a browser.
