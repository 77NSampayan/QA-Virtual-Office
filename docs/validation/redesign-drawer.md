# UI redesign: side drawer for row details (2026-11-25)

**Scope:** presentation only. No backend, schema, event, security or privacy change; human-only actions unchanged (the same detail panels, now shown in a drawer).

- Test cases, Defects, Requirements and Execution rows no longer expand inline (which pushed the table down); the details open in a right-hand drawer (`Drawer` in `apps/web/src/ui.tsx`).
- Wide screens (over 1100 px): the page makes room, so the table stays visible and clickable; clicking another row switches the drawer. Narrow screens: the drawer covers the page until Close.
- Close button, or Escape (ignored while typing in a field, so text is never lost). Focus moves into the drawer; it is a labelled complementary region.
- Task board and Exploratory already used a separate panel below their lists and are unchanged.

| Check | Evidence |
|---|---|
| Opens beside the table, switches rows, Close and Escape work, no sideways scroll | `e2e/drawer.test.ts` |
| Escape does not close while a field has focus | same |
| 360 px: no sideways scroll with a drawer open; existing detail selectors still work | `e2e/qa-2a.test.ts` |
