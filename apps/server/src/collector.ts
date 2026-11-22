/**
 * Collector pipeline: validate -> defensive re-sanitize -> dedupe -> status machine ->
 * project/robot resolution -> persist (one transaction) -> notifications -> broadcast.
 */
import {
  applyEvent,
  applyTimers,
  SanitizedEventSchema,
  type Effect,
  type SanitizedEvent,
  type SessionState,
} from '@qavo/shared';
import type { DB } from './db/index.ts';
import { currentCapture } from './policyWriter.ts';
import {
  addFolderKeys,
  assignRobot,
  eventExists,
  insertNotification,
  loadSession,
  projectExists,
  saveSession,
  sessionDto,
  sessionIdsForTimers,
  eventRowToDto,
  type NotificationDTO,
  type SessionDTO,
  type EventDTO,
  type SessionMeta,
} from './store.ts';

export type Broadcast = (msg: { type: string; [k: string]: unknown }) => void;

export interface IngestResult {
  status: 'accepted' | 'duplicate';
  session?: SessionDTO;
  event?: EventDTO;
  notifications?: NotificationDTO[];
}

export class ValidationError extends Error {}

const TOOL_LABEL = (t?: string) => (t ? t.replace(/^mcp__/, 'MCP:').slice(0, 60) : 'a tool');

function renderNotification(e: Extract<Effect, { type: 'notify' }>, alias: string | null, robotName: string | null) {
  const who = robotName ?? 'An agent';
  const where = alias ? ` in ${alias}` : '';
  switch (e.kind) {
    case 'permission_required':
      return { title: 'Permission required', body: `${who}${where} is waiting for permission to use ${TOOL_LABEL(e.data.toolName)}. Approve or deny it in the Claude Code terminal.` };
    case 'input_required':
      return { title: 'Input required', body: `${who}${where} needs your input in the Claude Code terminal.` };
    case 'waiting_for_user':
      return { title: 'Waiting for you', body: `${who}${where} is idle and waiting for your next prompt.` };
    case 'session_completed':
      return {
        title: 'Task completed',
        body: `${who}${where} finished its turn${e.data.backgroundTasks ? ` (${e.data.backgroundTasks} background task(s) still running)` : ''}.`,
      };
    case 'session_failed':
      return { title: 'Agent failed', body: `${who}${where} stopped with an error: ${e.data.error ?? 'unknown'}.` };
    case 'agent_completed':
      return { title: 'Agent completed', body: `${who}${where} reported completion.` };
    case 'auth_storage_failure':
      return { title: 'Claude Code auth storage problem', body: `${who}${where} reported an authentication storage failure.` };
  }
}

/** Server-side defensive re-sanitize: strict schema; opt-in content kept only if the policy allows it. */
export function resanitize(db: DB, body: unknown): SanitizedEvent {
  const parsed = SanitizedEventSchema.safeParse(body);
  if (!parsed.success) throw new ValidationError('invalid_event');
  const ev = parsed.data;
  if (ev.content) {
    const cap = currentCapture(db);
    const c = { ...ev.content };
    if (!cap.prompts) delete c.prompt;
    if (!cap.toolInputs) delete c.toolInput;
    if (!cap.toolOutputs) delete c.toolResponse;
    if (!cap.notificationText) delete c.notificationText;
    ev.content = Object.keys(c).length ? c : undefined;
    if (!ev.content) delete ev.content;
  }
  return ev;
}

