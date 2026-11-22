/**
 * Exploratory sessions and the task board (Pass 2C).
 *  - exploratory: a person plans, starts and completes a session; notes (note/bug/question/idea) can be added
 *    while it runs; a "bug" note can be turned into a defect (linked both ways)
 *  - tasks: six stages; nothing is ever auto-assigned; only a person marks a task COMPLETED (service + DB CHECK);
 *    BLOCKED and reopening a completed task need a reason; history is append-only
 * Every free-text field is redacted before it is stored.
 */
import { z } from 'zod';
import { checkTaskMove, DEFECT_PRIORITIES, EXPLORATORY_NOTE_KINDS, SEVERITIES, TASK_KINDS, TASK_STAGES, type Actor, type TaskStage } from '@qavo/shared';
import type { DB } from './db/index.ts';
import { clean, createDefect, needHuman, nextSeq, parse, requireProject, type DefectDTO } from './qaDefects.ts';
import { HttpError, newId } from './store.ts';

const nowIso = () => new Date().toISOString();
type Row = Record<string, unknown>;

// ---------------------------------------------------------------------------- exploratory sessions
const SessionInput = z
  .object({ charter: z.string().trim().min(1).max(1_000), area: z.string().trim().max(200).default(''), tester: z.string().trim().max(100).default(''), timeboxMinutes: z.number().int().min(5).max(480).default(60) })
  .strict();
const NoteInput = z.object({ kind: z.enum(EXPLORATORY_NOTE_KINDS).default('note'), text: z.string().trim().min(1).max(5_000) }).strict();
const CompleteInput = z.object({ summary: z.string().max(5_000).default('') }).strict();
const NoteDefectInput = z.object({ title: z.string().trim().min(1).max(200).optional(), severity: z.enum(SEVERITIES).default('major'), priority: z.enum(DEFECT_PRIORITIES).default('medium') }).strict();

export interface ExploratoryNoteDTO {
  id: string;
  kind: string;
  text: string;
  defectId: string | null;
  defectCode: string | null;
  createdBy: string;
  createdAt: string;
}
export interface ExploratoryDTO {
  id: string;
  projectId: string;
  code: string;
  charter: string;
  area: string;
  tester: string;
  timeboxMinutes: number;
  status: 'planned' | 'in_progress' | 'completed';
  summary: string;
  createdBy: string;
  createdAt: string;
  startedAt: string | null;
  endedAt: string | null;
  noteCount: number;
  bugCount: number;
}
export interface ExploratoryDetailDTO extends ExploratoryDTO {
  notes: ExploratoryNoteDTO[];
}

const SESSION_SELECT = `SELECT s.*,
    (SELECT COUNT(*) FROM exploratory_notes n WHERE n.session_id = s.id) AS note_count,
    (SELECT COUNT(*) FROM exploratory_notes n WHERE n.session_id = s.id AND n.kind = 'bug') AS bug_count
  FROM exploratory_sessions s`;
function sessionDto(r: Row): ExploratoryDTO {
  return {
    id: r.id as string,
    projectId: r.project_id as string,
    code: `EXP-${String(r.seq).padStart(3, '0')}`,
    charter: r.charter as string,
    area: r.area as string,
    tester: r.tester as string,
    timeboxMinutes: r.timebox_minutes as number,
    status: r.status as ExploratoryDTO['status'],
    summary: r.summary as string,
    createdBy: r.created_by as string,
    createdAt: r.created_at as string,
    startedAt: (r.started_at as string) ?? null,
    endedAt: (r.ended_at as string) ?? null,
    noteCount: r.note_count as number,
    bugCount: r.bug_count as number,
  };
}
function loadSession(db: DB, id: string): ExploratoryDTO {
  const r = db.prepare(`${SESSION_SELECT} WHERE s.id = ?`).get(id) as Row | undefined;
  if (!r) throw new HttpError(404, 'session_not_found');
  return sessionDto(r);
}

export function createSession(db: DB, projectId: string, input: unknown, actor: Actor): ExploratoryDTO {
  needHuman(actor);
  const v = parse(SessionInput, input);
  requireProject(db, projectId);
  const id = newId('exp');
  db.prepare('INSERT INTO exploratory_sessions (id, project_id, seq, charter, area, tester, timebox_minutes, status, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
    id,
    projectId,
    nextSeq(db, 'exploratory_sessions', projectId),
    clean(v.charter),
    clean(v.area),
    clean(v.tester),
    v.timeboxMinutes,
    'planned',
    'human',
    nowIso(),
  );
  return loadSession(db, id);
}

