/**
 * Redacted data export (JSON / CSV). Rules (docs/privacy.md):
 *  - project ALIASES only; `project_paths` is never exported
 *  - redaction re-applied to every free-text field (aliases, descriptions, notification text,
 *    opted-in content); schema-constrained fields (ids, enums, tool names) are exported as stored
 *  - a manifest states the capture policy in force
 */
import { redact, redactObject } from '@qavo/shared';
import type { DB } from './db/index.ts';
import { currentCapture, currentScope } from './policyWriter.ts';
import { getRetention } from './maintenance.ts';
import { listNotifications, listProjects, listSessions } from './store.ts';

export const EXPORT_FORMAT_VERSION = 1;

function parseContent(json: unknown): Record<string, string> | null {
  if (typeof json !== 'string') return null;
  try {
    return redactObject(JSON.parse(json) as Record<string, string>);
  } catch {
    return null;
  }
}

export function buildExport(db: DB, appVersion: string, now = new Date()) {
  const projects = listProjects(db).map((p) => ({
    id: p.id,
    alias: redact(p.alias),
    type: p.type,
    description: redact(p.description),
    archived: p.archived,
  }));
  const sessions = listSessions(db, 10_000).map((s) => ({
    ...s,
    projectAlias: s.projectAlias === null ? null : redact(s.projectAlias),
  }));
  const eventRows = db
    .prepare(
      `SELECT id, session_id, project_id, event, raw_event_name, agent_id, agent_type, tool_name, notification_type, source,
              reason, error, file_category, command_category, duration_ms, status_after, status_source_after, rule,
              occurred_at, received_at, origin_source, content_json
       FROM agent_events ORDER BY received_at, rowid`,
    )
    .all() as Array<Record<string, unknown>>;
  const events = eventRows.map(({ content_json, ...rest }) => ({ ...rest, content: parseContent(content_json) }));
  const notifications = listNotifications(db, 10_000).map((n) => ({ ...n, title: redact(n.title), body: redact(n.body) }));
  return {
    manifest: {
      format: EXPORT_FORMAT_VERSION,
      app: 'QA Virtual Office',
      version: appVersion,
      exportedAt: now.toISOString(),
      redaction: 'applied',
      projectPathsIncluded: false,
      capturePolicy: { scope: currentScope(db), capture: currentCapture(db), retention: getRetention(db) },
      counts: { projects: projects.length, sessions: sessions.length, events: events.length, notifications: notifications.length },
    },
    projects,
    sessions,
    events,
    notifications,
  };
}

/** Neutralizes spreadsheet formula injection and quotes per RFC 4180. */
export function csvCell(value: unknown): string {
  let s = value === null || value === undefined ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const EVENT_COLUMNS = [
  'occurred_at',
  'received_at',
  'session_id',
  'project_id',
  'event',
  'agent_type',
  'tool_name',
  'notification_type',
  'source',
  'reason',
  'error',
  'file_category',
  'command_category',
  'status_after',
  'status_source_after',
  'rule',
  'origin_source',
  'content',
] as const;

export function buildEventsCsv(data: ReturnType<typeof buildExport>): string {
  const header = EVENT_COLUMNS.join(',');
  const rows = data.events.map((e) =>
    EVENT_COLUMNS.map((c) => csvCell((e as Record<string, unknown>)[c])).join(','),
  );
  return [header, ...rows].join('\r\n') + '\r\n';
}
