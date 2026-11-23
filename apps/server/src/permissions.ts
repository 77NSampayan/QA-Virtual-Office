/**
 * Permission requests answered from the office (V4b).
 *
 * Rules, enforced HERE and by database constraints:
 *  - the bridge is OFF until a person turns it on; while off no request is accepted
 *  - only a person can allow or deny (the UI API; never the agent token, never the hook token)
 *  - ALLOW needs the details: it is refused when tool-input capture was off (a person must not approve what they
 *    cannot see); DENY is always possible
 *  - a decision is final and single-use; a request expires on its own and when the session moves on
 *  - the command summary is erased as soon as the request is answered or has expired
 *  - nothing is ever approved automatically: no answer means "say nothing" and Claude Code asks in the terminal
 */
import { z } from 'zod';
import { redact, safeToolName, SUMMARY_MAX, type Actor } from '@qavo/shared';
import type { DB } from './db/index.ts';
import { getSetting, HttpError, newId, setSetting } from './store.ts';

export const MAX_PENDING = 20;
export const DEFAULT_WAIT_SECONDS = 110;
const KEEP_DECIDED_MS = 7 * 24 * 3600_000;

export const bridgeEnabled = (db: DB): boolean => getSetting<boolean>(db, 'permission_bridge', false) === true;
export const setBridge = (db: DB, enabled: boolean) => setSetting(db, 'permission_bridge', enabled);

const RequestInput = z
  .object({
    sessionId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
    projectId: z.string().max(128).nullable(),
    toolName: z.string().max(80),
    summary: z.string().max(2_000).nullable(),
  })
  .strict();

export interface PermissionRequestDTO {
  id: string;
  sessionId: string;
  robotName: string | null;
  projectAlias: string | null;
  toolName: string;
  /** What the person is being asked to approve; null when it is hidden by their privacy settings. */
  summary: string | null;
  createdAt: number;
  expiresAt: number;
  /** False when the details are hidden: such a request can only be denied or answered in the terminal. */
  canAllow: boolean;
}
export type PermissionStatus = 'pending' | 'allowed' | 'denied' | 'expired';

type Row = Record<string, unknown>;

/** Marks overdue requests expired (erasing their summary) and forgets old answered ones. */
export function sweep(db: DB, now: number): number {
  const changed = db.prepare("UPDATE permission_requests SET status = 'expired', reason = 'timed_out', summary = NULL WHERE status = 'pending' AND expires_at <= ?").run(now).changes;
  db.prepare("DELETE FROM permission_requests WHERE status <> 'pending' AND COALESCE(decided_at, expires_at) < ?").run(now - KEEP_DECIDED_MS);
  return changed;
}

export function createRequest(db: DB, input: unknown, now: number, waitSeconds = DEFAULT_WAIT_SECONDS): { id: string; expiresAt: number } {
  if (!bridgeEnabled(db)) throw new HttpError(409, 'bridge_disabled', 'Approving permissions from the office is turned off');
  const parsed = RequestInput.safeParse(input);
  if (!parsed.success) throw new HttpError(400, 'invalid_input', 'Invalid request');
  const v = parsed.data;
  sweep(db, now);
  const pending = (db.prepare("SELECT COUNT(*) AS c FROM permission_requests WHERE status = 'pending'").get() as { c: number }).c;
  if (pending >= MAX_PENDING) throw new HttpError(429, 'too_many_pending', 'Too many permission requests are waiting');
  const id = newId('prm');
  const expiresAt = now + Math.max(10, Math.min(300, waitSeconds)) * 1000;
  // defence in depth: the hook already summarized, redacted and truncated; do it again before anything is stored
  const summary = v.summary === null ? null : redact(v.summary).trim().slice(0, SUMMARY_MAX) || null;
  const known = v.projectId ? db.prepare('SELECT 1 FROM projects WHERE id = ?').get(v.projectId) : undefined;
  db.prepare('INSERT INTO permission_requests (id, session_id, project_id, tool_name, summary, status, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
    id,
    v.sessionId,
    known ? v.projectId : null,
    safeToolName(v.toolName),
    summary,
    'pending',
    now,
    expiresAt,
  );
  return { id, expiresAt };
}

export function statusOf(db: DB, id: string, now: number): { status: PermissionStatus; expiresAt: number } | null {
  sweep(db, now);
  const r = db.prepare('SELECT status, expires_at FROM permission_requests WHERE id = ?').get(id) as { status: PermissionStatus; expires_at: number } | undefined;
  return r ? { status: r.status, expiresAt: r.expires_at } : null;
}

