# Pass V, checkpoint V3: atmosphere (2026-11-22)

**What's new (Settings → Office appearance controls all of it):**
- **Day and night from your own clock.** Sunrise 06:30, sunset 18:30, one-hour fades. By day the windows show sky and clouds and **sun shafts** fall into the north rooms; at dusk the sky turns orange; at night the windows show stars and a moon, the rooms dim (never darker than 42%, so everything stays readable), and **lit screens, hallway lamps, the TV and the arcade glow**. Choices: *Automatic*, *Always day*, *Always night*. No location is used or asked for.
- **Seasonal themes:** *Automatic* (Halloween 15 Oct to 2 Nov, Christmas 1 Dec to 6 Jan), *None*, *Christmas*, *Halloween*. **Christmas:** garlands with twinkling lights along the walls, a tree with gifts in the lobby, snow on the window sills, drifting snow in the hallway, Santa hats on the robots. **Halloween:** pumpkins, cobwebs in the corners, orange trim, bats flying through the hallway, witch hats on the robots. A chosen theme always wins over the date.
- **Sounds, off by default.** Short quiet tones synthesized in your browser (no audio files, nothing downloaded) for four real events: a robot **arriving**, **finishing**, **failing**, or **needing you**. A volume slider, and "Hear" buttons in Settings to try each one. They play only while the office is open and visible.

**Rules kept:** preferences are saved only in this browser or desktop window (validated when read; garbage is ignored), nothing is sent anywhere, nothing in your data changes, and everything animated is derived from the scene clock (no randomness, no wall clock in the visuals). Sounds are only ever triggered by real status changes or arrivals, never by the first placement when the page loads, and are rate-limited (per kind and overall).

**Also fixed in this checkpoint (found because the test suite kept failing intermittently):** the database recovery treated **any** failure to open the database as corruption, including a temporary file lock right after a crash. In that case it would have moved a healthy database aside and restored an older backup. Now only genuine corruption (a bad header or a failed quick check) triggers recovery; a lock or permission error is retried for a few seconds and then reported, leaving every file untouched. Three new tests prove it, and the previously flaky kill-9 test now passes reliably.

**Automated:** `npm test` → 36 files, **628 passed, 1 skipped**. `npm run e2e` → 11 files, **127 passed** (12 new in `atmosphere.test.ts`). Typecheck and lint clean. A stub AudioContext counts what would play, so the tests need no audio device.

| # | Check | Result | Evidence |
|---|---|---|---|
| V3-1 | Day/night from the local clock | **Pass** | unit: full day at noon, full night at midnight, smooth fades, never darker than the maximum, sunrise/sunset halfway, always-day/night ignore the clock, sky colours; browser: dimming measured on the canvas (night is darker than day) |
| V3-2 | Seasonal themes | **Pass** | unit: automatic dates (both ends of each range) and "chosen theme wins"; browser: each theme is applied and visibly changes the canvas |
| V3-3 | Sound is off by default and only real events play | **Pass** | no audio context is even created while off; with sound on, arrival and needs-you events play, silence with no events, volume 0 is silent; sounds are short, quiet (master gain capped at 0.2) and rate-limited |
| V3-4 | Preferences are safe and local | **Pass** | only known values are accepted (garbage, scripts, out-of-range numbers fall back); persist across reload; apply to the office at once |
| V3-5 | Settings control | **Pass** | choices in Settings change the office, survive a reload; no horizontal scroll at 360 px |
| V3-6 | Database recovery only for real corruption | **Pass** | unit: EPERM, EBUSY, SQLITE_BUSY, SQLITE_CANTOPEN and SQLITE_IOERR are retried then reported with the database byte-for-byte unchanged; a lock that clears opens the same database; corruption (by code or message) is still recovered |

## Not done / next

- **V4b (not approved):** approving or denying permission requests from the office. This needs a blocking hook and its own security design; I will explain it again before building anything.
- Sunrise and sunset are fixed times (no location); there is no moon phase or weather; seasonal decorations are drawn only in the walkable office (not the classic view).
- With true isometric rooms, robots avoiding each other, or more rooms like a garden or kitchen events, the office could go further. These are optional polish ideas, not planned.
