/**
 * Automation script drafts (Pass 3, A4).
 *
 * A script is TEXT kept in this app. Nothing here runs a script or writes into the project.
 *  - a named WRITER agent (Axel) creates and revises drafts, only from APPROVED test cases, only its own drafts
 *  - a named REVIEWER agent (Vera, never the writer) records a recommendation; it never changes the status
 *  - only a PERSON approves or rejects (service check, and a database CHECK)
 *  - the text is redacted on the way in (secrets, personal data), and again on the way out to agents
 * The identity and own-work rules are also enforced by database triggers (migration 014).
 */
import crypto from 'node:crypto';
import { z } from 'zod';
import { MAX_REVIEW_NOTES, REVIEW_VERDICTS, SCRIPT_FRAMEWORKS, SCRIPT_MAX_CHARS, redact, type Actor, type ScriptStatus } from '@qavo/shared';
import type { DB } from './db/index.ts';
import type { RunIdentity } from './runs.ts';
import { HttpError, newId } from './store.ts';

type Row = Record<string, unknown>;
const nowIso = () => new Date().toISOString();
const code = (seq: number) => `AS-${String(seq).padStart(3, '0')}`;
const sameName = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();
function parse<T extends z.ZodTypeAny>(schema: T, input: unknown): z.infer<T> {
  const r = schema.safeParse(input);
  if (!r.success) throw new HttpError(400, 'invalid_input', `Invalid fields: ${[...new Set(r.error.issues.map((i) => i.path.join('.') || '(root)'))].join(', ')}`);
  return r.data;
}
const hashOf = (r: Row) =>
  crypto
    .createHash('sha256')
    .update([r.title, r.framework, r.test_case_id ?? '', r.content].join('\u0000'))
    .digest('hex');

const CreateInput = z
  .object({
    title: z.string().trim().min(1).max(200),
    framework: z.enum(SCRIPT_FRAMEWORKS),
    testCaseCode: z.string().trim().min(1).max(20),
    content: z.string().min(1).max(SCRIPT_MAX_CHARS),
    notes: z.string().max(2_000).default(''),
  })
  .strict();
const ReviseInput = z
  .object({
    title: z.string().trim().min(1).max(200).optional(),
    content: z.string().min(1).max(SCRIPT_MAX_CHARS).optional(),
    notes: z.string().max(2_000).optional(),
    replyToReviewer: z.string().max(1_000).optional(),
  })
  .strict();
const ReviewInput = z.object({ verdict: z.enum(REVIEW_VERDICTS), notes: z.string().max(MAX_REVIEW_NOTES * 2).default('') }).strict();
const DecisionInput = z.object({ to: z.enum(['approved', 'rejected']), note: z.string().max(2_000).default('') }).strict();

// ---------------------------------------------------------------------------- identity checks
function needWriter(who: RunIdentity | undefined): RunIdentity {
  if (!who) throw new HttpError(403, 'identity_required', 'Only a launched, named writer can do this. Use Run this playbook on the Team page.');
  if (who.def.kind !== 'writer' || who.def.area !== 'automation') throw new HttpError(403, 'not_a_script_writer', `${who.agentName} (${who.role}) does not write automation scripts.`);
  return who;
}
function needReviewer(who: RunIdentity | undefined): RunIdentity {
  if (!who) throw new HttpError(403, 'identity_required', 'Only a launched, named reviewer can do this. Use Run this playbook on the Team page.');
  if (who.def.kind !== 'reviewer' || who.def.area !== 'automation') throw new HttpError(403, 'not_a_script_reviewer', `${who.agentName} (${who.role}) does not review automation scripts.`);
  return who;
}

// ---------------------------------------------------------------------------- DTOs
export interface ScriptReview {
  verdict: string;
  by: string;
  at: string;
  notes: string;
  /** False when the script was revised after this review. */
  current: boolean;
}
export interface ScriptDTO {
  id: string;
  projectId: string;
  code: string;
  title: string;
  framework: string;
  status: ScriptStatus;
  version: number;
  draftedBy: string;
  testCaseCode: string | null;
  chars: number;
  review: ScriptReview | null;
  updatedAt: string;
}
export interface ScriptDetail extends ScriptDTO {
  content: string;
  notes: string;
  writerReply: string;
  decidedAt: string | null;
  decisionNote: string;
}

const SELECT = `SELECT s.*, t.code AS tc_code FROM automation_scripts s LEFT JOIN test_cases t ON t.id = s.test_case_id`;
function latestReview(db: DB, r: Row): ScriptReview | null {
  const v = db.prepare('SELECT * FROM automation_script_reviews WHERE script_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1').get(r.id as string) as Row | undefined;
  if (!v) return null;
  return { verdict: v.verdict as string, by: v.reviewer_name as string, at: v.created_at as string, notes: v.notes as string, current: v.script_hash === hashOf(r) };
}
const dto = (db: DB, r: Row): ScriptDTO => ({
  id: r.id as string,
  projectId: r.project_id as string,
  code: code(r.seq as number),
  title: r.title as string,
  framework: r.framework as string,
  status: r.status as ScriptStatus,
  version: r.version as number,
  draftedBy: r.drafted_by_name as string,
  testCaseCode: (r.tc_code as string | null) ?? null,
  chars: (r.content as string).length,
  review: latestReview(db, r),
  updatedAt: r.updated_at as string,
});
const detail = (db: DB, r: Row): ScriptDetail => ({
  ...dto(db, r),
  content: r.content as string,
  notes: r.notes as string,
  writerReply: r.writer_reply as string,
  decidedAt: (r.decided_at as string | null) ?? null,
  decisionNote: r.decision_note as string,
});

