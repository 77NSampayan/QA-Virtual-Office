# Pass V, checkpoint V4b: approve or deny permission requests from the office (2026-11-23)

**What it does:** when Claude Code in a **registered project** asks permission to use a tool, the request appears in the office (above the floor, in the Control Room, and in the robot's details card) with **Allow once** and **Deny**. Your click is relayed to Claude Code, which then continues or is told no. This is optional and off until you install a hook **and** turn the bridge on (Settings → "Approve permissions from the office").

**The rule that matters most: it never decides anything by itself.** The hook prints a decision only after the server reports that *you* allowed or denied. If the app is closed, the project is not registered, the bridge is off, you do not answer within about 110 seconds, you answer in the terminal instead, or anything goes wrong, the hook prints **nothing** and exits 0, which (per Claude Code's documentation) leaves its normal permission prompt exactly as it would have been.

**You never approve what you cannot see.** *Allow* is only offered when tool-input capture is on, so the request can show what it wants to do: a redacted, truncated, path-masked summary (a command on one line; for file tools only "edit/write/read" and a project-relative path; for other tools only the field *names*; never file contents, never a user name). With capture off the request arrives without details and you can only **deny** it or answer in the terminal.

**Privacy:** the summary is built locally by the hook, redacted again by the server, shown only while the request is open, and **erased as soon as it is answered or expires**. Afterwards only the tool name, project and result are kept (for one week). No command or path is ever logged.

**Automated:** `npm test` → 39 files, **682 passed, 1 skipped**. `npm run e2e` → 12 files, **142 passed** (15 new in `permission.test.ts`, which runs the **real built hook script** as a child process against the real server, with a real browser answering). Typecheck and lint clean.

| # | Check | Result | Evidence |
|---|---|---|---|
| V4b-1 | The hook never decides by itself | **Pass** | unit and end-to-end: with the bridge off, no policy, an unregistered or excluded folder, a non-permission event, invalid input, no token, a refusing or unreachable server, an expired request, or no answer, stdout is empty and the exit code is 0; it contacts nobody when it is not allowed to |
| V4b-2 | It relays only a person's decision, in the documented format | **Pass** | `{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}` and `{... "behavior":"deny","message":"Denied from QA Virtual Office","interrupt":false}`; allow carries no updated input and no permanent rules |
| V4b-3 | Only the signed-in person can decide | **Pass** | server tests: the hook token, the agent token, a request without the session cookie, without the CSRF header, or with a forged cookie are all refused; agents and the system actor are refused in the service; the database refuses an allowed/denied row not decided by a human, and a decision cannot be flipped |
| V4b-4 | Allow needs the details | **Pass** | `422 details_hidden` for a request without a summary; the button is disabled and says why; Deny still works (browser test) |
| V4b-5 | Decisions are final and short-lived | **Pass** | second answer refused; expired requests cannot be answered; the summary is erased on answer/expiry (checked in the database); answered requests are forgotten after a week |
| V4b-6 | Answered in the terminal | **Pass** | when the same tool finishes, the turn ends or the session ends, the waiting request expires and its card disappears; subagent events and other sessions never expire anything; the script prints nothing |
| V4b-7 | Safe installation | **Pass** | dry-run plan with the warning, acknowledgement required, timestamped backup, atomic write with a concurrent-edit check, refuses invalid JSON, adds ONE entry (synchronous, `PermissionRequest` only, `timeout` 130, exec form with the absolute node path) and leaves the user's own hooks and the status hooks untouched; uninstall restores the file exactly; refused in demo mode |
| V4b-8 | Clean exit | **Pass** | the end-to-end test found that the script crashed on exit on Windows (exit code 3221226505) when it talked to the real server; fixed (connections closed, no `process.exit`, the last wait bounded); every end-to-end run now asserts exit code 0 |
| V4b-9 | Bounded waiting | **Pass** | the script waits at most 115 s (the policy asks for 110 s, the installer gives Claude Code a 130 s limit, a hard stop at 125 s), and long-polls the server in 20 s steps |

## What is NOT verified, and what to check yourself

I could not run a live Claude Code session against this. The documentation I consulted leaves these points undocumented, so please test them once with a real session:
1. **That Claude Code actually proceeds on our allow reply and stops on our deny reply** (the format is the documented one, and the script is tested against it, but not against Claude Code itself).
2. **What Claude Code does if the hook is still waiting when its timeout hits** (our script finishes earlier, so this should not happen).
3. **How our hook combines with another PermissionRequest hook you may have** (documented only as "run in parallel"; precedence between an allow and a deny is not documented). We never decide unless you click, but another hook could.
4. **Non-interactive (`-p`) sessions:** the documentation says an unanswered request is denied there; we make no decision in that case.

**A suggested live test:** install the hook and turn the bridge on; in a registered project run `claude` and ask it to run a command that needs permission; answer in the office; try Deny, then try ignoring it (after about 110 seconds Claude Code should ask in the terminal), and try answering in the terminal first. `Settings → Remove the permission hook` undoes everything.

## Limits

- The hook runs for sessions in every folder (user-level settings) but only acts for registered projects; it adds a few milliseconds of start-up to each permission request even when it ignores it.
- Only "allow once": there is deliberately no "always allow" (no permanent rules are ever written).
- Not available in demo mode (it never changes your Claude settings).
- A request for a tool with details hidden cannot be approved here by design.
