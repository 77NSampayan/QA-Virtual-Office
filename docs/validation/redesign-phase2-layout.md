# Office redesign, phase 2: layout (2026-11-23)

**What changed:** the office is now built from fixed rooms by kind of work (QA Team, Automation Lab, API & Data Lab, Debug Lab, CI/CD Control, and one room reserved for later), a lobby with a reception desk and waiting area, a lounge with a kitchen, and a two-row hallway. The hallway shrank from three rows to two and the building is about 63 x 30 tiles (it was wider and taller for the same content).

**Rules kept:**
- A robot goes to the room of the robot type its owner chose (`roomKeyForType`). Nothing is inferred from events. Unknown or older types go to the QA Team room.
- The named agents (Quinn, Rhea ...) keep their name-plated desks in the QA Team room (the old separate team room is merged into it). Ordinary robots never take a desk kept for a named agent.
- A robot appears and moves only because of a real event, exactly as before.
- Wall screens and boards show nothing but a neutral standby pattern. They light up only when a real integration provides data.
- When a room is full, a robot takes a free ordinary desk in another room, instead of sharing a desk.

**Not done in this phase:** the CI/CD Operator robot type (phase 3), the new robot designs (phase 3), the HUD (phase 5), integer zoom (phase 5).

| # | Check | Result | Evidence |
|---|---|---|---|
| L-1 | The six rooms exist in a fixed order, the last is vacant; both rows end together; the hallway is two rows | Pass | `apps/web/test/office.test.ts` (building generator) |
| L-2 | Type to room mapping, unknown types fall back to the QA Team room | Pass | same |
| L-3 | Every seat, door, nook and standing spot is walkable and reachable from the elevator, for small and large rooms | Pass | same |
| L-4 | Floor furniture blocks walking and never overlaps another item, a desk, a seat tile or a doorway | Pass | same |
| L-5 | Wall displays sit on walls, clear of doorways and windows | Pass | same |
| L-6 | Reserved agent desks, overflow to another room, no desk sharing | Pass | `office.test.ts` (QA Team room) |
| L-7 | In a browser: nine named desks, an agent at its desk, a plain session in the room of its type | Pass | `e2e/team-office.test.ts` |
| L-8 | Whole suites | Pass | unit 768 passed / 1 skipped, e2e 172 passed, typecheck and lint clean |
| L-9 | It looks right | For your review | `QAVO_E2E_SHOTS=<folder> npm run e2e` writes `team-room-empty.png` and `team-room-quinn.png` |
