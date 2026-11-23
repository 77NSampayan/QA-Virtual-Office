# The team in the office, and retiring old robots (2026-11-23)

**What it does:** the office has a new **QA Team** room next to the lobby with **one desk and a name plate per agent role** (Ada, Quinn, Rhea, Axel, Vera, Piper, Cole, Bram, Lena; the Pass 3 roles are marked "later"). When you run an agent, its robot sits at its own desk, whichever project it works on. Names follow renames live.

**It keeps the rule that robots show only real events:**
- A desk and its name plate are furniture. They claim no activity and invent no robot: an agent that is not running has an empty, dimmed desk.
- An agent's robot exists only because a real session sends events. It behaves like every other robot: working goes to its desk, finished or idle goes to the lounge (the desk stays its own), failures stay at the desk, a disconnected robot stays at its desk, dim. Nothing moves without an event.
- Plain sessions (no playbook) still go to their project's room, never the team room.
- If the same agent runs on two projects at once, the second robot takes a free desk instead of sharing.

**Retire an old robot** (Team page, "Other sessions", a **Retire this robot** button): hides a robot you no longer want. Nothing is deleted (its sessions keep their history). It is refused while the robot had an event in the last 10 minutes, for agents' robots, and for anyone but you. It returns by itself if its session sends a new event, and a retired robot is never reused for a new session.

Hidden lists mirror the desks for assistive tech and tests: `[data-office-team]` (state per desk: `empty`, `at-desk`, `away`, `later`).

| # | Check | Result | Evidence |
|---|---|---|---|
| T-1 | A fixed desk per agent in any arrival order; empty desks stay empty; rests in the lounge and returns to the same desk; no movement without an event; a taken desk falls back to a free one; ordinary robots unaffected | **Pass** | `apps/web/test/office.test.ts` (5 new tests) |
| T-2 | In a browser: nine desks and plates, none occupied before anything runs, "later" roles marked; a running agent sits at its desk in the team room; rests and returns; a second agent; plain sessions in their project room; rename follows live; a disconnected agent stays at its desk | **Pass** | `e2e/team-office.test.ts` |
| T-3 | Retire: refused while recently active, hidden afterwards with history kept, returns when active again, never reused, human only, never for an agent's robot | **Pass** | `apps/server/test/robot-retire.test.ts`, `e2e/team-office.test.ts` |
| T-4 | It looks right (screenshots of the empty team room and with Quinn seated) | **Pass** | `QAVO_E2E_SHOTS=... npm run e2e` writes `team-room-empty.png`, `team-room-quinn.png` |

## Limits
- The team room has one spare desk (the layout makes pairs of desks) and no name plate for it.
- Desks are per role, not per project: an agent working on two projects shows one robot at its desk per project (the second takes a free desk).
- One schema change (additive): migration `012` adds `robots.retired`.

## Found in real use: the installed hook was out of date

A real Quinn run showed up as `Unit-06` instead of at her desk. The hook script installed on the machine (copied before run ids existed) did not send the run id, so the app could not tell the session came from an agent. Everything else worked (the run, the tools, the attribution), because those do not depend on that script.

- The fix is to press **Reinstall hooks** in Settings (the app already showed "forwarder outdated"; it is easy to miss). A backup of Claude's settings is made first and the hook entries are unchanged: only the script file in the data folder is replaced. It applies to the next hook call, with no restart of Claude Code.
- The **Team page** now shows a clear warning whenever the installed hook is outdated and hooks are installed, with a link to Settings (`e2e/team-office.test.ts`: absent when up to date, shown when outdated, gone after reinstall).
- Nothing updates the installed script silently: it is a program run from your Claude settings, so replacing it stays your action.
