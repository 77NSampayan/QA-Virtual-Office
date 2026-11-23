/**
 * Playbook runs (P2): the server-enforced identity of a launched agent.
 *
 * Pressing "Run this playbook" mints a random credential for ONE run: bound to a playbook, the agent's name at that
 * moment and one project, valid for a limited time, revocable. Only its SHA-256 hash is stored; the credential
 * itself is returned once, to the launcher, and written to the per-run MCP config (current-user ACL). A person
 * mints and revokes runs; an agent can never create one.
 */
import crypto from 'node:crypto';
import { PLAYBOOK_BY_ID, RUN_ID_RE, type Actor, type PlaybookDef } from '@qavo/shared';
import type { DB } from './db/index.ts';
import { getPlaybook } from './playbooks.ts';
import { HttpError, newId } from './store.ts';

export const RUN_HOURS = 8;
const nowIso = () => new Date().toISOString();
export const hashRunToken = (token: string) => crypto.createHash('sha256').update(token).digest('hex');

export interface RunIdentity {
  runId: string;
  projectId: string;
  playbookId: string;
  agentName: string;
  role: string;
  def: PlaybookDef;
}
export interface RunDTO {
  id: string;
  project: string | null;
  playbookId: string;
  agentName: string;
  role: string;
  startedAt: string;
  expiresAt: string;
  status: 'active' | 'expired' | 'revoked';
}

export function createRun(db: DB, projectId: string, playbookId: string, actor: Actor, now = Date.now()): { run: RunDTO; token: string } {
  if (actor !== 'human') throw new HttpError(403, 'human_required', 'Only a person can launch an agent');
  const def = PLAYBOOK_BY_ID[playbookId];
  if (!def) throw new HttpError(404, 'playbook_not_found');
  if (!def.available) throw new HttpError(409, 'playbook_unavailable', `${def.role} arrives in Pass 3`);
  const p = db.prepare('SELECT archived FROM projects WHERE id = ?').get(projectId) as { archived: number } | undefined;
  if (!p) throw new HttpError(404, 'project_not_found');
  if (p.archived === 1) throw new HttpError(409, 'project_archived', 'This project is archived');
  const pb = getPlaybook(db, playbookId);
  const token = crypto.randomBytes(32).toString('base64url');
  const id = newId('run');
  db.prepare('INSERT INTO playbook_runs (id, project_id, playbook_id, agent_name, role, token_hash, started_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
    id,
    projectId,
    playbookId,
    pb.agentName,
    def.role,
    hashRunToken(token),
    new Date(now).toISOString(),
    new Date(now + RUN_HOURS * 3_600_000).toISOString(),
  );
  return { run: getRun(db, id, now), token };
}

type Row = { id: string; project_id: string; playbook_id: string; agent_name: string; role: string; started_at: string; expires_at: string; revoked_at: string | null; alias?: string | null };
const statusOf = (r: Row, now: number): RunDTO['status'] => (r.revoked_at ? 'revoked' : Date.parse(r.expires_at) <= now ? 'expired' : 'active');
const dto = (r: Row, now: number): RunDTO => ({ id: r.id, project: r.alias ?? null, playbookId: r.playbook_id, agentName: r.agent_name, role: r.role, startedAt: r.started_at, expiresAt: r.expires_at, status: statusOf(r, now) });

export function getRun(db: DB, id: string, now = Date.now()): RunDTO {
  const r = db.prepare('SELECT r.*, p.alias FROM playbook_runs r LEFT JOIN projects p ON p.id = r.project_id WHERE r.id = ?').get(id) as Row | undefined;
  if (!r) throw new HttpError(404, 'run_not_found');
  return dto(r, now);
}
export function listRuns(db: DB, limit = 30, now = Date.now()): RunDTO[] {
  return (db.prepare('SELECT r.*, p.alias FROM playbook_runs r LEFT JOIN projects p ON p.id = r.project_id ORDER BY r.started_at DESC, r.rowid DESC LIMIT ?').all(Math.min(limit, 100)) as Row[]).map((r) => dto(r, now));
}

export function revokeRun(db: DB, id: string, actor: Actor): RunDTO {
  if (actor !== 'human') throw new HttpError(403, 'human_required', 'Only a person can stop an agent');
  if (db.prepare('UPDATE playbook_runs SET revoked_at = COALESCE(revoked_at, ?) WHERE id = ?').run(nowIso(), id).changes === 0) throw new HttpError(404, 'run_not_found');
  return getRun(db, id);
}

/** Resolves a presented credential to an identity, or null (unknown, expired or revoked). Constant-time on the hash. */
export function resolveRunToken(db: DB, token: string, now = Date.now()): RunIdentity | null {
  if (typeof token !== 'string' || token.length < 20 || token.length > 200) return null;
  const r = db.prepare('SELECT * FROM playbook_runs WHERE token_hash = ?').get(hashRunToken(token)) as Row | undefined;
  if (!r || statusOf(r, now) !== 'active') return null;
  const def = PLAYBOOK_BY_ID[r.playbook_id];
  if (!def) return null;
  return { runId: r.id, projectId: r.project_id, playbookId: r.playbook_id, agentName: r.agent_name, role: r.role, def };
}

/** For the office link: a run id seen on a hook event, if it is a real, active run of the same project. */
export function activeRunForEvent(db: DB, runId: string, projectId: string | null, now = Date.now()): RunIdentity | null {
  if (!RUN_ID_RE.test(runId)) return null;
  const r = db.prepare('SELECT * FROM playbook_runs WHERE id = ?').get(runId) as Row | undefined;
  if (!r || statusOf(r, now) !== 'active' || r.project_id !== projectId) return null;
  const def = PLAYBOOK_BY_ID[r.playbook_id];
  return def ? { runId: r.id, projectId: r.project_id, playbookId: r.playbook_id, agentName: r.agent_name, role: r.role, def } : null;
}
