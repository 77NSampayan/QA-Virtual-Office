# Pass 3, checkpoint A2: framework detection (2026-11-25)

**Scope (agreed with A1):** a read-only scan of a registered project's folder for Playwright, Cypress, Selenium, WebdriverIO, TestCafe, Jest, Vitest, Mocha, pytest, Robot Framework, JUnit and TestNG, shown on the Test Automation page with how to export JUnit XML from each. **Not in A2:** CI/CD monitoring (A3), agents (A4), reading source or test files, storing scan results.

**How it stays narrow:** person-pressed only; file names plus dependency names and declared versions from package.json, requirements*.txt, pyproject.toml, pom.xml and build.gradle (at most 40 files, 256 KB each); three folders deep, 5,000 entries, 3 seconds; no links followed; node_modules, virtualenvs, build output and hidden folders skipped; nothing written, nothing stored (no migration); the result carries base names and versions, never paths or contents.

| # | Check | Result | Evidence |
|---|---|---|---|
| A2-1 | Manifest readers return names and versions only (secrets in scripts or index URLs never appear) | Pass | `apps/server/test/framework-detect.test.ts` |
| A2-2 | Config files and dependencies found; evidence says root or subfolder; no path, no file content in the answer | Pass | same, `e2e/automation.test.ts` |
| A2-3 | node_modules, virtualenvs, hidden and deep folders skipped; source files never read; links not followed; oversized manifest ignored; early stop on a huge folder | Pass | same |
| A2-4 | Person only (service); agent token, hook token and cookie-less request refused over HTTP; missing folder gives a clear message | Pass | same, `e2e/automation.test.ts` |
| A2-5 | Never scans on its own; shows framework, confidence, evidence and an export hint | Pass | `e2e/automation.test.ts` |

**Not verified:** detection on your real projects (only synthetic folders were used); how the export hints behave with your exact tool versions (they are the tools' documented switches, not run here).
