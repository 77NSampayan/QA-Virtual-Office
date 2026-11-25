# UI redesign, slice 4: Manual QA screens (2026-11-25)

**Scope:** presentation of the Manual QA workspace (Requirements, Test cases, Execution, Defects, Exploratory, Task board, Traceability). No new QA functionality, no change to any action, approval rule, API call or data. Human-only approval, results, closing and completing are exactly as before.

**What changed**
- The sections are a real tab bar (underlined current tab) instead of a row of cyan buttons, with the project selector above it. "New / Import" toggles keep their button look, so a toggle no longer looks like a section.
- The test case toolbar separates the two actions from the filters and puts the count on the right.
- About 50 inline styles in the QA pages became a handful of shared classes (`grow`, `prewrap`, `static`, `quiet`, `reply`, `ok-text`, `warn-text`, `empty` and others) in the one stylesheet. The nine inline styles that remain colour a status from its own data, on purpose.
- Empty tables show a centred, padded message instead of a cramped grey row.

**Left as it was, on purpose**
- Row details still open inline under the row. A side drawer was in the plan, but the existing browser tests drive that inline layout, and a drawer is a behaviour change, so it needs its own decision.
- Action hierarchy was already consistent in these pages (main action filled, others `ghost`, destructive `danger`); it was not changed.
- Team, Settings, Sessions, Rooms and Control keep their markup (slice 5 covers polish).

| # | Check | Result | Evidence |
|---|---|---|---|
| S4-1 | All existing QA flows (requirements, test cases, execution, defects, exploratory, tasks, import, reviews) | Pass | `e2e/qa-2a` to `qa-2d`, `tc-import`, `reviews` (53 tests) |
| S4-2 | Tab bar with exactly one current tab; project selector above; toolbar actions apart from filters | Pass | `e2e/qa-layout.test.ts` |
| S4-3 | No section scrolls sideways at 1280x720, 1366x768, 1600x900, 1920x1080 | Pass | same |
| S4-4 | Whole suites | see the final message | typecheck, lint, unit, e2e |
| S4-5 | It looks right | For your review | screenshots in the review folder |
