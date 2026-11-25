# UI redesign: Team page character manager (2026-11-25)

**Scope:** presentation of the Team page only. No backend, schema, event, security or privacy change. Names, house rules, reset, Run this playbook and the robot look editor are the same controls with the same server rules (tools can never be edited; only the signed-in person can change an agent).

- **Roster** (left, grouped by area): one tile per agent with its robot, name, role and kind. Pass-3 agents are dimmed. Pick a tile to see its details. On narrow screens the roster sits above the details.
- **Character detail** (right): a large robot preview with a **Preview animation** selector (any status, labelled as a look-only preview; it never changes live state, the roster tile or the office), live state from real sessions only, purpose, reviewer, tools, playbook steps, checklist, look and colours, name, house rules, run.
- Ordinary sessions' robots ("Other sessions") and Recent runs are unchanged, below.

| Check | Evidence |
|---|---|
| 9 roster tiles, one detail panel; tools differ between writer and reviewer; Pass 3 marked | `e2e/agents.test.ts` |
| Preview animation changes only the preview, never the live state | same |
| Rename, duplicate refused, reset, human-only guards, run and stop, live state, robot look, no sideways scroll at 360 px | same (selectors now pick the agent from the roster first) |
