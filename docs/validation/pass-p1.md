# Pass P, checkpoint P1: agent roster and playbooks (2026-11-23)

**What it does:** a new **Agents** page lists the named working roles for Claude Code agents. Each has a fixed set of tools it may use, step-by-step instructions, and a review checklist. You can rename an agent and add house rules. Nothing about how agents behave changes yet: launching an agent with its role, and attributing its work, arrive in P2; reviews in P3.

| Area | Writer | Reviewer |
|---|---|---|
| Requirements | Ada (Requirements Analyst) | none |
| Manual test cases | Quinn (Test Case Writer) | Rhea (Test Case Reviewer) |
| Automation (Pass 3) | Axel | Vera |
| API tests (Pass 3) | Piper | Cole |
| Defects | Bram (Bug Investigator) | none yet (a person reviews defects) |
| Coordination | Lena (QA Lead) | none |

**Rules enforced:**
- The allowed tools of each role are fixed in code. The page and the API can change only the name and the house rules; a request carrying `tools` or `role` is refused.
- Names are unique, case-insensitively (service and a database unique index), because "a reviewer is not the writer" will be enforced by identity.
- Only a signed-in person can rename or reset an agent (service refuses the agent and system actors; the hook token, the agent token and a request without the session cookie are refused at the door).
- No role has any approve, reject, pass, close, complete, archive or delete capability; reviewers have no write tools; only the Test Case Writer writes cases.

**One schema change (additive):** migration `009` adds `playbooks` (id, agent name, house rules). The roster, tools, steps and checklists live in code (`packages/shared/src/playbooks.ts`) so they are version controlled and tested.

| # | Check | Result | Evidence |
|---|---|---|---|
| P1-1 | Roster shape: unique ids and names, writers paired with a same-area reviewer, reviewers never write, only reviewers hold review tools, no forbidden capability, fake-data rule on every role that touches test data | **Pass** | `packages/shared/test/playbooks.test.ts` (6 tests; it caught two reviewer roles missing the fake-data rule, now fixed) |
| P1-2 | Every allowed tool exists (or is planned for P3); rename, house rules, reset; uniqueness including default names and the database index; human only; tools/role cannot be edited | **Pass** | `apps/server/test/playbooks.test.ts` (6 tests) |
| P1-3 | In a real browser: roster and sidebar entry, writer/reviewer pairing, rename, duplicate refused, reset, token and cookie checks over HTTP, 360 px layout | **Pass** | `e2e/agents.test.ts` (4 tests; found tool names overflowing at 360 px, fixed) |

## Limits
- Informational for now: an agent connected today is still anonymous until P2.
- Automation and API roles are listed as "Arrives in Pass 3" and have read-only tools.
