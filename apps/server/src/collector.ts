/**
 * Collector pipeline: validate -> defensive re-sanitize -> dedupe -> status machine ->
 * project/robot resolution -> persist (one transaction) -> notifications -> broadcast.
 *
 * Replay (events spooled while the server was down): applied in timestamp order. A replayed event
 * that is OLDER than the session's latest state is recorded for history but never applied, so it
 * cannot rewind a live status (rule "stale").
 */
import {
  applyEvent,
  applyTimers,
  SanitizedEventSchema,
  StatusLineSnapshotSchema,
  type Effect,
  type SanitizedEvent,
  type SessionState,
  type StatusLineSnapshot,
} from '@qavo/shared';
import type { DB } from './db/index.ts';
import { currentCapture } from './policyWriter.ts';
import {
  addFolderKeys,
  assignRobot,
  eventExists,
  eventRowToDto,
  insertNotification,
  loadSession,
  projectExists,
  saveSession,
  sessionDto,
  sessionIdsForTimers,
  type EventDTO,
  type NotificationDTO,
  type SessionDTO,
  type SessionMeta,
} from './store.ts';

export type Broadcast = (msg: { type: string; [k: string]: unknown }) => void;
export type EventOrigin = 'hook' | 'replay';

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
    if (Object.keys(c).length) ev.content = c;
    else delete ev.content;
  }
  return ev;
}

function insertEventRow(
  db: DB,
  ev: SanitizedEvent,
  projectId: string | null,
  statusAfter: string,
  statusSourceAfter: string,
  rule: string,
  origin: EventOrigin,
): EventDTO {
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
    project_id: projectId,
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
    status_after: statusAfter,
    status_source_after: statusSourceAfter,
    rule,
    occurred_at: ev.ts,
    // Replayed events keep their ORIGINAL time so timelines and retention stay truthful.
    received_at: origin === 'replay' ? ev.ts : new Date().toISOString(),
    origin_source: origin,
    content_json: ev.content ? JSON.stringify(ev.content) : null,
  });
  return eventRowToDto(db.prepare('SELECT * FROM agent_events WHERE id = ?').get(ev.eventId) as Record<string, unknown>);
}

export function ingest(db: DB, body: unknown, broadcast: Broadcast, origin: EventOrigin = 'hook'): IngestResult {
  const ev = resanitize(db, body);
  if (eventExists(db, ev.eventId)) return { status: 'duplicate' }; // matrix row 32

  const result = db.transaction((): IngestResult => {
    const loaded = loadSession(db, ev.sessionId);
    const tsMs = Date.parse(ev.ts);

    // Stale replay: record for history, do not touch session state.
    if (origin === 'replay' && loaded && Number.isFinite(tsMs) && tsMs < loaded.state.lastEventAt) {
      const row = insertEventRow(db, ev, loaded.meta.projectId, loaded.state.status, loaded.state.statusSource, 'stale', origin);
      return { status: 'accepted', session: sessionDto(db, ev.sessionId)!, event: row, notifications: [] };
    }

    const t = applyEvent(loaded?.state, ev.sessionId, {
      ...ev,
      at: Number.isFinite(tsMs) ? Math.max(tsMs, loaded?.state.lastEventAt ?? 0) : Date.now(),
    });

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

    const row = insertEventRow(db, ev, meta.projectId, t.state.status, t.state.statusSource, t.rule, origin);
    const session = sessionDto(db, ev.sessionId)!;
    const notifications: NotificationDTO[] = [];
    // Notifications from replayed events would be stale alerts; only live events notify.
    if (origin === 'hook') {
      for (const e of t.effects) {
        if (e.type !== 'notify') continue;
        const text = renderNotification(e, session.projectAlias, session.robot?.name ?? null);
        notifications.push(
          insertNotification(db, { kind: e.kind, priority: e.priority, ...text, projectId: meta.projectId, sessionId: ev.sessionId }),
        );
      }
    }
    return { status: 'accepted', session, event: row, notifications };
  })();

  broadcast({ type: 'session.updated', session: result.session });
  broadcast({ type: 'event.created', event: result.event });
  for (const n of result.notifications ?? []) broadcast({ type: 'notification.created', notification: n });
  return result;
}

/** Status-line snapshot: numbers only; updates the latest snapshot and, if known, the session model. */
export function ingestStatusLine(db: DB, body: unknown, broadcast: Broadcast): { stored: boolean } {
  const parsed = StatusLineSnapshotSchema.safeParse(body);
  if (!parsed.success) throw new ValidationError('invalid_statusline');
  const s: StatusLineSnapshot = parsed.data;
  const projectId = s.projectId && projectExists(db, s.projectId) ? s.projectId : null;
  db.transaction(() => {
    db.prepare(
      `INSERT INTO statusline_snapshots (session_id, project_id, model_id, model_name, cost_usd, duration_ms, api_duration_ms,
         context_used_pct, context_window_size, five_hour_pct, five_hour_resets_at, seven_day_pct, seven_day_resets_at, updated_at)
       VALUES (@session_id, @project_id, @model_id, @model_name, @cost_usd, @duration_ms, @api_duration_ms,
         @context_used_pct, @context_window_size, @five_hour_pct, @five_hour_resets_at, @seven_day_pct, @seven_day_resets_at, @updated_at)
       ON CONFLICT(session_id) DO UPDATE SET project_id = excluded.project_id, model_id = excluded.model_id,
         model_name = excluded.model_name, cost_usd = excluded.cost_usd, duration_ms = excluded.duration_ms,
         api_duration_ms = excluded.api_duration_ms, context_used_pct = excluded.context_used_pct,
         context_window_size = excluded.context_window_size, five_hour_pct = excluded.five_hour_pct,
         five_hour_resets_at = excluded.five_hour_resets_at, seven_day_pct = excluded.seven_day_pct,
         seven_day_resets_at = excluded.seven_day_resets_at, updated_at = excluded.updated_at`,
    ).run({
      session_id: s.sessionId,
      project_id: projectId,
      model_id: s.modelId ?? null,
      model_name: s.modelName ?? null,
      cost_usd: s.costUsd ?? null,
      duration_ms: s.durationMs ?? null,
      api_duration_ms: s.apiDurationMs ?? null,
      context_used_pct: s.contextUsedPct ?? null,
      context_window_size: s.contextWindowSize ?? null,
      five_hour_pct: s.fiveHourPct ?? null,
      five_hour_resets_at: s.fiveHourResetsAt ?? null,
      seven_day_pct: s.sevenDayPct ?? null,
      seven_day_resets_at: s.sevenDayResetsAt ?? null,
      updated_at: new Date().toISOString(),
    });
    if (s.modelId) db.prepare('UPDATE sessions SET model = ? WHERE session_id = ?').run(s.modelId, s.sessionId);
  })();
  const session = sessionDto(db, s.sessionId);
  if (session) broadcast({ type: 'session.updated', session });
  return { stored: true };
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
