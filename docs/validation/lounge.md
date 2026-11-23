# Lounge zone: Validation Results (2026-11-22)

**What it is:** a lounge in the office floor (Overview, and each Project Room). Robots that are **resting** sit there instead of at their desk: on a **couch**, at the **coffee corner** or at an **arcade cabinet** (animated furniture: rising steam, a shuffling arcade screen, a blinking marquee). The lounge is always on the floor: with nobody resting it shows the three free spots and "Nobody is resting right now". The Sprite gallery has a "Lounge furniture" section.

**Rule (kept from the start: robots reflect real events only):**
- A robot is in the lounge **only while its real status is Idle or Completed** (its session is open and it is neither working nor waiting for you).
- The moment a real event makes it work (prompt, tool use, test run), wait for you (permission, input) or fail, it is back at its desk. A session that ended goes dark **at its desk**, not in the lounge.
- Nothing moves on a timer or at random. Which piece of furniture a robot uses is a stable cosmetic pick from its id (the same robot always uses the same kind); whether it is in the lounge is decided by status alone. The status pill, the colour of its face and its "seen … ago" line are the real ones.

**Automated:** `npm test` → 32 files (+ the kill-9 test occasionally fails when the whole suite runs, see known issues; passes alone). `npm run e2e` → 9 files, **97 passed** (7 new in `lounge.test.ts`). Sprite tests: furniture is deterministic, 32x16, wraps frames, animates where it should (and the couch does not), and the visual layer still contains no `Math.random` or clocks.

| # | Check | Result | Evidence |
|---|---|---|---|
| L-1 | A new (idle) session's robot rests in the lounge; working moves it to its department desk; finishing brings it back | **Pass** | `lounge.test.ts` drives real hook events through the server and watches the browser |
| L-2 | Waiting for the person, failures and ended sessions never rest | **Pass** | permission / input / failed stay in their department; ended goes dark at the desk |
| L-3 | Nothing moves without an event | **Pass** | the placement of every robot is identical before and after 2.5 s of silence |
| L-4 | The lounge always exists | **Pass** | an empty office shows 3 free spots and the "nobody is resting" text |
| L-5 | Departments stay truthful | **Pass** | headers count robots "at desks"; a department whose robots all rest says "Everyone here is resting in the lounge" |
| L-6 | Narrow screens | **Pass** | at 360 px resting robots appear as cards inside the lounge, no horizontal scroll |

**Other tests changed on purpose:** the old status-walk and department checks assumed idle and completed robots sit at a desk; they now expect the lounge for those two statuses.

**Not done:** robots do not walk between the desk and the lounge (they appear in place); no full-office top-down view with walls; no sound.