export function startSession(db: DB, id: string, actor: Actor): ExploratoryDTO {
  needHuman(actor);
  const s = loadSession(db, id);
  if (s.status !== 'planned') throw new HttpError(409, 'invalid_transition', 'Only a planned session can be started');
  db.prepare("UPDATE exploratory_sessions SET status = 'in_progress', started_at = ? WHERE id = ?").run(nowIso(), id);
  return loadSession(db, id);
}

export function completeSession(db: DB, id: string, input: unknown, actor: Actor): ExploratoryDTO {
  needHuman(actor);
  const v = parse(CompleteInput, input);
  const s = loadSession(db, id);
  if (s.status !== 'in_progress') throw new HttpError(409, 'invalid_transition', 'Only a running session can be completed');
  db.prepare("UPDATE exploratory_sessions SET status = 'completed', summary = ?, ended_at = ? WHERE id = ?").run(clean(v.summary), nowIso(), id);
  return loadSession(db, id);
}

export function addNote(db: DB, sessionId: string, input: unknown, actor: Actor): ExploratoryDetailDTO {
  if (actor !== 'human' && actor !== 'agent') throw new HttpError(403, 'forbidden');
  const v = parse(NoteInput, input);
  const s = loadSession(db, sessionId);
  if (s.status !== 'in_progress') throw new HttpError(409, 'session_not_running', 'Start the session before adding notes');
  db.prepare('INSERT INTO exploratory_notes (id, session_id, kind, text, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(newId('xn'), sessionId, v.kind, clean(v.text), actor, nowIso());
  return getSession(db, sessionId);
}

/** Turn a "bug" note into a defect (title defaults to the note text); the note keeps the link. */
export function raiseDefectFromNote(db: DB, noteId: string, input: unknown, actor: Actor): { defect: DefectDTO; session: ExploratoryDetailDTO } {
  if (actor !== 'human' && actor !== 'agent') throw new HttpError(403, 'forbidden');
  const v = parse(NoteDefectInput, input ?? {});
  const n = db
    .prepare('SELECT n.*, s.project_id, s.seq AS s_seq, s.charter FROM exploratory_notes n JOIN exploratory_sessions s ON s.id = n.session_id WHERE n.id = ?')
    .get(noteId) as Row | undefined;
  if (!n) throw new HttpError(404, 'note_not_found');
  if (n.kind !== 'bug') throw new HttpError(409, 'not_a_bug_note', 'Only a note of kind "bug" can be raised as a defect');
  if (n.defect_id) throw new HttpError(409, 'already_raised', 'A defect was already raised from this note');
  const text = n.text as string;
  const defect = db.transaction(() => {
    const d = createDefect(
      db,
      n.project_id as string,
      { title: v.title ?? (text.length > 120 ? `${text.slice(0, 117)}...` : text), description: text, severity: v.severity, priority: v.priority },
      actor,
    );
    db.prepare('UPDATE exploratory_notes SET defect_id = ? WHERE id = ?').run(d.id, noteId);
    return d;
  })();
  return { defect, session: getSession(db, n.session_id as string) };
}

export function listSessions(db: DB, projectId: string): ExploratoryDTO[] {
  return (db.prepare(`${SESSION_SELECT} WHERE s.project_id = ? ORDER BY s.seq DESC`).all(projectId) as Row[]).map(sessionDto);
}
export function getSession(db: DB, id: string): ExploratoryDetailDTO {
  const s = loadSession(db, id);
  const notes = (
    db
      .prepare('SELECT n.*, d.seq AS d_seq FROM exploratory_notes n LEFT JOIN defects d ON d.id = n.defect_id WHERE n.session_id = ? ORDER BY n.created_at, n.rowid')
      .all(id) as Row[]
  ).map((n) => ({
    id: n.id as string,
    kind: n.kind as string,
    text: n.text as string,
    defectId: (n.defect_id as string) ?? null,
    defectCode: n.d_seq ? `DEF-${String(n.d_seq).padStart(3, '0')}` : null,
    createdBy: n.created_by as string,
    createdAt: n.created_at as string,
  }));
  return { ...s, notes };
}

// ---------------------------------------------------------------------------- task board
const TaskFields = z
  .object({
    title: z.string().trim().min(1).max(200),
    description: z.string().max(5_000).default(''),
    kind: z.enum(TASK_KINDS).default('other'),
    priority: z.enum(DEFECT_PRIORITIES).default('medium'),
    assignee: z.string().trim().max(100).default(''),
    dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
    defectId: z.string().max(64).nullable().optional(),
    testCaseId: z.string().max(64).nullable().optional(),
  })
  .strict();
const TaskPatch = TaskFields.partial().strict();
const MoveInput = z.object({ to: z.enum(TASK_STAGES), note: z.string().max(2_000).default('') }).strict();

export interface TaskDTO {
  id: string;
  projectId: string;
  code: string;
  title: string;
  description: string;
  kind: string;
  priority: string;
  stage: TaskStage;
  assignee: string;
  dueDate: string | null;
  defectId: string | null;
  defectCode: string | null;
  testCaseId: string | null;
  testCaseCode: string | null;
  createdBy: string;
  completedBy: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
}
export interface TaskDetailDTO extends TaskDTO {
  history: Array<{ id: string; at: string; actor: string; action: string; fromStage: string | null; toStage: string | null; note: string }>;
}

const TASK_SELECT = `SELECT k.*, d.seq AS d_seq, t.code AS tc_code FROM tasks k LEFT JOIN defects d ON d.id = k.defect_id LEFT JOIN test_cases t ON t.id = k.test_case_id`;
function taskDto(r: Row): TaskDTO {
  return {
    id: r.id as string,
    projectId: r.project_id as string,
    code: `TSK-${String(r.seq).padStart(3, '0')}`,
    title: r.title as string,
    description: r.description as string,
    kind: r.kind as string,
    priority: r.priority as string,
    stage: r.stage as TaskStage,
    assignee: r.assignee as string,
    dueDate: (r.due_date as string) ?? null,
    defectId: (r.defect_id as string) ?? null,
    defectCode: r.d_seq ? `DEF-${String(r.d_seq).padStart(3, '0')}` : null,
    testCaseId: (r.test_case_id as string) ?? null,
    testCaseCode: (r.tc_code as string) ?? null,
    createdBy: r.created_by as string,
    completedBy: (r.completed_by as string) ?? null,
    completedAt: (r.completed_at as string) ?? null,
    createdAt: r.created_at as string,
    updatedAt: r.updated_at as string,
  };
}
function loadTask(db: DB, id: string): TaskDTO {
  const r = db.prepare(`${TASK_SELECT} WHERE k.id = ?`).get(id) as Row | undefined;
  if (!r) throw new HttpError(404, 'task_not_found');
  return taskDto(r);
}
function taskHistory(db: DB, taskId: string, actor: Actor, action: string, from: string | null, to: string | null, note = '') {
  db.prepare('INSERT INTO task_history (id, task_id, at, actor, action, from_stage, to_stage, note) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(newId('th'), taskId, nowIso(), actor, action, from, to, note);
}
function assertLinks(db: DB, projectId: string, defectId?: string | null, testCaseId?: string | null) {
  if (defectId) {
    const d = db.prepare('SELECT project_id FROM defects WHERE id = ?').get(defectId) as { project_id: string } | undefined;
    if (!d || d.project_id !== projectId) throw new HttpError(400, 'link_invalid', 'The defect is not in this project');
  }
  if (testCaseId) {
    const t = db.prepare('SELECT project_id FROM test_cases WHERE id = ?').get(testCaseId) as { project_id: string } | undefined;
    if (!t || t.project_id !== projectId) throw new HttpError(400, 'link_invalid', 'The test case is not in this project');
  }
}

export function createTask(db: DB, projectId: string, input: unknown, actor: Actor): TaskDTO {
  if (actor !== 'human' && actor !== 'agent') throw new HttpError(403, 'forbidden');
  const v = parse(TaskFields, input);
  requireProject(db, projectId);
  assertLinks(db, projectId, v.defectId, v.testCaseId);
  const id = newId('tsk');
  const ts = nowIso();
  db.transaction(() => {
    db.prepare(
      `INSERT INTO tasks (id, project_id, seq, title, description, kind, priority, stage, assignee, due_date, defect_id, test_case_id, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'backlog', ?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, projectId, nextSeq(db, 'tasks', projectId), clean(v.title), clean(v.description), v.kind, v.priority, clean(v.assignee), v.dueDate ?? null, v.defectId ?? null, v.testCaseId ?? null, actor, ts, ts);
    taskHistory(db, id, actor, 'created', null, 'backlog');
  })();
  return loadTask(db, id);
}

export function updateTask(db: DB, id: string, patch: unknown, actor: Actor): TaskDTO {
  needHuman(actor);
  const v = parse(TaskPatch, patch);
  const t = loadTask(db, id);
  assertLinks(db, t.projectId, v.defectId, v.testCaseId);
  const map: Record<string, string> = { title: 'title', description: 'description', kind: 'kind', priority: 'priority', assignee: 'assignee', dueDate: 'due_date', defectId: 'defect_id', testCaseId: 'test_case_id' };
  const sets: string[] = [];
  const args: unknown[] = [];
  const changed: string[] = [];
  for (const [k, val] of Object.entries(v)) {
    const next = typeof val === 'string' && !['kind', 'priority', 'dueDate', 'defectId', 'testCaseId'].includes(k) ? clean(val) : val;
    if ((t as unknown as Record<string, unknown>)[k] === next) continue;
    sets.push(`${map[k]} = ?`);
    args.push(next ?? null);
    changed.push(k);
  }
  if (changed.length === 0) return t;
  db.transaction(() => {
    db.prepare(`UPDATE tasks SET ${sets.join(', ')}, updated_at = ? WHERE id = ?`).run(...args, nowIso(), id);
    taskHistory(db, id, actor, 'edited', null, null, `Changed: ${changed.join(', ')}`);
  })();
  return loadTask(db, id);
}

export function moveTask(db: DB, id: string, input: unknown, actor: Actor): TaskDetailDTO {
  const v = parse(MoveInput, input);
  const t = loadTask(db, id);
  const check = checkTaskMove(t.stage, v.to, actor, v.note);
  if (!check.ok) throw new HttpError(check.code === 'human_required' ? 403 : check.code === 'unchanged' ? 409 : 422, check.code, check.message);
  const done = v.to === 'completed';
  const ts = nowIso();
  db.transaction(() => {
    db.prepare('UPDATE tasks SET stage = ?, completed_by = ?, completed_at = ?, updated_at = ? WHERE id = ?').run(v.to, done ? actor : null, done ? ts : null, ts, id);
    taskHistory(db, id, actor, 'moved', t.stage, v.to, clean(v.note));
  })();
  return getTask(db, id);
}

export function listTasks(db: DB, f: { projectId: string; stage?: string; assignee?: string }): TaskDTO[] {
  const where = ['k.project_id = ?'];
  const args: unknown[] = [f.projectId];
  if (f.stage) {
    where.push('k.stage = ?');
    args.push(f.stage);
  }
  if (f.assignee) {
    where.push('k.assignee = ?');
    args.push(f.assignee);
  }
  return (db.prepare(`${TASK_SELECT} WHERE ${where.join(' AND ')} ORDER BY k.seq`).all(...args) as Row[]).map(taskDto);
}

export function getTask(db: DB, id: string): TaskDetailDTO {
  const t = loadTask(db, id);
  const history = (db.prepare('SELECT * FROM task_history WHERE task_id = ? ORDER BY at, rowid').all(id) as Row[]).map((h) => ({
    id: h.id as string,
    at: h.at as string,
    actor: h.actor as string,
    action: h.action as string,
    fromStage: (h.from_stage as string) ?? null,
    toStage: (h.to_stage as string) ?? null,
    note: h.note as string,
  }));
  return { ...t, history };
}

export function taskSummary(db: DB, projectId?: string): { total: number; open: number; blocked: number } {
  const scope = projectId ? 'AND project_id = ?' : '';
  const args = projectId ? [projectId] : [];
  const c = (extra: string) => (db.prepare(`SELECT COUNT(*) AS c FROM tasks WHERE 1 = 1 ${scope} ${extra}`).get(...args) as { c: number }).c;
  return { total: c(''), open: c("AND stage <> 'completed'"), blocked: c("AND stage = 'blocked'") };
}
