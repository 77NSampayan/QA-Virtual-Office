# UI redesign, slice 1: design tokens and application shell (2026-11-24)

**Scope:** styling and shell only. No backend, schema, event, WebSocket, MCP, security or privacy change; no new dependency; no QA behaviour change.

**What changed**
- `styles.css` now starts with one token layer: surfaces, text, brand and semantic colours (one meaning each), a type scale (11 to 28 px), a 4 px spacing scale, radius, elevation, motion and layout sizes. Components use the tokens instead of hard-coded colours. All existing class names and `data-*` hooks are unchanged.
- Buttons: a filled brand button is the main action; new `.secondary` (quiet) next to `.ghost` and `.danger`. Hover, active, disabled and a visible keyboard focus ring for every control.
- Tabs: the current tab is outlined in the brand colour instead of a second solid cyan button.
- Tables: roomier cells, sticky header, hover only through a token.
- Shell: one top bar (brand mark, demo pill, live state, hooks state, a "Local only" chip carrying the privacy sentence), a slimmer sidebar (200 px, sticky), a button that hides the sidebar on desktop (remembered in the browser, nothing sensitive), the footer removed, "Pass N" tags removed from the sidebar, Sprite gallery moved to Settings ("About"), and a favicon (this removes the 404 seen on first load).
- Reduced motion now switches off every CSS transition and animation.

**Untouched on purpose:** routes, auth screen, demo isolation and its banner, pages' markup (slice 4), the office (slice 2).

| # | Check | Result | Evidence |
|---|---|---|---|
| S1-1 | All routes still load, narrow drawer still works, no horizontal scroll at 360 px | Pass | `e2e/c-office.test.ts` |
| S1-2 | Whole suites | Pass | unit 768 passed / 1 skipped; e2e 172 passed (one reduced-motion office test failed once under full-suite load and passed 3 of 3 reruns); typecheck and lint clean |
| S1-3 | Looks consistent at 1366x768 (Overview, Manual QA) | For your review | screenshots, before and after |

**Known and left for later slices:** the main action is still the brand-filled default on pages that have several buttons in a row (action hierarchy per page is slice 4); `.empty-state` exists but pages do not use it yet; roughly 80 inline styles remain in page components.