export function listPending(db: DB, now: number): PermissionRequestDTO[] {
  sweep(db, now);
  const rows = db
    .prepare(
      `SELECT p.id, p.session_id, p.tool_name, p.summary, p.created_at, p.expires_at, pr.alias AS project_alias,
              (SELECT r.name FROM sessions s JOIN robots r ON r.id = s.robot_id WHERE s.session_id = p.session_id) AS robot_name
         FROM permission_requests p LEFT JOIN projects pr ON pr.id = p.project_id
        WHERE p.status = 'pending' ORDER BY p.created_at`,
    )
    .all() as Row[];
  return rows.map((r) => ({
    id: r.id as string,
    sessionId: r.session_id as string,
    robotName: (r.robot_name as string) ?? null,
    projectAlias: (r.project_alias as string) ?? null,
    toolName: r.tool_name as string,
    summary: (r.summary as string) ?? null,
    createdAt: r.created_at as number,
    expiresAt: r.expires_at as number,
    canAllow: r.summary !== null,
  }));
}

/** A person's decision. Final, single-use, and it erases the summary. */
export function decide(db: DB, id: string, decision: unknown, actor: Actor, now: number): { status: 'allowed' | 'denied' } {
  if (actor !== 'human') throw new HttpError(403, 'human_required', 'Only a person can answer a permission request');
  if (decision !== 'allow' && decision !== 'deny') throw new HttpError(400, 'invalid_input', 'decision must be "allow" or "deny"');
  sweep(db, now);
  const r = db.prepare('SELECT status, summary FROM permission_requests WHERE id = ?').get(id) as { status: PermissionStatus; summary: string | null } | undefined;
  if (!r) throw new HttpError(404, 'request_not_found');
  if (r.status !== 'pending') throw new HttpError(409, 'not_pending', r.status === 'expired' ? 'This request has expired: answer it in the terminal' : 'This request was already answered');
  if (decision === 'allow' && r.summary === null) {
    throw new HttpError(422, 'details_hidden', 'The details of this request are hidden by your privacy settings, so it cannot be approved here. Deny it, or answer in the terminal.');
  }
  const status = decision === 'allow' ? 'allowed' : 'denied';
  const done = db
    .prepare("UPDATE permission_requests SET status = ?, decided_by = 'human', decided_at = ?, summary = NULL WHERE id = ? AND status = 'pending'")
    .run(status, now, id).changes;
  if (done !== 1) throw new HttpError(409, 'not_pending', 'This request was already answered');
  return { status };
}

/** The session moved on (the person answered in the terminal, or it finished): its waiting requests are no longer ours to answer. */
export function expireForSession(db: DB, sessionId: string, reason: string, toolName?: string): number {
  const args: unknown[] = [reason, sessionId];
  let sql = "UPDATE permission_requests SET status = 'expired', reason = ?, summary = NULL WHERE status = 'pending' AND session_id = ?";
  if (toolName) {
    sql += ' AND tool_name = ?';
    args.push(safeToolName(toolName));
  }
  return db.prepare(sql).run(...args).changes;
}

export function recentDecisions(db: DB, limit = 20) {
  return (
    db
      .prepare(
        `SELECT p.tool_name, p.status, p.reason, p.created_at, p.decided_at, pr.alias AS project
           FROM permission_requests p LEFT JOIN projects pr ON pr.id = p.project_id
          WHERE p.status <> 'pending' ORDER BY COALESCE(p.decided_at, p.expires_at) DESC LIMIT ?`,
      )
      .all(Math.min(limit, 100)) as Array<{ tool_name: string; status: string; reason: string; created_at: number; decided_at: number | null; project: string | null }>
  ).map((r) => ({ tool: r.tool_name, status: r.status, reason: r.reason, project: r.project, at: r.decided_at ?? r.created_at }));
}

const ENDS_ALL = new Set(['UserPromptSubmit', 'Stop', 'StopFailure', 'SessionEnd']);
const ENDS_SAME_TOOL = new Set(['PostToolUse', 'PostToolUseFailure']);

/**
 * Called for every incoming status event: when the main agent carries on (the tool finished, the turn ended,
 * the session ended) a still-waiting request was answered elsewhere (usually in the terminal), so it expires.
 * Subagent events never expire anything. Returns how many requests expired.
 */
export function expireOnEvent(db: DB, body: unknown): number {
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  const sessionId = typeof b.sessionId === 'string' ? b.sessionId : '';
  const event = typeof b.event === 'string' ? b.event : '';
  if (!sessionId || b.agentId) return 0;
  if (ENDS_ALL.has(event)) return expireForSession(db, sessionId, 'answered_elsewhere');
  if (ENDS_SAME_TOOL.has(event) && typeof b.toolName === 'string') return expireForSession(db, sessionId, 'answered_elsewhere', b.toolName);
  return 0;
}
