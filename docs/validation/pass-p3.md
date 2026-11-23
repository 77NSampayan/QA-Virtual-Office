# Pass P, checkpoint P3: reviews by a different agent (2026-11-23)

**What it does:** a launched **Reviewer** agent (Rhea) can review draft test cases written by someone else and record a **recommendation**: recommend approval, or request changes with notes. Two new tools: `qa_list_my_reviewable` (the drafts it may review) and `qa_review_test_case`. In the app, each test case shows its latest review (in the list and in full in the detail), and the list has a **Review** filter (recommends approval, requests changes, outdated, not reviewed).

**A review is advice, never a decision.** It does not change the test case's status, does not approve or reject anything, and is not a gate: you can approve a case the reviewer wanted changed, or reject one it recommended. Approval stays human-only.

**A reviewer is never the writer, enforced three times:**
1. **Tools:** only reviewer roles have the review tools (the shared, unattributed token has none that works).
2. **Service:** the review is refused if the draft came from the same run or has the same agent name (case-insensitive), if the project differs, or if the case is archived, approved or rejected.
3. **Database:** triggers on `agent_reviews` refuse a review whose reviewer is not the launched agent of that run on that project, or whose run or name matches the case's drafter. Reviews are append-only. A direct SQL insert cannot get around it (tested).

Agent **names are a history, not just a setting**: each draft keeps the name of the agent that drafted it. Renaming agents later cannot turn a reviewer into the writer of an old draft (tested: the reviewer renamed to the writer's old name is still refused).

**Outdated reviews:** a review records a fingerprint of what was reviewed (title, scenario, description, preconditions, steps, test data, expected result). If the writer edits the case afterwards, the review is shown as **outdated** and the case returns to the reviewer's list ("edited since review"). The writer reads the reviewer's notes with `qa_get_test_case` and fixes them with `qa_update_test_case_draft`.

**Privacy:** review notes are redacted on input, capped at 2000 characters, shown as plain text, and the activity log still records only the agent name, tool, project and outcome (never the notes).

**One more fix found by the browser test:** what an agent writes (a draft, an edit, a review) did not refresh an open page; it now does, like anything a person does.

| # | Check | Result | Evidence |
|---|---|---|---|
| P3-1 | Rhea lists what she may review, records a recommendation, status unchanged, audit names the agent | **Pass** | `apps/server/test/qa-review.test.ts` |
| P3-2 | A person can still approve or ignore; approved cases need no review; reviews on archived/approved cases refused | **Pass** | same file |
| P3-3 | Writer sees the notes; an edit makes the review outdated and returns it to the reviewer; the latest review counts, all are kept; list filter | **Pass** | same file |
| P3-4 | Refused for the shared token, a writer, analyst, lead, investigator, another project, own run, own name (even via the service), and after a rename | **Pass** | same file |
| P3-5 | The database refuses direct inserts that break identity, own-work, verdict, notes, hash and subject rules; reviews are append-only | **Pass** | same file |
| P3-6 | Notes: redacted, capped, required for changes, invalid verdicts and extra fields refused, nothing stored on failure | **Pass** | same file |
| P3-7 | The real MCP bundle over stdio: Rhea reviews Quinn's draft, Quinn has no review tool, the writer reads the notes | **Pass** | `apps/server/test/mcp-playbook-e2e.test.ts` |
| P3-8 | In a browser: label, detail, filter, outdated, only the person approves, 360 px | **Pass** | `e2e/reviews.test.ts` (found the missing live refresh) |

## P3b: the writer answers the reviewer

- **`qa_list_my_changes_requested`** (writer agents only): Quinn's own drafts that are still drafts and whose latest, current review asks for changes, with the reviewer's notes. Fixing one (an edit) makes the review outdated, so it leaves the list until a reviewer looks again.
- **`replyToReviewer`** on `qa_update_test_case_draft`: the writer's answer to the latest review (what changed, or why something did not). It is saved in the case's append-only history with the agent's name, redacted and capped at 1000 characters, and can be sent with an edit or on its own. A reply is not an edit: it does not outdate the review. A reply with no review to answer is refused.
- **The reviewer sees it:** in `qa_get_test_case` (`replies`), as `writerReply` in her `qa_list_my_reviewable` list, and you see it under the review in the app ("Quinn (writer agent) replied …"). A new review closes the conversation: earlier replies belong to the earlier review.
- Still true: a writer can edit only its own drafts, and only while they are drafts; once you move a case to In review it can no longer be edited by an agent. A named reviewer can never use the writer's tools.

| # | Check | Result | Evidence |
|---|---|---|---|
| P3b-1 | Quinn lists only her own sent-back drafts with notes; leaves the list after an edit; only launched writers may use it | **Pass** | `apps/server/test/qa-review.test.ts` (new "the writer answers the reviewer" group, 6 tests) |
| P3b-2 | Reply saved with her name, shown to the reviewer, closed by a new review; a reply alone does not outdate; no-review and empty calls refused | **Pass** | same file |
| P3b-3 | Replies redacted, capped, append-only, drafter only; no edits after a person moved the case on | **Pass** | same file |
| P3b-4 | The reply is shown in the app under the review | **Pass** | `e2e/reviews.test.ts` |

## P3c: handing old, unnamed drafts to a writer (found in real use)

**What happened:** Rhea sent back two drafts that were written before agents had names. Quinn's list correctly excluded them (they were not hers) and she could not edit them, so she wrote nine new drafts instead of fixing the two.

**The fix (your decision):**
- A **Hand to Quinn** button in the test case, shown only for agent drafts with no drafter, still in Draft. Only you can press it. It records Quinn as the drafter (history: "Handed to Quinn", actor human). Content is unchanged, so the review stays valid.
- Refused for: reviewer or analyst roles, person-written cases, cases that already have a drafter, archived, in-review, approved cases, and **any writer whose name has reviewed that case** (names are history).
- `qa_list_my_changes_requested` now also reports `notYours` and a note: "N other drafts need changes; do not recreate them; ask the person to hand them to you". Quinn's playbook says the same.

| # | Check | Result | Evidence |
|---|---|---|---|
| P3c-1 | Without a hand-over Quinn is told and cannot edit; after it she lists, fixes and answers; the review stays valid until she edits | **Pass** | `apps/server/test/qa-review.test.ts` ("handing an old, unnamed agent draft…", 6 tests) |
| P3c-2 | Only a person; refused for the safe-list above; never makes a reviewer its writer | **Pass** | same file |
| P3c-3 | The button in the app, then Quinn's edit and reply | **Pass** | `e2e/reviews.test.ts` |

**To use it now:** open TC-0009 and TC-0011 in Manual QA, press **Hand to Quinn**, then run Quinn again. Do not also ask her to write new cases for them.

## Limits
- Reviews cover manual test cases only. Automation scripts and API tests (Pass 3) will reuse the same table; defect review is not built (Bram's work is reviewed by a person).
- No review is required before approval (your choice to add a rule such as "approve only reviewed cases" later).
- The reviewing agent is trusted to read carefully; the server only guarantees who wrote and who reviewed.
