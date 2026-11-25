# UI redesign, slice 2: the office first (2026-11-25)

**Scope:** layout and presentation of the Overview / Virtual Office screen. No backend, schema, event, WebSocket, MCP, security or privacy change; no new dependency; no QA behaviour change. KPI definitions and their "No data yet" rules are untouched.

**Measured before (current UI, 1280x720 to 1920x1080):** the office canvas started 740 to 950 px down the page and was visible 0 to 59% of the time without scrolling (with demo data 0% at three of the four sizes). It was a fixed 580 px tall, and with one session five of six rooms were empty floor.

**What changed**
- The office comes first. The canvas takes the height left on screen (at least 420 px), so all of it is visible without scrolling at 1280x720, 1366x768, 1600x900 and 1920x1080. The KPI grid and workload chart sit below it under "QA summary", unchanged.
- A live strip next to the title: Active, Working, Waiting for you, Idle, Failed (24 h). Every number is computed from real sessions (the same rules as the KPIs). Each chip says in its tooltip what it counts, and "Failed" is labelled as a 24 hour figure.
- A session list beside the office (collapsible, remembered): one row per real robot with its status, room, project and last event; people-needed first, then failures, then work. Choosing a row selects and follows that robot. With no sessions it says so and offers "Connect Claude Code". The "idle for more than 24 hours" switch moved into this list.
- The camera frames what is in use: the entrance plus the rooms that have a robot (plus the lounge when someone is resting there). With no session it shows the whole building. Buttons: Focus (frame what is in use) and Fit (whole building). The zoom floor went from 1 to 0.5 so the whole building fits a small window instead of being cropped.
- Rooms with no robot recede (a quiet dim) while at least one robot is in the office. Nothing is added, moved or hidden.
- Under 1100 px wide the list moves under the canvas; under 760 px the classic status cards are used, as before.

**Real-mode rules kept:** no fake robots or counts; the strip and the list read the same real sessions as the office; demo mode still shows its fictional data, clearly marked.

| # | Check | Result | Evidence |
|---|---|---|---|
| S2-1 | Whole canvas on screen, no sideways scroll, at four desktop sizes | Pass | `e2e/office-layout.test.ts` |
| S2-2 | No session: zeros, explanation, no robots. One session: counted once in the strip and list and office, camera closer than the whole-building view, list row selects and follows | Pass | same |
| S2-3 | Panel can be hidden (canvas gets the width) and the choice is remembered | Pass | same |
| S2-4 | Camera rectangle fit, occupied-room detection, whole building fits a small window | Pass | `apps/web/test/office.test.ts` |
| S2-5 | Whole suites | see the final message | typecheck, lint, unit, e2e |
| S2-6 | It looks right | For your review | screenshots, before and after, in the review folder |

**Known:** the building is wider than tall, so on tall windows there are dark bands above and below it; the right side of the building (reserved room) is mostly empty by design.
