# Pass 3, checkpoint A4: the Automation Writer (Axel) and Reviewer (Vera) (2026-11-25)

**Scope (agreed):** turn on the two automation agents using the existing playbook, run-identity and review machinery. **Not in A4:** running scripts, writing scripts into a project folder, an agent that decides anything, CI monitoring (A3), the API agents (Piper, Cole).

**What they do**
- **Axel (writer)** reads approved test cases and saves automation **script drafts** (title, framework, the test case it automates, the script text, notes) with `qa_create_automation_script`; it can revise only its own drafts (`qa_revise_automation_script`, with a reply to the reviewer) and list what was sent back (`qa_list_my_script_changes`).
- **Vera (reviewer)** lists drafts she did not write (`qa_list_scripts_to_review`), reads them (`qa_get_automation_script`) and records a recommendation (`qa_review_automation_script`): approve, or changes with required notes.
- **You** read the script in the Test Automation page (drawer), copy it into your project yourself if you want it, and approve or reject. A review changes nothing by itself.

**How the rules are enforced (service and database, not only the screen)**
- A script is **text kept in this app**. Nothing is run and nothing is written into the project folder; there is no tool for either.
- Only **approved** test cases can be automated. Only a **named, launched** writer can create or revise; the shared (unnamed) agent token cannot. A writer revises only its own draft, and only while it is a draft.
- **Reviewer is never the writer**: refused by the service (name or run) and by database triggers (migration 014); the reviewer must be the agent the run was launched as, on its own project. Reviews are append-only and become *outdated* when the script is revised (content fingerprint).
- **Approve/reject is human-only**: no agent tool exists, the route needs the signed-in cookie (agent token, run token, hook token refused), the service refuses non-humans, and a database CHECK refuses a decision not made by a human. A decided script is frozen by a trigger.
- Axel and Vera cannot use the manual test case tools (create/review) and the manual agents cannot use the script tools (service area checks and per-role tool lists). Handing an old draft to a writer now offers only manual-area writers.
- **Privacy:** script text, titles and notes are masked by the redaction engine on the way in (secrets, tokens, e-mails) and again on the way out to agents; the writer is told when text was masked and to use environment variables instead.

| # | Check | Result | Evidence |
|---|---|---|---|
| A4-1 | Draft created for an approved test case, attributed to Axel; unapproved or unknown case refused; shared token refused; bad framework refused | Pass | `apps/server/test/qa-scripts.test.ts` |
| A4-2 | Secrets and e-mails masked, writer told | Pass | same |
| A4-3 | Role matrix: manual agents cannot use script tools, script agents cannot use manual tools, writer cannot review, reviewer cannot write | Pass | same |
| A4-4 | No approve/decide/run tool exists; agent, run, hook token and cookie-less request refused on the decision route; service refuses agent | Pass | same |
| A4-5 | Review recorded, status stays draft; changes need notes; revision makes it outdated and returns it to the reviewer with the writer's reply | Pass | same |
| A4-6 | Own-work and identity refused by service and by triggers; reviews append-only | Pass | same |
| A4-7 | Person approves/rejects (reject needs a reason); decided script frozen; database refuses a non-human decision; project with scripts cannot be removed | Pass | same |
| A4-8 | Page: list, drawer with text and review, approve, reject, Team page shows Axel and Vera runnable with their own tools, 360 px | Pass | `e2e/automation-scripts.test.ts` |

**Not verified:** a live Claude Code session actually running Axel and Vera (the tool calls were exercised through the same HTTP surface the MCP server uses, not a real model); the quality of the scripts real agents write; scripts for frameworks other than the listed ones (they use `other`).
