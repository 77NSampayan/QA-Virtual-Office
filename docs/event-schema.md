# Agent Event Schema and Status Transitions

## Sanitized event (`packages/shared/src/events.ts`)

This is the only shape that leaves the hook process. It is validated with a strict zod schema on both ends.

```ts
{
  v: 1, eventId: uuid, ts: ISO-8601, sessionId,
  event: HookEventName | 'other', rawEventName?,        // 'other' + safe name for unknown events
  projectId: string | null, folderKeys: string[],       // resolved locally; never a path
  permissionMode?, toolName?, toolUseId?, durationMs?, isInterrupt?,
  agentId?, agentType?, notificationType?, source?, model?, reason?, error?,
  stopHookActive?, backgroundTasksRunning?,
  fileCategory?: 'test'|'source'|'doc'|'config'|'other',
  commandCategory?: 'test_run'|'build'|'git'|'install'|'other',
  content?: { prompt?, toolInput?, toolResponse?, notificationText? }   // explicit opt-in only, redacted
}
```

**Installed hook events** (async command hooks): SessionStart, SessionEnd, UserPromptSubmit, PreToolUse, PostToolUse, PostToolUseFailure, PermissionRequest, Notification, Stop, StopFailure, SubagentStart, SubagentStop.

## Robot statuses

| Status | Meaning |
|---|---|
| `idle` | |
| `analyzing` | |
| `writing_tests` | |
| `executing_tests` | |
| `debugging` | |
| `awaiting_permission` | |
| `awaiting_input` | |
| `completed` | |
| `failed` | |
| `disconnected` | |

Each status carries a source:
- **`event`** means the hook event itself stated it.
- **`inferred`** means it was interpreted from tool activity. The UI marks these with "~".

**Activity(tool)** is the status derived from a tool event:
- `commandCategory = test_run` → `executing_tests`
- Write/Edit/MultiEdit/NotebookEdit with `fileCategory = test` → `writing_tests`
- otherwise, while `turnFailed` is set → `debugging`
- otherwise → `analyzing`

**`turnFailed`:**
- set by PostToolUseFailure;
- cleared by a successful `test_run` PostToolUse, by Stop, by UserPromptSubmit, and by an interrupt.

## Transition matrix (`packages/shared/src/statusMachine.ts`)

Every transition records its row number in `agent_events.rule`. Each row has its own test in `packages/shared/test/statusMachine.test.ts`; row 32 is tested in the server collector tests.

| # | Event (main session) | Condition | New status | src | Side effects |
|---|---|---|---|---|---|
| 1 | SessionStart | `startup`/`clear` | idle | E | create/attach session + robot; clear flags |
| 2a | SessionStart | `resume`, known session | idle | E | keep the existing session and robot |
| 2b | SessionStart | `fork` | idle | E | new session + new robot (`origin=fork`); parent link only if the payload carries one |
| 2c | SessionStart | `resume`, unseen session | idle | E | new session + robot, `origin=resume_unlinked` |
| 3 | SessionStart | `compact` | unchanged (idle if disconnected) | E | — |
| 4 | UserPromptSubmit | — | analyzing | I | clear turnFailed + awaiting flags |
| 5 | PreToolUse | — | Activity(tool) | I | clear awaiting flags |
| 6 | PostToolUse | was awaiting_permission | Activity(tool) | I | clear awaiting flag |
| 7 | PostToolUse | `test_run` | analyzing | I | clear turnFailed |
| 8 | PostToolUse | otherwise | unchanged | — | — |
| 9 | PostToolUseFailure | `is_interrupt` | idle | E | clear turnFailed, awaitingPermission, awaitingInput, pending tool, awaitingFromAgent |
| 10 | PostToolUseFailure | otherwise | debugging | I | set turnFailed |
| 11 | PermissionRequest | — | awaiting_permission | E | high-priority notification (tool name only) |
| 12 | Notification `permission_prompt` | — | awaiting_permission | E | at most one notification per unresolved permission episode, with #11 in either order (no time window: real sessions send this ~6 s after #11) |
| 13 | Notification `elicitation_dialog` / `elicitation_url_dialog` / `agent_needs_input` | — | awaiting_input | E | high-priority notification |
| 14 | Notification `idle_prompt` | — | awaiting_input | E | low-priority notification |
| 15 | Notification `elicitation_complete` / `elicitation_response` | — | analyzing | I | clear awaiting flag |
| 16 | Notification `agent_completed` | — | unchanged | — | info notification |
| 17 | Notification `auth_storage_failure` | — | unchanged | — | warning notification |
| 18 | Notification (any other type) | — | unchanged | — | logged only |
| 19 | Stop | — | completed | E | clear flags; low-priority notification; background-task count |
| 20 | StopFailure | — | failed | E | high-priority notification with the error enum |
| 21 | SubagentStart | — | parent unchanged | E | create a drone (not created for internal agents with an empty `agent_type`) |
| 22 | SubagentStop | — | parent unchanged | E | drone → completed, removed after 60 s |
| 23 | SessionEnd | — | disconnected | E | set `ended_at`; drones removed |

**Events from inside a subagent.** These rows apply when `agent_id` matches a drone created by SubagentStart. Any other `agent_id` (for example in `--agent` sessions) is handled as a main-session event.

| # | Event | Behaviour |
|---|---|---|
| 24 | PreToolUse / PostToolUse / PostToolUseFailure | Rules 5–10 apply to the **drone**; the parent is unchanged. |
| 25 | PermissionRequest / Notification #11–14 | The drone **and** the parent go to `awaiting_*`. This clears when that drone continues or stops. |
| 26 | Stop | Same as #22. |

**Timers and edge cases:**

| # | Case | Behaviour |
|---|---|---|
| 27 | completed with no events for 10 minutes | → idle (I) |
| 28 | Silence in any other status | No change. The UI shows "last seen". Disconnected is never inferred. |
| 29 | First event for an unknown session | Create the session (`start_observed=false`), then apply the row. |
| 30 | Event after SessionEnd (other than SessionStart) | Apply the row and clear `ended_at`. |
| 31 | Unknown event | Stored as `other`; status unchanged. |
| 32 | Duplicate event (same `eventId`) | Ignored. |
