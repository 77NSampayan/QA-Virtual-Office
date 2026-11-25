# UI redesign, slice 5: interaction polish, responsive behaviour, accessibility (2026-11-25)

**Scope:** presentation and keyboard/screen reader behaviour, plus two fixes found while verifying (a build problem and a live-data race, both below). No backend, schema, event, WebSocket, MCP, security or privacy change.

**What changed**
- A "Skip to content" link is the first Tab stop. The page is a labelled main area, the current menu link carries `aria-current`, and after opening another page the focus moves to the page content.
- The browser tab names the page ("Manual QA · QA Virtual Office"); the DEMO and attention-count prefixes stay.
- A polite live region says when sessions need attention.
- Pages fade in over 140 ms, overlays ease in, loading messages show a small spinner. Everything stops when the system asks for reduced motion (the sprite clock already did).
- **Contrast:** a unit test reads the real stylesheet and requires 4.5:1 for every text colour on every surface. It found one real defect: a disconnected status written in the dark "powered off" grey was about 2.2:1. As text it now uses the muted text colour; lights and dots keep the dark grey.
- Every screen was checked at 1024x768, 1280x720, 1366x768, 1600x900 and 1920x1080: no sideways scroll, no console errors, menu and content both usable.

**Two problems found and fixed while verifying**
1. **Flaky build.** The same source sometimes minified into a different, broken bundle (the page failed to start with a React error). It happened in about one build in four. With minification off, builds were identical; the variation is in identifier renaming. `apps/web/vite.config.ts` now keeps minifying but does not rename identifiers, and forces one copy of React. 14 builds in a row were identical. The bundle grows from about 443 kB to 527 kB; it is served from this computer. The underlying minifier cause was not found.
2. **Live-data race (`live.tsx`).** The page fetches a snapshot and also listens for live messages. If a new session's message arrived while the snapshot was in flight, the older snapshot could overwrite the new robot, which then never appeared (seen as an intermittent browser test failure). A snapshot that raced with a live message is now fetched again (at most twice more).

| # | Check | Result | Evidence |
|---|---|---|---|
| S5-1 | Skip link, landmark, one current link, page titles, focus after navigation, live region, focus rings, reduced motion | Pass | `e2e/a11y-responsive.test.ts` |
| S5-2 | 14 screens at 5 window sizes: no sideways scroll, no console errors | Pass | same |
| S5-3 | Text colours readable (4.5:1), including status text | Pass | `apps/web/test/design-tokens.test.ts` |
| S5-4 | Whole suites | see the final message | typecheck, lint, unit, e2e |

**Not done:** a side drawer for row details and the Team page character manager (roster, preview, details) are still open decisions.