export function ingest(db: DB, body: unknown, broadcast: Broadcast, origin: 'hook' | 'replay' = 'hook'): IngestResult {
  const ev = resanitize(db, body);
  if (eventExists(db, ev.eventId)) return { status: 'duplicate' }; // matrix row 32

  const result = db.transaction((): IngestResult => {
    const loaded = loadSession(db, ev.sessionId);
    const at = Date.parse(ev.ts);
    const t = applyEvent(loaded?.state, ev.sessionId, { ...ev, at: Number.isFinite(at) ? Math.max(at, loaded?.state.lastEventAt ?? 0) : Date.now() });

    const eventProjectId = ev.projectId && projectExists(db, ev.projectId) ? ev.projectId : null;
    const meta: SessionMeta = loaded?.meta ?? {
      projectId: null,
      folderKey: null,
      robotId: null,
      parentSessionId: null,
      model: null,
      permissionMode: null,
      lastRule: null,
    };
    if (eventProjectId && meta.projectId !== eventProjectId) meta.projectId = eventProjectId;
    if (!meta.folderKey && ev.folderKeys.length) meta.folderKey = ev.folderKeys[0]!;
    if (ev.model) meta.model = ev.model;
    if (ev.permissionMode) meta.permissionMode = ev.permissionMode;
    meta.lastRule = t.rule;

    const created = t.effects.find((e) => e.type === 'session_created') as Extract<Effect, { type: 'session_created' }> | undefined;
    if (created || !meta.robotId) {
      meta.robotId = assignRobot(db, meta.projectId, created?.origin ?? t.state.origin).id;
    }

    saveSession(db, t.state, meta);
    if (ev.folderKeys.length) addFolderKeys(db, ev.sessionId, ev.folderKeys);

    const receivedAt = new Date().toISOString();
    db.prepare(
      `INSERT INTO agent_events (id, dedupe_key, session_id, project_id, event, raw_event_name, agent_id, agent_type, tool_name,
         tool_use_id, notification_type, source, reason, error, permission_mode, model, duration_ms, is_interrupt,
         file_category, command_category, background_tasks, status_after, status_source_after, rule, occurred_at,
         received_at, origin_source, content_json)
       VALUES (@id, @dedupe_key, @session_id, @project_id, @event, @raw_event_name, @agent_id, @agent_type, @tool_name,
         @tool_use_id, @notification_type, @source, @reason, @error, @permission_mode, @model, @duration_ms, @is_interrupt,
         @file_category, @command_category, @background_tasks, @status_after, @status_source_after, @rule, @occurred_at,
         @received_at, @origin_source, @content_json)`,
    ).run({
      id: ev.eventId,
      dedupe_key: ev.eventId,
      session_id: ev.sessionId,
      project_id: meta.projectId,
      event: ev.event,
      raw_event_name: ev.rawEventName ?? null,
      agent_id: ev.agentId ?? null,
      agent_type: ev.agentType ?? null,
      tool_name: ev.toolName ?? null,
      tool_use_id: ev.toolUseId ?? null,
      notification_type: ev.notificationType ?? null,
      source: ev.source ?? null,
      reason: ev.reason ?? null,
      error: ev.error ?? null,
      permission_mode: ev.permissionMode ?? null,
      model: ev.model ?? null,
      duration_ms: ev.durationMs ?? null,
      is_interrupt: ev.isInterrupt === undefined ? null : ev.isInterrupt ? 1 : 0,
      file_category: ev.fileCategory ?? null,
      command_category: ev.commandCategory ?? null,
      background_tasks: ev.backgroundTasksRunning ?? null,
      status_after: t.state.status,
      status_source_after: t.state.statusSource,
      rule: t.rule,
      occurred_at: ev.ts,
      received_at: receivedAt,
      origin_source: origin,
      content_json: ev.content ? JSON.stringify(ev.content) : null,
    });

    const session = sessionDto(db, ev.sessionId)!;
    const notifications: NotificationDTO[] = [];
    for (const e of t.effects) {
      if (e.type !== 'notify') continue;
      const text = renderNotification(e, session.projectAlias, session.robot?.name ?? null);
      notifications.push(
        insertNotification(db, { kind: e.kind, priority: e.priority, ...text, projectId: meta.projectId, sessionId: ev.sessionId }),
      );
    }
    const row = db.prepare('SELECT * FROM agent_events WHERE id = ?').get(ev.eventId) as Record<string, unknown>;
    return { status: 'accepted', session, event: eventRowToDto(row), notifications };
  })();

  broadcast({ type: 'session.updated', session: result.session });
  broadcast({ type: 'event.created', event: result.event });
  for (const n of result.notifications ?? []) broadcast({ type: 'notification.created', notification: n });
  return result;
}

/** Timer rules (27, drone linger). Returns sessions that changed. */
export function runTimers(db: DB, broadcast: Broadcast, now = Date.now()): string[] {
  const changed: string[] = [];
  for (const id of sessionIdsForTimers(db)) {
    const loaded = loadSession(db, id);
    if (!loaded) continue;
    const t = applyTimers(loaded.state as SessionState, now);
    if (!t) continue;
    saveSession(db, t.state, { ...loaded.meta, lastRule: t.rule });
    changed.push(id);
    broadcast({ type: 'session.updated', session: sessionDto(db, id) });
  }
  return changed;
}