// ---------------------------------------------------------------------------- reads (person)
export function listScripts(db: DB, projectId: string): ScriptDTO[] {
  if (!db.prepare('SELECT 1 FROM projects WHERE id = ?').get(projectId)) throw new HttpError(404, 'project_not_found');
  return (db.prepare(`${SELECT} WHERE s.project_id = ? ORDER BY s.seq DESC`).all(projectId) as Row[]).map((r) => dto(db, r));
}
export function getScript(db: DB, id: string): ScriptDetail {
  const r = db.prepare(`${SELECT} WHERE s.id = ?`).get(id) as Row | undefined;
  if (!r) throw new HttpError(404, 'script_not_found');
  return detail(db, r);
}
export function scriptIdByCode(db: DB, projectId: string, scriptCode: string): string {
  const m = /^AS-(\d+)$/i.exec(scriptCode.trim());
  if (!m) throw new HttpError(400, 'invalid_input', 'Expected a code like AS-001');
  const r = db.prepare('SELECT id FROM automation_scripts WHERE project_id = ? AND seq = ?').get(projectId, Number(m[1])) as { id: string } | undefined;
  if (!r) throw new HttpError(404, 'script_not_found');
  return r.id;
}
export function projectOfScript(db: DB, id: string): string | undefined {
  return (db.prepare('SELECT project_id FROM automation_scripts WHERE id = ?').get(id) as { project_id: string } | undefined)?.project_id;
}

