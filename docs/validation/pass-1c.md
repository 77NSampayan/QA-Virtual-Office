# Pass 1C: Validation Results (2026-11-22)

**What 1C delivers:** the virtual QA office. Code-drawn pixel robots (7 types × 10 animated statuses, workstations, subagent drones), an app shell with navigation, Office Overview, Project Rooms, QA Control Room, Robots customization, Notification center and a responsive layout.

**Environment:** Windows 11, Node 24.18, Microsoft Edge (headless) via playwright-core.

**Automated:** `npm test` → 16 files, **332 passed, 1 skipped** (the symlink-privilege skip from 1A). `npm run e2e` → **20 passed** (5 from 1B + 15 new). `npm run typecheck` and `npm run lint` clean.

| # | Criterion | Result | Evidence |
|---|---|---|---|
| C1 | Every status renders its specified animation and colour (visual snapshot tests) | **Pass** | `apps/web/test/sprites.test.ts` (40 tests) measures **actual pixels** of the sprite grids: each status shows its colour on the face LEDs and chest light; idle blinks; analyzing sweeps its eyes and a scan line travels down a held document; writing alternates its hands while text grows on the screen; executing moves a lever and fills a progress bar; debugging moves a magnifier and a jumping error line; awaiting-permission raises a waving hand and flashes a beacon (out of phase); awaiting-input shows a question bubble; completed raises both arms, hops and throws sparkles; failed shows X eyes and sparks; disconnected is powered off (dark face, no bright colour anywhere, standby light fading). A committed snapshot of **every** robot, workstation and drone frame (7 types × 10 statuses × 4 frames) fails on any accidental visual change. *In a real browser* (`e2e/c-office.test.ts`) the canvas pixels of the on-screen robot and its workstation were read back for all 10 statuses and contain the status colour (and none of the bright colours when disconnected). Screenshots were reviewed by eye |
| C2 | Robots reflect real events only; no client-side random activity | **Pass** | Code check: no `Math.random`, clock or `Date` in any sprite file (test). Browser: a session was driven through all 10 statuses purely by real events and the on-screen robot, pill and canvas followed each one; with no new events the status never changed over 12 samples while the animation frame kept advancing; every robot on screen maps to a real session and robot record (no invented robots); "~" marks inferred statuses, none on event-stated ones; a drone appears only after a real `SubagentStart`. Previews on the Robots page and sprite gallery are explicitly labelled as not real |
| C3 | Robot customizations survive a restart | **Pass** | Server test: name, appearance, role and colours are validated, saved, and still there after the database is closed and reopened; the same robot is reused by the next session. Browser: edit on the Robots page → server has it → floor shows the new name, look and colour after a page reload |
| C4 | Layout works at 360 px with no horizontal scroll | **Pass** | Browser at 360×740: all 15 routes checked, `scrollWidth ≤ 360`; the floor is replaced by compact status cards, the sidebar becomes a menu drawer |
| C5 | No KPI renders without a real data source | **Pass** | Browser: with an empty office the real KPIs show real zeros and each has a "how calculated" text; Passed/Failed/Blocked tests, Pending test cases and Open defects show **"No data yet"** (no number) with the pass that delivers them. Project room and Control Room show "No data yet" panels for unbuilt modules. Unbuilt modules say "Arrives in Pass N" and show nothing simulated. Coverage-style figures are not shown without a denominator |

## Screens delivered

| Screen | Content (all from real data) |
|---|---|
| Overview | 13 KPI tiles (8 real, 5 explicit no-data), current workload bars, Manual QA / Automation / Control Desk floors with robots at their workstations |
| Project Rooms | Cards per project; a room view with that project's robots, summary, activity feed, no-data panels, settings (edit/remove) |
| QA Control Room | Attention queue (with the tool awaiting permission), live agents, usage from the status line, integration health, activity feed |
| Robots | Name, appearance, logical role, colours, animation preview (labelled), live state |
| Notifications | All / unread / high priority, mark read / unread / all, unread badge in the nav and the tab title shows the attention count |
| Sessions, Settings | The 1A/1B detail views, now inside the shell |
| Sprite gallery | Reference sheet of all statuses, types and drones |

## Server additions

`GET /api/robots`, `PATCH /api/robots/:id` (all-or-nothing validation), `GET /api/activity` (metadata only, optional project filter), `GET /api/projects/:id/room`, `POST /api/notifications/read`, `GET /api/notifications/unread-count`. Seven tests; no folder path appears in any of these responses.

## Defects found and fixed during 1C validation

1. **Save confirmation vanished.** The Robots editor was rebuilt on save (its React key included the editable fields), so the "Saved" message disappeared instantly. Fixed: stable key, and the form resyncs when the saved robot changes.
2. **360 px overflow.** The Robots page overflowed by 3 px because long `select` options widened the column. Fixed.
3. **Sprites looked black.** Black outlines plus the dark face screen swallowed the head. Fixed by tinting outlines from the robot's own body colour; the snapshot guard flagged exactly this intended change.
4. **Animation weakness.** The permission robot's hand wave and light flash changed on the same frames (2 distinct frames). Now out of phase (4 distinct frames).
5. Several of my own test probes were wrong (they measured the head instead of the arm); fixed, with the real behaviour unchanged.

## Not done / open

- **Robots only change the department when you change their role.** New robots default to the QA Analyst role (Manual QA); nothing guesses a role.
- **The live office has not been looked at by you yet:** the screenshots come from synthetic events in an isolated test database. Run `npm run launch` to see your real robots.
- OS notifications, tray and sound arrive in 1D.
