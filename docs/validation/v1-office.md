# Pass V, checkpoint V1: the walkable office (2026-11-22)

**What it is:** the Overview now shows one connected office building instead of separate department boxes: a **lobby** with an elevator and reception desk, a long **hallway**, one **project room per registered project** on both sides of it (vacant rooms fill the gaps so the building stays tidy), and a **lounge and kitchen** at the far end. Robots walk between their desk and the lounge. The old floor is one click away ("Classic view") and is used automatically on narrow screens.

**Rules (kept from the start: robots reflect real events only):**
- Who is where is decided by real status alone: **Idle or Completed → lounge**; everything else (working, waiting for you, failed, disconnected) → **their own desk** in their project's room.
- A robot **walks only when its target changes** (a status change, a new session, a layout change). With no events nothing moves: this is tested.
- A robot that appears after the page has loaded **arrives through the elevator**. Robots already present when you open the page are simply placed (no fake entrance).
- A robot keeps **the same desk** while it stays visible, so it returns to where it sat. Rooms grow with their robot count (2 desks per column, at least 4).
- Which lounge furniture a robot uses is a stable cosmetic pick; the room, desk and walking are driven by status.
- Rooms are labelled with the project's **safe alias** only; no paths anywhere.

**Camera:** drag to pan, scroll to zoom around the cursor, **click** a robot for a details card (status, project, last seen), **double-click** (or "Follow") to follow it, buttons for zoom, **Fit** and **Enlarge**; keyboard: arrows pan, `+`/`-` zoom, `0` fits, `F` follows the selected robot, `Esc` clears. Reduced-motion users get instant moves and no easing.

**Accessibility:** the canvas is a labelled keyboard-operable region, and a hidden list mirrors every robot (name, status, zone, room) for screen readers; the same list is what the browser tests read.

**Automated:** `npm test` → 33 files, **573 passed, 1 skipped** (25 new tests for the building, pathfinding, camera and scene). `npm run e2e` → 10 files, **109 passed** (12 new in `office.test.ts`). Typecheck and lint clean.

| # | Acceptance criterion | Result | Evidence |
|---|---|---|---|
| V1-1 | The building is valid | **Pass** | at least two rooms, an even count, rooms on both sides of one hallway; every desk, door, lounge nook and standing spot is walkable and reachable from the elevator; desks and furniture block walking |
| V1-2 | Placement follows real status only | **Pass** | scene tests and browser tests drive real hook events: idle/completed rest in the lounge, working goes to the desk, waiting/failed stay at the desk, an ended session goes dark at its desk |
| V1-3 | **No movement without an event** | **Pass** | unit test: 120 s of ticks and repeated identical syncs change nothing (positions and version); browser test: every robot's zone and position are identical before and after 3 s of silence |
| V1-4 | Walking is real and safe | **Pass** | routes are shortest walkable paths (breadth-first, deterministic); no waypoint crosses a wall or a desk; speed is the documented 6 tiles per second; desks are unique per room and reserved per robot |
| V1-5 | Arrivals | **Pass** | a robot appearing after page load starts at the elevator and walks to its place; robots present at load are placed in place |
| V1-6 | Camera | **Pass** | zoom keeps the point under the cursor fixed and is limited to 1x–8x; drag pans and never leaves the building; follow eases and is cancelled by dragging; keyboard and button controls (unit + browser tests) |
| V1-7 | Views and responsiveness | **Pass** | Classic view toggles and is remembered; at 360 px the status cards replace the canvas with no horizontal scroll; reduced motion places robots instantly |
| V1-8 | Honest and private | **Pass** | rooms show project aliases only; the canvas draws nothing that is not in the sprite code or real data; no new data is captured or stored |

**Other tests changed on purpose:** the older floor, lounge and demo browser tests now request the classic view (or read the new office list) because the Overview defaults to the office.

## Not done in V1 (planned next)

- **V2:** more lounge activities (TV, ping-pong, kitchen chat), hourglass while a command runs, confetti when a robot finishes, tool-category bubbles, drones arriving by the elevator, a raised-hand alert when a robot waits for you.
- **V3:** day/night lighting, seasonal themes, optional sounds.
- **V4b (not approved yet):** approving permission requests from the office.
- Robots do not avoid each other while walking (they can overlap briefly); the lobby and the vacant rooms are mostly empty; rooms are drawn flat (no walls with depth); the project room page still uses the classic floor.
