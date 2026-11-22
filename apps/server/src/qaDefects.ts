/**
 * Defects service (Pass 2C). Rules enforced HERE (CLOSED/REJECTED/DUPLICATE by a human is also a DB CHECK):
 *  - only a person changes a defect's status; an agent may report a defect (status NEW) and comment,
 *    and edit only its own defect while it is still NEW
 *  - rejecting, marking duplicate, reopening and closing need a note
 *  - history is append-only; every free-text field is redacted before it is stored
 *  - a defect can be raised straight from a test execution (pre-filled, linked back to it)
 */
import { z } from 'zod';
import {
  checkDefectTransition,
  DEFECT_PRIORITIES,
  DEFECT_STATUSES,
  FINISHED_DEFECT_STATUSES,
  isOpenDefect,
  redact,
  SEVERITIES,
  type Actor,
  type DefectStatus,
} from '@qavo/shared';
import type { DB } from './db/index.ts';
import { HttpError, newId } from './store.ts';

const nowIso = () => new Date().toISOString();
type Row = Record<string, unknown>;

export function parse<T extends z.ZodTypeAny>(schema: T, input: unknown): z.infer<T> {
  const r = schema.safeParse(input);
  if (!r.success) {
    const fields = [...new Set(r.error.issues.map((i) => i.path.join('.') || '(root)'))].join(', ');
    throw new HttpError(400, 'invalid_input', `Invalid fields: ${fields}`);
  }
  return r.data;
}
export const needHuman = (actor: Actor) => {
  if (actor !== 'human') throw new HttpError(403, 'human_required', 'Only a person can do this');
};
export const clean = (s: string) => redact(s).trim();
export function requireProject(db: DB, projectId: string) {
  if (!db.prepare('SELECT 1 FROM projects WHERE id = ?').get(projectId)) throw new HttpError(404, 'project_not_found');
}
export const nextSeq = (db: DB, table: 'defects' | 'exploratory_sessions' | 'tasks', projectId: string): number =>
  ((db.prepare(`SELECT COALESCE(MAX(seq), 0) AS m FROM ${table} WHERE project_id = ?`).get(projectId) as { m: number }).m ?? 0) + 1;

// ---------------------------------------------------------------------------- schemas
const DefectFields = z
  .object({
    title: z.string().trim().min(1).max(200),
    description: z.string().max(10_000).default(''),
    steps: z.string().max(10_000).default(''),
    expectedResult: z.string().max(5_000).default(''),
    actualResult: z.string().max(5_000).default(''),
    environment: z.string().trim().max(120).default(''),
    build: z.string().trim().max(120).default(''),
    severity: z.enum(SEVERITIES).default('major'),
    priority: z.enum(DEFECT_PRIORITIES).default('medium'),
    assignee: z.string().trim().max(100).default(''),
    testCaseId: z.string().max(64).optional(),
    executionId: z.string().max(64).optional(),
  })
  .strict();
const DefectPatch = DefectFields.omit({ testCaseId: true, executionId: true }).partial().strict();
const FromExecutionInput = DefectFields.omit({ testCaseId: true, executionId: true }).partial().strict();
const TransitionInput = z.object({ to: z.enum(DEFECT_STATUSES), note: z.string().max(5_000).default(''), duplicateOfId: z.string().max(64).optional() }).strict();
const CommentInput = z.object({ note: z.string().trim().min(1).max(5_000) }).strict();

// ---------------------------------------------------------------------------- DTOs
export interface DefectDTO {
  id: string;
  projectId: string;
  code: string;
  title: string;
  description: string;
  steps: string;
  expectedResult: string;
  actualResult: string;
  environment: string;
  build: string;
  severity: string;
  priority: string;
  status: DefectStatus;
  assignee: string;
  testCaseId: string | null;
  testCaseCode: string | null;
  executionId: string | null;
  runCode: string | null;
  duplicateOfId: string | null;
  duplicateOfCode: string | null;
  reportedBy: string;
  closedBy: string | null;
  closedAt: string | null;
  createdAt: string;
  updatedAt: string;
}
export interface DefectHistoryDTO {
  id: string;
  at: string;
  actor: string;
  action: string;
  fromStatus: string | null;
  toStatus: string | null;
  note: string;
}
export interface DefectDetailDTO extends DefectDTO {
  history: DefectHistoryDTO[];
}

