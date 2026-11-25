# UI redesign, slice 6: visual comparison and functional verification (2026-11-25)

**Scope:** verification only. No source change in this slice.

**Method.** The Slice 0 capture script was re-run against the finished build: the same 9 screens at 1280x720, 1366x768, 1600x900 and 1920x1080 with demo data, plus the overview with one real-style session and with no session, and the seven Manual QA tabs at 1366x768. Before = Slice 0 baseline; after = this run (44 measured pages, screenshots kept locally, not committed).

| # | Check | Before | After |
|---|---|---|---|
| S6-1 | Office visible without scrolling (demo, one robot, no session, 4 sizes) | 0 to 59 % | **100 %** in all 12 cases |
| S6-2 | Sideways scroll on any measured page | none | none |
| S6-3 | Console or page errors on 44 measured pages | none | none |
| S6-4 | Office position from top at 1366x768 (demo) | below the KPI grid | 156 px (one-robot / empty: 105 px) |
| S6-5 | Manual QA tabs render (7) | yes | yes (screenshots taken; the capture script's tab loop timed out on a stray `.tab` element after the 7th, a script artefact, not a product fault) |
| S6-6 | Human-only rules (approve, PASS, close defect, complete task, answer permission) | covered by tests | unchanged: `git diff` shows no change in `apps/server`, `apps/mcp`, `apps/forwarder`, `apps/desktop` or `packages`; the server and MCP human-only tests passed in the full runs |
| S6-7 | Privacy | metadata only | unchanged: no capture, schema, event or route change; screenshots use demo or empty data only |
| S6-8 | Whole suites | | typecheck and lint clean; unit 787 passed / 1 skipped; browser 196 of 196 (Slice 5 run) |

**Judgement.** The overview now shows the office, a live strip and the session list on first view; before, it showed ten KPI cards and the office was off screen. Remaining visual notes: the building is wider than tall, so tall windows show dark bands above and below it; unoccupied rooms are dimmed on purpose.

**Still open:** side drawer for row details, Team page character manager, optional CI/CD Operator robot type, Windows 10 untested, and the user must press Reinstall hooks once for agent robots.