// ---------------------------------------------------------------------------- writer agent
export function createScript(db: DB, input: unknown, who: RunIdentity | undefined): { code: string; status: string; version: number; masked: boolean } {
  const w = needWriter(who);
  const v = parse(CreateInput, input);
  const tc = db.prepare('SELECT id, status, archived FROM test_cases WHERE project_id = ? AND lower(code) = lower(?)').get(w.projectId, v.testCaseCode) as { id: string; status: string; archived: number } | undefined;
  if (!tc) throw new HttpError(404, 'test_case_not_found');
  if (tc.archived === 1 || tc.status !== 'approved') throw new HttpError(409, 'test_case_not_approved', 'Scripts are written only from APPROVED test cases. A person approves test cases first.');
  const content = redact(v.content);
  const id = newId('ascr');
  const ts = nowIso();
  db.transaction(() => {
    const seq = ((db.prepare('SELECT COALESCE(MAX(seq), 0) AS m FROM automation_scripts WHERE project_id = ?').get(w.projectId) as { m: number }).m ?? 0) + 1;
    db.prepare(
      `INSERT INTO automation_scripts (id, project_id, seq, title, framework, test_case_id, content, notes, drafted_by_name, drafted_by_run, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, w.projectId, seq, redact(v.title).trim(), v.framework, tc.id, content, redact(v.notes).trim(), w.agentName, w.runId, ts, ts);
  })();
  const r = getScript(db, id);
  return { code: r.code, status: r.status, version: r.version, masked: content !== v.content };
}

export function reviseScript(db: DB, scriptCode: string, input: unknown, who: RunIdentity | undefined): { code: string; status: string; version: number; replied: boolean; masked: boolean } {
  const w = needWriter(who);
  const v = parse(ReviseInput, input);
  const id = scriptIdByCode(db, w.projectId, scriptCode);
  const row = db.prepare('SELECT * FROM automation_scripts WHERE id = ?').get(id) as Row;
  if (!sameName(String(row.drafted_by_name), w.agentName)) throw new HttpError(403, 'not_your_draft', 'A named agent may revise only the scripts it wrote itself');
  if (row.status !== 'draft') throw new HttpError(409, 'not_a_draft', `A ${String(row.status)} script can no longer change.`);
  const reply = v.replyToReviewer === undefined ? '' : redact(v.replyToReviewer).trim();
  const changing = v.title !== undefined || v.content !== undefined || v.notes !== undefined;
  if (!changing && !reply) throw new HttpError(400, 'invalid_input', 'Nothing to change');
  if (reply && !db.prepare('SELECT 1 FROM automation_script_reviews WHERE script_id = ?').get(id)) throw new HttpError(409, 'no_review_to_reply_to', 'There is no review on this script to answer.');
  const content = v.content === undefined ? undefined : redact(v.content);
  db.prepare('UPDATE automation_scripts SET title = ?, content = ?, notes = ?, writer_reply = ?, version = ?, updated_at = ? WHERE id = ?').run(
    v.title !== undefined ? redact(v.title).trim() : row.title,
    content ?? row.content,
    v.notes !== undefined ? redact(v.notes).trim() : row.notes,
    reply || row.writer_reply,
    changing ? (row.version as number) + 1 : row.version,
    nowIso(),
    id,
  );
  return { code: code(row.seq as number), status: 'draft', version: changing ? (row.version as number) + 1 : (row.version as number), replied: reply.length > 0, masked: content !== undefined && content !== v.content };
}

export function listMyScriptChanges(db: DB, who: RunIdentity | undefined): Array<{ code: string; title: string; reviewer: string; notes: string }> {
  const w = needWriter(who);
  return listScripts(db, w.projectId)
    .filter((s) => s.status === 'draft' && sameName(s.draftedBy, w.agentName) && s.review?.current && s.review.verdict === 'changes_requested')
    .map((s) => ({ code: s.code, title: s.title, reviewer: s.review!.by, notes: s.review!.notes }));
}

// ---------------------------------------------------------------------------- reviewer agent
export function listScriptsToReview(db: DB, who: RunIdentity | undefined): Array<{ code: string; title: string; framework: string; draftedBy: string; reason: 'not_reviewed' | 'revised_since_review'; writerReply?: string }> {
  const w = needReviewer(who);
  const out: Array<{ code: string; title: string; framework: string; draftedBy: string; reason: 'not_reviewed' | 'revised_since_review'; writerReply?: string }> = [];
  for (const s of listScripts(db, w.projectId)) {
    if (s.status !== 'draft' || sameName(s.draftedBy, w.agentName)) continue;
    if (!s.review) out.push({ code: s.code, title: s.title, framework: s.framework, draftedBy: s.draftedBy, reason: 'not_reviewed' });
    else if (!s.review.current) {
      const reply = (db.prepare('SELECT writer_reply AS r FROM automation_scripts WHERE id = ?').get(s.id) as { r: string }).r;
      out.push({ code: s.code, title: s.title, framework: s.framework, draftedBy: s.draftedBy, reason: 'revised_since_review', ...(reply ? { writerReply: reply } : {}) });
    }
  }
  return out;
}

export function reviewScript(db: DB, scriptCode: string, input: unknown, who: RunIdentity | undefined): { code: string; verdict: string; reviewer: string; status: string } {
  const w = needReviewer(who);
  const v = parse(ReviewInput, input);
  const notes = redact(v.notes).trim().slice(0, MAX_REVIEW_NOTES);
  if (v.verdict === 'changes_requested' && !notes) throw new HttpError(400, 'notes_required', 'Say what must change.');
  const id = scriptIdByCode(db, w.projectId, scriptCode);
  const row = db.prepare('SELECT * FROM automation_scripts WHERE id = ?').get(id) as Row;
  if (row.status !== 'draft') throw new HttpError(409, 'not_reviewable', `A ${String(row.status)} script no longer needs a review.`);
  if (row.drafted_by_run === w.runId || sameName(String(row.drafted_by_name), w.agentName)) {
    throw new HttpError(403, 'own_work', `${w.agentName} wrote this script, so ${w.agentName} cannot review it. A different reviewer must.`);
  }
  try {
    db.prepare('INSERT INTO automation_script_reviews (id, script_id, run_id, reviewer_name, verdict, notes, script_hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(newId('srev'), id, w.runId, w.agentName, v.verdict, notes, hashOf(row), nowIso());
  } catch (e) {
    if (/reviewer/.test(String((e as Error).message))) throw new HttpError(403, 'review_refused', 'The database refused this review.');
    throw e;
  }
  return { code: code(row.seq as number), verdict: v.verdict, reviewer: w.agentName, status: String(row.status) };
}

/** What an agent may read: the script by code, redacted again on the way out. */
export function readScriptForAgent(db: DB, projectId: string, scriptCode: string) {
  const d = getScript(db, scriptIdByCode(db, projectId, scriptCode));
  return { code: d.code, title: d.title, framework: d.framework, status: d.status, version: d.version, testCase: d.testCaseCode, draftedBy: d.draftedBy, content: redact(d.content), notes: redact(d.notes), review: d.review, writerReply: d.writerReply };
}

// ---------------------------------------------------------------------------- person
export function decideScript(db: DB, id: string, input: unknown, actor: Actor): ScriptDetail {
  if (actor !== 'human') throw new HttpError(403, 'human_required', 'Only a person can approve or reject a script');
  const v = parse(DecisionInput, input);
  const row = db.prepare('SELECT * FROM automation_scripts WHERE id = ?').get(id) as Row | undefined;
  if (!row) throw new HttpError(404, 'script_not_found');
  if (row.status !== 'draft') throw new HttpError(409, 'already_decided', `This script is already ${String(row.status)}.`);
  const note = redact(v.note).trim();
  if (v.to === 'rejected' && !note) throw new HttpError(400, 'note_required', 'Say why it is rejected.');
  const ts = nowIso();
  db.prepare("UPDATE automation_scripts SET status = ?, decided_by = 'human', decided_at = ?, decision_note = ?, updated_at = ? WHERE id = ?").run(v.to, ts, note, ts, id);
  return getScript(db, id);
}
