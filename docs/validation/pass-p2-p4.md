# Pass P, checkpoints P2 and P4: launching named agents, their identity, and their robots (2026-11-23)

**What it does:** on the **Agents** page, **Run this playbook** (pick a project) opens Claude Code in that project's folder as a named agent (for example Quinn, the Test Case Writer). The agent:
- uses only the tools of its role, on that one project, for 8 hours;
- is given its playbook (steps, checklist, and your house rules) as its instructions;
- is recorded as the drafter of what it writes ("drafted by Quinn" on the test case, and the agent's name in the activity log);
- appears in the office as its own robot, named and styled from the agent, instead of `Unit-NN`.

**How the identity is enforced (not just asked for in a prompt):**
- Pressing Run creates a **run**: a random credential bound to the playbook, the agent's name at that moment and one project. Only its **SHA-256 hash** is stored. The credential is written once to a per-run MCP config file in the data folder (current-user ACL) and is never returned by any API.
- Claude Code is started with fixed arguments: `claude --mcp-config <that file> --strict-mcp-config "Follow your QA Virtual Office playbook."`, and the run id in the environment. No project name or other user text is in the command.
- The server resolves the credential on every call. A revoked, expired, unknown or malformed credential is refused, and never falls back to the shared agent token. The shared token still works as before but is **unattributed** (it sees all tools, drafts carry no name).
- Per call the server checks: the tool is in the role's allow-list; the project is the run's project. Everything else (human-only rules) is unchanged.
- **Stop** (on the Agents page) revokes the run at once and deletes its credential file; stale files of finished runs are removed on the next launch.
- A person launches and stops runs. An agent, the hook token and the shared token cannot.

**The office link (P4):** the hook forwarder adds the run id (`QAVO_RUN_ID`, a random id such as `run_0123...`, validated, never content) to the events of that session. The server uses it only if the run is real, active and for the same project; then the session's robot is that agent's own robot (one per agent per project, never given to an ordinary session, name follows the agent's current name).

| # | Check | Result | Evidence |
|---|---|---|---|
| P2-1 | Launch mints a run, stores only a hash, writes a private config, starts Claude with fixed arguments; refused without confirmation, with agent access off, for unknown or unavailable playbooks, for non-text input | **Pass** | `apps/server/test/playbook-runs.test.ts` |
| P2-2 | A named agent sees only its role's tools; others are refused (`tool_not_allowed`) and audited with the agent's name and no content; locked to its project | **Pass** | same file; `apps/server/test/mcp-playbook-e2e.test.ts` (the real MCP bundle, environment taken from the per-run config, no shared token available) |
| P2-3 | Drafts carry who wrote them; a named agent edits only its own drafts; a later rename does not rewrite history; nothing can be approved | **Pass** | same files |
| P2-4 | Expired, revoked, unknown, malformed credentials are refused with no fallback; a run credential cannot reach the person's API; agents/hook/shared token cannot start or stop runs | **Pass** | same file |
| P2-5 | The agent's playbook (with the person's house rules, no folder paths) becomes its instructions; the shared token and failures keep the generic ones | **Pass** | `playbook-runs.test.ts`, `apps/mcp/test/protocol.test.ts` |
| P4-1 | Forwarder adds a valid run id and ignores malformed ones; nothing else about the run is sent | **Pass** | `apps/forwarder/test/forwarder.test.ts` |
| P4-2 | Robot named/styled from the agent, reused, never in the ordinary pool, follows renames; unknown, revoked, expired or wrong-project run ids are ignored; malformed run id rejected at the door | **Pass** | `playbook-runs.test.ts` |
| P2/P4-6 | Browser: Run button (disabled until a project is chosen; none for unavailable roles), run list, Stop, "drafted by" label, Quinn robot on the Team page | **Pass** | `e2e/agents.test.ts` (found that a renamed robot kept its old name in the live view; fixed) |

## NOT verified (I cannot run a live Claude Code here), please test once
1. That `claude --mcp-config <file> --strict-mcp-config "<sentence>"` starts as intended from the console that opens (quoting of the config path, which contains a space, goes through `cmd.exe /k`). If the console shows an error, tell me what it prints.
2. That Claude Code honours the server's `instructions` field as the agent's guidance (the tools and rules are enforced by the server either way).
3. That the run id in the environment reaches the hooks, so the robot is renamed (it should: hooks run as children of Claude Code).
4. `--strict-mcp-config` means that session loads **only** this config: your other MCP servers are not available in a playbook session (intended: least privilege). Your hooks and settings still apply.

## Limits
- Two runs of the same agent on the same project at the same time share one robot.
- Reviews (a reviewer recommending approval or changes, never the writer) arrived in P3: see pass-p3.md.
- Not available in demo mode.
