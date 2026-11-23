# Pass V, checkpoint V2: life in the office, walls and doors (2026-11-22)

**What's new in the walkable office:**
- **Real walls and doors per room.** Walls now have depth: a lit top edge, a front face with panel seams and a baseboard, a soft shadow where they meet the floor, and **trim in each room's own colour**. Every room has a **double door** with a frame and a **name plate in the room's colour** (grey when the room is vacant). Doors **swing open when a robot walks through** and shut again afterwards; vacant rooms stay shut. The elevator's sliding doors open when a new robot or subagent arrives.
- **More lounge life.** Two new activities, a **TV corner** (animated screen) and a **ping-pong table** (ball and paddles), alongside the couch, coffee corner and arcade. Robots standing in the kitchen area next to each other **chat** (speech bubbles).
- **Activity bubbles** over a working robot: *reading, searching the web, writing tests, editing code, writing docs, editing config, running tests, building, using git, installing, in the terminal, delegating, planning, using a tool*. They come **only from the tool's name and the categories the forwarder already derived locally**; no file names, commands or content ever appear, and a bubble disappears when the robot stops working or the tool is more than 2 minutes old.
- **Hourglass** next to a robot while its tests/command are running.
- **Raised-hand alert (V4a):** a pulsing badge (`!` orange for a permission request, `?` yellow for a question) and a pulsing name-tag outline while a robot waits for you.
- **Celebrations:** confetti when a robot **finishes**, a small rain cloud when it **fails**. They happen only when a real status change to that status is observed (never when the page first loads, and never with reduced motion).
- **Subagents (drones)** arrive through the elevator and hover beside their robot, following it as it walks.

**Rules kept:** robots reflect real events only; nothing moves, opens or celebrates without an event; capture stays metadata-only. The one new piece of data is the session's *current tool* (name + two categories), taken from events we already store.

**Automated:** `npm test` → 35 files, **607 passed, 1 skipped** (+ the intermittent kill-9 test, see known issues). `npm run e2e` → 10 files, **115 passed** (6 more office tests for V2). New tests cover: bubble wording from categories only, the activity field (subagent events excluded; events carrying paths or commands are rejected outright), effects, drones, doors, lift, chat, the TV and ping-pong sprites, and "everything is still after settling".

| # | Check | Result | Evidence |
|---|---|---|---|
| V2-1 | Bubbles use metadata only | **Pass** | `toolBubble` unit tests (a path or command passed as a category never appears); server test: the activity DTO has exactly tool, two categories and a timestamp; events with `toolInput`/`cwd` are refused |
| V2-2 | Bubbles follow real activity | **Pass** | browser test: Read → "reading", Write(test) → "writing tests", Edit(source) → "editing code", Bash(test_run) → "running tests" + hourglass; cleared on Stop |
| V2-3 | Alerts | **Pass** | permission → orange alert, question → yellow alert; cleared when answered |
| V2-4 | Celebrations only on a real change | **Pass** | unit: none on first placement, on identical syncs, on initial load or with reduced motion; expire after 2.6 s / 4.2 s; browser: appear on Stop / StopFailure, then clear |
| V2-5 | Drones | **Pass** | unit and browser: present at load → hover in place; started later → fly in from the elevator (which opens), then hover; follow a walking robot; removed when the subagent ends |
| V2-6 | Doors | **Pass** | unit: opens only within a short radius of a walker, shuts again, vacant rooms never open, a far robot never opens a door; browser: `doorsOpen` becomes non-empty while a robot walks through its room door and empty afterwards |
| V2-7 | Nothing animates without an event | **Pass** | unit: after settling, no walking, doors, drones, lift or effects; browser: after 16 s of silence everything is still and the mirrored state is identical 2.5 s later |
| V2-8 | Walls and doors look right | **Pass** (visual) | per-room trim and plates, windows on the faces, door leaves swinging (screenshots reviewed) |

**Other changes:** the classic floor's lounge now lists five free spots when nobody is resting; the sprite gallery shows all five lounge pieces (and a crash with five kinds, found by the browser tests, is fixed).

## Not done / next

- **V3:** day/night lighting from your local time, seasonal themes (Halloween, Christmas), optional sounds (off by default).
- **V4b (not approved):** approving permission requests from the office.
- Walls are drawn 2.5D, not true isometric; robots do not avoid each other while walking; door leaves are drawn in front view (they do not swing in perspective); the lobby and vacant rooms are sparse.
