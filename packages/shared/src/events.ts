/**
 * Sanitized agent event schema (browser-safe). This is the ONLY shape that ever leaves the
 * hook process. See docs/event-schema.md.
 */
import { z } from 'zod';

export const HOOK_EVENTS = [
  'SessionStart',
  'SessionEnd',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'PermissionRequest',
  'Notification',
  'Stop',
  'StopFailure',
  'SubagentStart',
  'SubagentStop',
] as const;
export type HookEventName = (typeof HOOK_EVENTS)[number];

export const PERMISSION_MODES = [
  'default',
  'plan',
  'acceptEdits',
  'auto',
  'dontAsk',
  'bypassPermissions',
] as const;

export const SESSION_START_SOURCES = ['startup', 'resume', 'clear', 'compact', 'fork'] as const;

export const STOP_FAILURE_ERRORS = [
  'rate_limit',
  'authentication_failed',
  'oauth_org_not_allowed',
  'account_on_hold',
  'billing_error',
  'invalid_request',
  'model_not_found',
  'server_error',
  'max_output_tokens',
  'cloud_credential_error',
  'unknown',
] as const;

export const FILE_CATEGORIES = ['test', 'source', 'doc', 'config', 'other'] as const;
export type FileCategory = (typeof FILE_CATEGORIES)[number];
export const COMMAND_CATEGORIES = ['test_run', 'build', 'git', 'install', 'other'] as const;
export type CommandCategory = (typeof COMMAND_CATEGORIES)[number];

export const WRITE_TOOLS = ['Write', 'Edit', 'MultiEdit', 'NotebookEdit'] as const;

/** Conservative identifier patterns — anything else is dropped or replaced. */
export const ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
export const TOOL_NAME_RE = /^[A-Za-z0-9_.:-]{1,128}$/;
export const SAFE_TOKEN_RE = /^[a-z0-9_]{1,64}$/;
export const MODEL_RE = /^[A-Za-z0-9_.:/[\] -]{1,100}$/;
export const FOLDER_KEY_RE = /^[a-f0-9]{8}:[a-f0-9]{32}$/;

const optStr = (re: RegExp) => z.string().regex(re).optional();

export const OptInContentSchema = z
  .object({
    prompt: z.string().max(4000).optional(),
    toolInput: z.string().max(4000).optional(),
    toolResponse: z.string().max(4000).optional(),
    notificationText: z.string().max(4000).optional(),
  })
  .strict();
export type OptInContent = z.infer<typeof OptInContentSchema>;

export const SanitizedEventSchema = z
  .object({
    v: z.literal(1),
    eventId: z.string().uuid(),
    ts: z.string().datetime(),
    sessionId: z.string().regex(ID_RE),
    event: z.union([z.enum(HOOK_EVENTS), z.literal('other')]),
    rawEventName: z
      .string()
      .regex(/^[A-Za-z]{1,40}$/)
      .optional(),
    projectId: z.string().regex(ID_RE).nullable(),
    folderKeys: z.array(z.string().regex(FOLDER_KEY_RE)).max(18),
    permissionMode: z.enum(PERMISSION_MODES).optional(),
    toolName: optStr(TOOL_NAME_RE),
    toolUseId: optStr(ID_RE),
    durationMs: z.number().int().nonnegative().max(86_400_000).optional(),
    isInterrupt: z.boolean().optional(),
    agentId: optStr(ID_RE),
    agentType: z
      .string()
      .regex(/^[A-Za-z0-9_.:-]{0,128}$/)
      .optional(),
    notificationType: optStr(SAFE_TOKEN_RE),
    source: z.union([z.enum(SESSION_START_SOURCES), z.literal('other')]).optional(),
    model: optStr(MODEL_RE),
    reason: optStr(SAFE_TOKEN_RE),
    error: z
      .string()
      .regex(/^(Exit code \d{1,6}|tool_error|[a-z_]{1,40})$/)
      .optional(),
    stopHookActive: z.boolean().optional(),
    backgroundTasksRunning: z.number().int().nonnegative().max(10_000).optional(),
    fileCategory: z.enum(FILE_CATEGORIES).optional(),
    commandCategory: z.enum(COMMAND_CATEGORIES).optional(),
    content: OptInContentSchema.optional(),
    /** Set only for a session launched from a playbook (QAVO_RUN_ID): a random id, never content. */
    runId: z.string().regex(/^run_[A-Za-z0-9_-]{6,64}$/).optional(),
  })
  .strict();

export type SanitizedEvent = z.infer<typeof SanitizedEventSchema>;