const DEFECT_SELECT = `SELECT d.*, t.code AS tc_code, r.seq AS run_seq, dup.seq AS dup_seq
  FROM defects d
  LEFT JOIN test_cases t ON t.id = d.test_case_id
  LEFT JOIN test_executions e ON e.id = d.execution_id
  LEFT JOIN test_runs r ON r.id = e.run_id
  LEFT JOIN defects dup ON dup.id = d.duplicate_of_id`;
const defectCode = (seq: number) => `DEF-${String(seq).padStart(3, '0')}`;

function defectDto(r: Row): DefectDTO {
  return {
    id: r.id as string,
    projectId: r.project_id as string,
    code: defectCode(r.seq as number),
    title: r.title as string,
    description: r.description as string,
    steps: r.steps as string,
    expectedResult: r.expected_result as string,
    actualResult: r.actual_result as string,
    environment: r.environment as string,
    build: r.build as string,
    severity: r.severity as string,
    priority: r.priority as string,
    status: r.status as DefectStatus,
    assignee: r.assignee as string,
    testCaseId: (r.test_case_id as string) ?? null,
    testCaseCode: (r.tc_code as string) ?? null,
    executionId: (r.execution_id as string) ?? null,
    runCode: r.run_seq ? `RUN-${String(r.run_seq).padStart(3, '0')}` : null,
    duplicateOfId: (r.duplicate_of_id as string) ?? null,
    duplicateOfCode: r.dup_seq ? defectCode(r.dup_seq as number) : null,
    reportedBy: r.reported_by as string,
    closedBy: (r.closed_by as string) ?? null,
    closedAt: (r.closed_at as string) ?? null,
    createdAt: r.created_at as string,
    updatedAt: r.updated_at as string,
  };
}
function loadDefect(db: DB, id: string): DefectDTO {
  const r = db.prepare(`${DEFECT_SELECT} WHERE d.id = ?`).get(id) as Row | undefined;
  if (!r) throw new HttpError(404, 'defect_not_found');
  return defectDto(r);
}
export function defectHistory(db: DB, defectId: string, actor: Actor, action: string, from: string | null, to: string | null, note = '') {
  db.prepare('INSERT INTO defect_history (id, defect_id, at, actor, action, from_status, to_status, note) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(newId('dh'), defectId, nowIso(), actor, action, from, to, note);
}

// ---------------------------------------------------------------------------- create
function insertDefect(db: DB, projectId: string, v: z.infer<typeof DefectFields>, actor: Actor, testCaseId: string | null, executionId: string | null, note: string): string {
  const id = newId('def');
  const ts = nowIso();
  db.prepare(
    `INSERT INTO defects (id, project_id, seq, title, description, steps, expected_result, actual_result, environment, build, severity, priority, status, assignee, test_case_id, execution_id, reported_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'new', ?, ?, ?, ?, ?, ?)`,
  ).run(id, projectId, nextSeq(db, 'defects', projectId), clean(v.title), clean(v.description), clean(v.steps), clean(v.expectedResult), clean(v.actualResult), clean(v.environment), clean(v.build), v.severity, v.priority, clean(v.assignee), testCaseId, executionId, actor, ts, ts);
  defectHistory(db, id, actor, 'created', null, 'new', note);
  return id;
}

export function createDefect(db: DB, projectId: string, input: unknown, actor: Actor): DefectDTO {
  if (actor !== 'human' && actor !== 'agent') throw new HttpError(403, 'forbidden');
  const v = parse(DefectFields, input);
  requireProject(db, projectId);
  let testCaseId = v.testCaseId ?? null;
  let executionId: string | null = null;
  if (v.executionId) {
    const e = db.prepare('SELECT e.id, e.test_case_id, r.project_id FROM test_executions e JOIN test_runs r ON r.id = e.run_id WHERE e.id = ?').get(v.executionId) as
      | { id: string; test_case_id: string; project_id: string }
      | undefined;
    if (!e || e.project_id !== projectId) throw new HttpError(400, 'link_invalid', 'The test execution is not in this project');
    executionId = e.id;
    testCaseId = testCaseId ?? e.test_case_id;
  }
  if (testCaseId) {
    const t = db.prepare('SELECT project_id FROM test_cases WHERE id = ?').get(testCaseId) as { project_id: string } | undefined;
    if (!t || t.project_id !== projectId) throw new HttpError(400, 'link_invalid', 'The test case is not in this project');
  }
  const id = db.transaction(() => insertDefect(db, projectId, v, actor, testCaseId, executionId, ''))();
  return loadDefect(db, id);
}

/** Raise a defect from a test execution: title, steps, expected and actual result are pre-filled and can be overridden. */
export function createDefectFromExecution(db: DB, executionId: string, input: unknown, actor: Actor): DefectDTO {
  if (actor !== 'human' && actor !== 'agent') throw new HttpError(403, 'forbidden');
  const o = parse(FromExecutionInput, input ?? {});
  const e = db
    .prepare(
      `SELECT e.id, e.status, e.note, e.actual_result, t.id AS tc_id, t.code, t.title, t.steps_json, t.expected_result, r.project_id, r.environment, r.build
       FROM test_executions e JOIN test_cases t ON t.id = e.test_case_id JOIN test_runs r ON r.id = e.run_id WHERE e.id = ?`,
    )
    .get(executionId) as Row | undefined;
  if (!e) throw new HttpError(404, 'execution_not_found');
  let steps: string[] = [];
  try {
    steps = JSON.parse(e.steps_json as string) as string[];
  } catch {
    steps = [];
  }
  const merged = parse(DefectFields, {
    title: o.title ?? `${e.code as string}: ${e.title as string} failed`,
    description: o.description ?? '',
    steps: o.steps ?? steps.map((s, i) => `${i + 1}. ${s}`).join('\n'),
    expectedResult: o.expectedResult ?? (e.expected_result as string),
    actualResult: o.actualResult ?? ((e.actual_result as string) || (e.note as string)),
    environment: o.environment ?? (e.environment as string),
    build: o.build ?? (e.build as string),
    severity: o.severity ?? 'major',
    priority: o.priority ?? 'medium',
    assignee: o.assignee ?? '',
  });
  const id = db.transaction(() => insertDefect(db, e.project_id as string, merged, actor, e.tc_id as string, executionId, `Raised from ${e.code as string}`))();
  return loadDefect(db, id);
}

// ---------------------------------------------------------------------------- edit, comment, transition
export function updateDefect(db: DB, id: string, patch: unknown, actor: Actor): DefectDTO {
  const v = parse(DefectPatch, patch);
  const d = loadDefect(db, id);
  if (actor !== 'human') {
    if (actor !== 'agent' || d.reportedBy !== 'agent' || d.status !== 'new') throw new HttpError(403, 'human_required', 'Only a person can edit this defect');
  }
  if (FINISHED_DEFECT_STATUSES.includes(d.status)) throw new HttpError(409, 'defect_finished', 'Reopen the defect before editing it');
  const cols: Record<string, string> = { title: 'title', description: 'description', steps: 'steps', expectedResult: 'expected_result', actualResult: 'actual_result', environment: 'environment', build: 'build', severity: 'severity', priority: 'priority', assignee: 'assignee' };
  const sets: string[] = [];
  const args: unknown[] = [];
  const changed: string[] = [];
  for (const [k, val] of Object.entries(v) as Array<[string, string]>) {
    const next = ['severity', 'priority'].includes(k) ? val : clean(val);
    if ((d as unknown as Record<string, string>)[k] === next) continue;
    sets.push(`${cols[k]} = ?`);
    args.push(next);
    changed.push(k);
  }
  if (changed.length === 0) return d;
  db.transaction(() => {
    db.prepare(`UPDATE defects SET ${sets.join(', ')}, updated_at = ? WHERE id = ?`).run(...args, nowIso(), id);
    defectHistory(db, id, actor, 'edited', null, null, `Changed: ${changed.join(', ')}`);
  })();
  return loadDefect(db, id);
}

export function addDefectComment(db: DB, id: string, input: unknown, actor: Actor): DefectDetailDTO {
  if (actor !== 'human' && actor !== 'agent') throw new HttpError(403, 'forbidden');
  const v = parse(CommentInput, input);
  loadDefect(db, id);
  defectHistory(db, id, actor, 'comment', null, null, clean(v.note));
  return getDefect(db, id);
}

export function transitionDefect(db: DB, id: string, input: unknown, actor: Actor): DefectDetailDTO {
  const v = parse(TransitionInput, input);
  const d = loadDefect(db, id);
  const check = checkDefectTransition(d.status, v.to, actor, v.note);
  if (!check.ok) throw new HttpError(check.code === 'human_required' ? 403 : check.code === 'invalid_transition' ? 409 : 422, check.code, check.message);
  let dupId: string | null = null;
  if (v.to === 'duplicate') {
    if (!v.duplicateOfId) throw new HttpError(422, 'duplicate_of_required', 'Say which defect this duplicates');
    const o = db.prepare('SELECT project_id FROM defects WHERE id = ?').get(v.duplicateOfId) as { project_id: string } | undefined;
    if (!o || o.project_id !== d.projectId || v.duplicateOfId === id) throw new HttpError(400, 'link_invalid', 'Pick another defect from the same project');
    dupId = v.duplicateOfId;
  }
  const finished = FINISHED_DEFECT_STATUSES.includes(v.to);
  const ts = nowIso();
  db.transaction(() => {
    db.prepare('UPDATE defects SET status = ?, closed_by = ?, closed_at = ?, duplicate_of_id = ?, updated_at = ? WHERE id = ?').run(v.to, finished ? actor : null, finished ? ts : null, dupId, ts, id);
    defectHistory(db, id, actor, 'status', d.status, v.to, clean(v.note));
  })();
  return getDefect(db, id);
}

// ---------------------------------------------------------------------------- queries
export interface DefectFilters {
  projectId: string;
  status?: string;
  severity?: string;
  executionId?: string;
  testCaseId?: string;
  openOnly?: boolean;
  q?: string;
}
export function listDefects(db: DB, f: DefectFilters): DefectDTO[] {
  const where = ['d.project_id = ?'];
  const args: unknown[] = [f.projectId];
  const add = (clause: string, value: string | undefined) => {
    if (value) {
      where.push(clause);
      args.push(value);
    }
  };
  add('d.status = ?', f.status);
  add('d.severity = ?', f.severity);
  add('d.execution_id = ?', f.executionId);
  add('d.test_case_id = ?', f.testCaseId);
  if (f.openOnly) where.push("d.status NOT IN ('closed','rejected','duplicate')");
  if (f.q?.trim()) {
    const like = `%${f.q.trim().toLowerCase().replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
    where.push("(lower(d.title) LIKE ? ESCAPE '\\' OR lower(d.description) LIKE ? ESCAPE '\\')");
    args.push(like, like);
  }
  return (db.prepare(`${DEFECT_SELECT} WHERE ${where.join(' AND ')} ORDER BY d.seq DESC`).all(...args) as Row[]).map(defectDto);
}

export function getDefect(db: DB, id: string): DefectDetailDTO {
  const d = loadDefect(db, id);
  const history = (db.prepare('SELECT * FROM defect_history WHERE defect_id = ? ORDER BY at, rowid').all(id) as Row[]).map((h) => ({
    id: h.id as string,
    at: h.at as string,
    actor: h.actor as string,
    action: h.action as string,
    fromStatus: (h.from_status as string) ?? null,
    toStatus: (h.to_status as string) ?? null,
    note: h.note as string,
  }));
  return { ...d, history };
}

export interface DefectSummary {
  total: number;
  /** Not closed, rejected or duplicate. */
  open: number;
  openBySeverity: Record<string, number>;
}
export function defectSummary(db: DB, projectId?: string): DefectSummary {
  const scope = projectId ? 'AND project_id = ?' : '';
  const args = projectId ? [projectId] : [];
  const total = (db.prepare(`SELECT COUNT(*) AS c FROM defects WHERE 1 = 1 ${scope}`).get(...args) as { c: number }).c;
  const rows = db.prepare(`SELECT severity, status, COUNT(*) AS c FROM defects WHERE 1 = 1 ${scope} GROUP BY severity, status`).all(...args) as Array<{ severity: string; status: DefectStatus; c: number }>;
  const openBySeverity: Record<string, number> = { critical: 0, major: 0, minor: 0, trivial: 0 };
  let open = 0;
  for (const r of rows) {
    if (isOpenDefect(r.status)) {
      open += r.c;
      openBySeverity[r.severity] = (openBySeverity[r.severity] ?? 0) + r.c;
    }
  }
  return { total, open, openBySeverity };
}
