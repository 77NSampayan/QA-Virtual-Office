/**
 * Allowlist sanitizer: raw hook stdin -> SanitizedEvent. Runs INSIDE the hook process, before
 * anything is sent or spooled. Everything not explicitly listed here is dropped — notably
 * cwd, transcript_path, prompt, tool_input, tool_response, message, title,
 * last_assistant_message, error_details. Opt-in content is redacted and truncated.
 */
import { classifyCommand, classifyFile, COMMAND_TOOLS } from './classify.ts';
import {
  HOOK_EVENTS,
  ID_RE,
  MODEL_RE,
  PERMISSION_MODES,
  SAFE_TOKEN_RE,
  SESSION_START_SOURCES,
  STOP_FAILURE_ERRORS,
  TOOL_NAME_RE,
  type HookEventName,
  type OptInContent,
  type SanitizedEvent,
} from './events.ts';
import type { CapturePolicy } from './policy.ts';
import { redact, truncate } from './redact.ts';

export type SanitizeResolution =
  | { kind: 'project'; projectId: string }
  | { kind: 'unregistered'; folderKeys: string[] };

const TOOL_EVENTS = new Set<string>(['PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'PermissionRequest']);
const CONTENT_MAX = 2000;

const str = (v: unknown, re: RegExp): string | undefined =>
  typeof v === 'string' && re.test(v) ? v : undefined;
const bool = (v: unknown): boolean | undefined => (typeof v === 'boolean' ? v : undefined);
const oneOf = <T extends string>(v: unknown, list: readonly T[]): T | undefined =>
  typeof v === 'string' && (list as readonly string[]).includes(v) ? (v as T) : undefined;

function safeStringify(v: unknown): string {
  try {
    return typeof v === 'string' ? v : JSON.stringify(v);
  } catch {
    return '';
  }
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Matchers for registered project roots and excluded paths in ANY slash style / case / doubled
 * separators. Applied to opted-in content so a project's real path never lands in the database,
 * exports or logs even when the user typed it into a prompt. Boundary-aware: `repo` does not match
 * `repo-old`.
 */
export function pathMatchers(policy: CapturePolicy): RegExp[] {
  const forms = new Set<string>();
  for (const p of [...policy.projects, ...policy.excludes]) {
    forms.add(p.lexical);
    if (p.canonical) forms.add(p.canonical);
  }
  return [...forms]
    .sort((a, b) => b.length - a.length)
    .map(
      (f) =>
        new RegExp('(?<![A-Za-z0-9_-])' + f.split('\\').map(escapeRe).join('[\\\\/]+') + '(?![A-Za-z0-9_-])', 'gi'),
    );
}

export const maskPaths = (text: string, matchers: RegExp[]) => matchers.reduce((t, re) => t.replace(re, '<project>'), text);

function optInContent(raw: Record<string, unknown>, event: string, policy: CapturePolicy): OptInContent | undefined {
  const c: OptInContent = {};
  const matchers = pathMatchers(policy);
  const prep = (v: unknown) => truncate(redact(maskPaths(safeStringify(v), matchers)), CONTENT_MAX);
  if (policy.capture.prompts && event === 'UserPromptSubmit' && typeof raw.prompt === 'string') {
    c.prompt = prep(raw.prompt);
  }
  if (policy.capture.toolInputs && TOOL_EVENTS.has(event) && raw.tool_input !== undefined) {
    c.toolInput = prep(raw.tool_input);
  }
  if (policy.capture.toolOutputs && event === 'PostToolUse' && raw.tool_response !== undefined) {
    c.toolResponse = prep(raw.tool_response);
  }
  if (policy.capture.notificationText && event === 'Notification') {
    const text = [raw.title, raw.message].filter((x) => typeof x === 'string').join(' — ');
    if (text) c.notificationText = prep(text);
  }
  return Object.keys(c).length ? c : undefined;
}

export interface SanitizeDeps {
  now?: () => Date;
  uuid?: () => string;
}

export function sanitizeHookPayload(
  raw: unknown,
  resolution: SanitizeResolution,
  policy: CapturePolicy,
  deps: SanitizeDeps = {},
): SanitizedEvent | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const sessionId = str(r.session_id, ID_RE);
  if (!sessionId) return null;

  const rawName = typeof r.hook_event_name === 'string' ? r.hook_event_name : '';
  const known = (HOOK_EVENTS as readonly string[]).includes(rawName);
  const event = (known ? rawName : 'other') as HookEventName | 'other';

  const ev: SanitizedEvent = {
    v: 1,
    eventId: (deps.uuid ?? (() => crypto.randomUUID()))(),
    ts: (deps.now ?? (() => new Date()))().toISOString(),
    sessionId,
    event,
    projectId: resolution.kind === 'project' ? resolution.projectId : null,
    folderKeys: resolution.kind === 'unregistered' ? resolution.folderKeys.slice(0, 18) : [],
  };
  if (!known && /^[A-Za-z]{1,40}$/.test(rawName)) ev.rawEventName = rawName;

  const permissionMode = oneOf(r.permission_mode, PERMISSION_MODES);
  if (permissionMode) ev.permissionMode = permissionMode;

  // Subagent identity (any event fired inside a subagent, plus SubagentStart/Stop).
  const agentId = str(r.agent_id, ID_RE);
  if (agentId) ev.agentId = agentId;
  if (typeof r.agent_type === 'string' && /^[A-Za-z0-9_.:-]{0,128}$/.test(r.agent_type)) {
    ev.agentType = r.agent_type;
  }

  if (TOOL_EVENTS.has(event)) {
    const toolName = typeof r.tool_name === 'string' ? (TOOL_NAME_RE.test(r.tool_name) ? r.tool_name : 'unknown') : undefined;
    if (toolName) ev.toolName = toolName;
    const toolUseId = str(r.tool_use_id, ID_RE);
    if (toolUseId) ev.toolUseId = toolUseId;
    if (typeof r.duration_ms === 'number' && Number.isFinite(r.duration_ms) && r.duration_ms >= 0) {
      ev.durationMs = Math.min(Math.round(r.duration_ms), 86_400_000);
    }
    const input = r.tool_input && typeof r.tool_input === 'object' ? (r.tool_input as Record<string, unknown>) : undefined;
    if (input) {
      const fc = classifyFile(input.file_path ?? input.notebook_path ?? input.path);
      if (fc) ev.fileCategory = fc;
      if (toolName && (COMMAND_TOOLS as readonly string[]).includes(toolName)) {
        const cc = classifyCommand(input.command);
        if (cc) ev.commandCategory = cc;
      }
    }
  }

  switch (event) {
    case 'SessionStart': {
      ev.source = oneOf(r.source, SESSION_START_SOURCES) ?? (r.source === undefined ? undefined : 'other');
      if (ev.source === undefined) delete ev.source;
      const model =
        typeof r.model === 'string'
          ? r.model
          : r.model && typeof r.model === 'object'
            ? (r.model as Record<string, unknown>).id
            : undefined;
      const m = str(model, MODEL_RE);
      if (m) ev.model = m;
      break;
    }
    case 'SessionEnd': {
      const reason = str(r.reason, SAFE_TOKEN_RE);
      if (reason) ev.reason = reason;
      break;
    }
    case 'PostToolUseFailure': {
      const isInterrupt = bool(r.is_interrupt);
      if (isInterrupt !== undefined) ev.isInterrupt = isInterrupt;
      const first = typeof r.error === 'string' ? r.error.split(/\r?\n/, 1)[0]!.trim() : '';
      ev.error = /^Exit code \d{1,6}$/.test(first) ? first : 'tool_error';
      break;
    }
    case 'StopFailure': {
      ev.error = oneOf(r.error, STOP_FAILURE_ERRORS) ?? 'unknown';
      break;
    }
    case 'Notification': {
      const nt = str(r.notification_type, SAFE_TOKEN_RE);
      if (nt) ev.notificationType = nt;
      break;
    }
    case 'Stop':
    case 'SubagentStop': {
      const sha = bool(r.stop_hook_active);
      if (sha !== undefined) ev.stopHookActive = sha;
      if (Array.isArray(r.background_tasks)) {
        ev.backgroundTasksRunning = r.background_tasks.filter(
          (t) => t && typeof t === 'object' && (t as Record<string, unknown>).status === 'running',
        ).length;
      }
      break;
    }
    default:
      break;
  }

  const content = optInContent(r, event, policy);
  if (content) ev.content = content;
  return ev;
}
