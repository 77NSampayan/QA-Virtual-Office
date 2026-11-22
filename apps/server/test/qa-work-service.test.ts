import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb, type DB } from '../src/db/index.ts';
import * as qa from '../src/qa.ts';
import * as df from '../src/qaDefects.ts';
import * as ex from '../src/qaExec.ts';
import * as wk from '../src/qaWork.ts';
import { createProject, deleteProject, HttpError } from '../src/store.ts';

let db: DB;
let root: string;
let projectId: string;
let otherProjectId: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'qavo-work-'));
  db = openDb(path.join(root, 'test.db'));
  const mk = (name: string) => {
    const dir = path.join(root, name);
    fs.mkdirSync(dir);
    return createProject(db, { alias: name, path: dir }).project.id;
  };
  projectId = mk('Alpha');
  otherProjectId = mk('Beta');
});
afterEach(() => {
  db.close();
  fs.rmSync(root, { recursive: true, force: true });
});

function http(fn: () => unknown, status: number, code?: string) {
  try {
    fn();
  } catch (e) {
    expect(e, `expected HttpError, got ${String(e)}`).toBeInstanceOf(HttpError);
    expect((e as HttpError).status).toBe(status);
    if (code) expect((e as HttpError).code).toBe(code);
    return e as HttpError;
  }
  throw new Error(`expected HttpError ${status}${code ? ' ' + code : ''}, but nothing was thrown`);
}
const defect = (extra: object = {}, pid = projectId, actor: 'human' | 'agent' = 'human') => df.createDefect(db, pid, { title: 'Login fails', severity: 'major', ...extra }, actor);
const go = (id: string, to: string, note = 'ok', actor: 'human' | 'agent' | 'system' = 'human', extra: object = {}) => df.transitionDefect(db, id, { to, note, ...extra }, actor);
function failedExecution() {
  const t = qa.createTestCase(db, projectId, { title: 'Lockout', steps: ['Open', 'Fail 5 times'], expectedResult: 'Locked' }, 'human');
  qa.transitionTestCase(db, t.id, 'in_review', '', 'human');
  qa.transitionTestCase(db, t.id, 'approved', 'ok', 'human');
  const run = ex.createRun(db, projectId, { name: 'Sprint 1', environment: 'staging', build: '1.0.3', addAllApproved: true }, 'human');
  const e = ex.getRun(db, run.id).executions[0]!;
  ex.setResult(db, e.id, { status: 'failed', note: 'Not locked', actualResult: 'Account stayed open' }, 'human');
  return { t, e, run };
}

describe('defects: create and edit', () => {
  it('creates a NEW defect with a code, history and redacted text', () => {
    const d = defect({ description: 'Seen by jane.doe@example.com with key sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789' });
    expect(d).toMatchObject({ code: 'DEF-001', status: 'new', reportedBy: 'human', severity: 'major' });
    expect(d.description).not.toContain('jane.doe@example.com');
    expect(d.description).not.toContain('sk-ant-');
    expect(defect().code).toBe('DEF-002');
    expect(df.getDefect(db, d.id).history.map((h) => `${h.action}:${h.actor}`)).toEqual(['created:human']);
  });
  it('validates input: unknown fields, bad enums, empty title, unknown project, foreign links', () => {
    http(() => df.createDefect(db, projectId, { title: '' }, 'human'), 400, 'invalid_input');
    http(() => df.createDefect(db, projectId, { title: 'x', severity: 'huge' }, 'human'), 400, 'invalid_input');
    http(() => df.createDefect(db, projectId, { title: 'x', status: 'closed' }, 'human'), 400, 'invalid_input');
    http(() => df.createDefect(db, 'nope', { title: 'x' }, 'human'), 404, 'project_not_found');
    http(() => df.createDefect(db, projectId, { title: 'x', testCaseId: 'nope' }, 'human'), 400, 'link_invalid');
    http(() => df.createDefect(db, projectId, { title: 'x', executionId: 'nope' }, 'human'), 400, 'link_invalid');
    http(() => df.createDefect(db, projectId, { title: 'x' }, 'system'), 403, 'forbidden');
  });
  it('an agent can report a defect and comment, and edit only its own NEW defect', () => {
    const mine = defect({}, projectId, 'agent');
    expect(mine.reportedBy).toBe('agent');
    expect(df.updateDefect(db, mine.id, { title: 'Better title' }, 'agent').title).toBe('Better title');
    df.addDefectComment(db, mine.id, { note: 'Reproduced twice' }, 'agent');
    const human = defect();
    http(() => df.updateDefect(db, human.id, { title: 'hijack' }, 'agent'), 403, 'human_required');
    go(mine.id, 'open');
    http(() => df.updateDefect(db, mine.id, { title: 'late edit' }, 'agent'), 403, 'human_required');
    expect(df.updateDefect(db, mine.id, { severity: 'critical' }, 'human').severity).toBe('critical');
  });
  it('edits are recorded by field name; finished defects cannot be edited', () => {
    const d = defect();
    df.updateDefect(db, d.id, { severity: 'critical', assignee: 'Sam' }, 'human');
    expect(df.getDefect(db, d.id).history.at(-1)).toMatchObject({ action: 'edited', note: 'Changed: severity, assignee' });
    go(d.id, 'rejected');
    http(() => df.updateDefect(db, d.id, { title: 'x' }, 'human'), 409, 'defect_finished');
  });
});

describe('defects: status workflow', () => {
  it('walks to CLOSED with history; closed_by and closed_at are recorded', () => {
    const d = defect();
    for (const to of ['open', 'in_progress', 'fixed', 'retest']) go(d.id, to);
    const closed = go(d.id, 'closed', 'Verified in 1.0.4');
    expect(closed).toMatchObject({ status: 'closed', closedBy: 'human' });
    expect(closed.closedAt).toMatch(/^\d{4}-/);
    expect(closed.history.map((h) => h.toStatus)).toEqual(['new', 'open', 'in_progress', 'fixed', 'retest', 'closed']);
  });
  it('an agent can NEVER change a status, close, reject or reopen', () => {
    const d = defect();
    for (const actor of ['agent', 'system'] as const) http(() => go(d.id, 'open', 'x', actor), 403, 'human_required');
    expect(df.getDefect(db, d.id).status).toBe('new');
  });
  it('refuses skipped steps and requires notes', () => {
    const d = defect();
    http(() => go(d.id, 'closed'), 409, 'invalid_transition');
    http(() => go(d.id, 'rejected', ''), 422, 'note_required');
    go(d.id, 'open', '');
    go(d.id, 'in_progress', '');
    go(d.id, 'fixed', '');
    go(d.id, 'retest', '');
    http(() => go(d.id, 'closed', ' '), 422, 'note_required');
  });
  it('reopening a closed defect clears the closure; duplicates must point at another defect in the same project', () => {
    const d = defect();
    const other = defect({ title: 'Original' });
    const foreign = defect({ title: 'Elsewhere' }, otherProjectId);
    http(() => go(d.id, 'duplicate', 'same', 'human'), 422, 'duplicate_of_required');
    http(() => go(d.id, 'duplicate', 'same', 'human', { duplicateOfId: d.id }), 400, 'link_invalid');
    http(() => go(d.id, 'duplicate', 'same', 'human', { duplicateOfId: foreign.id }), 400, 'link_invalid');
    const dup = go(d.id, 'duplicate', 'same bug', 'human', { duplicateOfId: other.id });
    expect(dup).toMatchObject({ status: 'duplicate', duplicateOfCode: 'DEF-002', closedBy: 'human' });
    const re = go(d.id, 'reopened', 'It is different after all');
    expect(re).toMatchObject({ status: 'reopened', closedBy: null, closedAt: null, duplicateOfId: null });
  });
  it('the database refuses a closed/rejected/duplicate defect not recorded by a human', () => {
    const d = defect();
    const ts = new Date().toISOString();
    const up = (status: string, by: string | null) => () => db.prepare('UPDATE defects SET status = ?, closed_by = ?, closed_at = ? WHERE id = ?').run(status, by, ts, d.id);
    for (const s of ['closed', 'rejected', 'duplicate']) {
      expect(up(s, 'agent')).toThrow(/CHECK/);
      expect(up(s, 'system')).toThrow(/CHECK/);
      expect(up(s, null)).toThrow(/CHECK/);
    }
    expect(up('closed', 'human')).not.toThrow();
  });
  it('history is append-only', () => {
    defect();
    expect(() => db.prepare("UPDATE defect_history SET note = 'x'").run()).toThrow(/append-only/);
    expect(() => db.prepare('DELETE FROM defect_history').run()).toThrow(/append-only/);
  });
});

describe('defects raised from a failed test', () => {
  it('pre-fills title, steps, expected and actual result, environment and build, and links the execution', () => {
    const { e } = failedExecution();
    const d = df.createDefectFromExecution(db, e.id, {}, 'human');
    expect(d).toMatchObject({ executionId: e.id, testCaseCode: 'TC-0001', runCode: 'RUN-001', environment: 'staging', build: '1.0.3', expectedResult: 'Locked', actualResult: 'Account stayed open' });
    expect(d.title).toBe('TC-0001: Lockout failed');
    expect(d.steps).toBe('1. Open\n2. Fail 5 times');
    expect(df.listDefects(db, { projectId, executionId: e.id })).toHaveLength(1);
    expect(df.getDefect(db, d.id).history[0]!.note).toBe('Raised from TC-0001');
  });
  it('lets the person override the pre-filled values and refuses unknown executions', () => {
    const { e } = failedExecution();
    expect(df.createDefectFromExecution(db, e.id, { title: 'Account not locked', severity: 'critical' }, 'human')).toMatchObject({ title: 'Account not locked', severity: 'critical' });
    http(() => df.createDefectFromExecution(db, 'nope', {}, 'human'), 404, 'execution_not_found');
  });
  it('a linked test case or execution is protected by SET NULL, never deleted with the defect', () => {
    const { t } = failedExecution();
    const d = defect({ testCaseId: t.id });
    expect(d.testCaseCode).toBe('TC-0001');
  });
});

describe('defect queries and figures', () => {
  it('filters and counts open defects by severity; finished ones are not open', () => {
    const a = defect({ title: 'A crash', severity: 'critical' });
    defect({ title: 'B typo', severity: 'trivial' });
    const c = defect({ title: 'C layout', severity: 'minor' });
    go(c.id, 'rejected');
    expect(df.listDefects(db, { projectId, severity: 'critical' }).map((x) => x.id)).toEqual([a.id]);
    expect(df.listDefects(db, { projectId, openOnly: true })).toHaveLength(2);
    expect(df.listDefects(db, { projectId, q: 'LAYOUT' })).toHaveLength(1);
    expect(df.defectSummary(db)).toEqual({ total: 3, open: 2, openBySeverity: { critical: 1, major: 0, minor: 0, trivial: 1 } });
    expect(df.defectSummary(db, otherProjectId).total).toBe(0);
    expect(qa.qaSummary(db).defects.open).toBe(2);
  });
  it('a project that has defects cannot be removed, only archived', () => {
    defect();
    http(() => deleteProject(db, projectId), 409, 'project_has_qa_data');
  });
});

describe('exploratory sessions', () => {
  const session = () => wk.createSession(db, projectId, { charter: 'Explore checkout with odd inputs', area: 'Checkout', timeboxMinutes: 45 }, 'human');
  it('plan → start → notes → complete, human only for the lifecycle', () => {
    const s = session();
    expect(s).toMatchObject({ code: 'EXP-001', status: 'planned', timeboxMinutes: 45 });
    http(() => wk.addNote(db, s.id, { text: 'too early' }, 'human'), 409, 'session_not_running');
    http(() => wk.startSession(db, s.id, 'agent'), 403, 'human_required');
    expect(wk.startSession(db, s.id, 'human').status).toBe('in_progress');
    http(() => wk.startSession(db, s.id, 'human'), 409, 'invalid_transition');
    wk.addNote(db, s.id, { kind: 'idea', text: 'Try 0 quantity' }, 'human');
    const d = wk.addNote(db, s.id, { kind: 'bug', text: 'Total shows NaN with quantity 0' }, 'agent');
    expect(d.notes.map((n) => `${n.kind}:${n.createdBy}`)).toEqual(['idea:human', 'bug:agent']);
    http(() => wk.completeSession(db, s.id, { summary: 'x' }, 'agent'), 403, 'human_required');
    expect(wk.completeSession(db, s.id, { summary: 'Found one bug' }, 'human')).toMatchObject({ status: 'completed', summary: 'Found one bug', noteCount: 2, bugCount: 1 });
    http(() => wk.addNote(db, s.id, { text: 'after the end' }, 'human'), 409, 'session_not_running');
  });
  it('a bug note becomes a linked defect once; other note kinds cannot', () => {
    const s = session();
    wk.startSession(db, s.id, 'human');
    wk.addNote(db, s.id, { kind: 'note', text: 'just a note' }, 'human');
    const detail = wk.addNote(db, s.id, { kind: 'bug', text: 'Total shows NaN with quantity 0' }, 'human');
    const [plain, bug] = detail.notes;
    http(() => wk.raiseDefectFromNote(db, plain!.id, {}, 'human'), 409, 'not_a_bug_note');
    const r = wk.raiseDefectFromNote(db, bug!.id, { severity: 'critical' }, 'human');
    expect(r.defect).toMatchObject({ code: 'DEF-001', status: 'new', severity: 'critical', title: 'Total shows NaN with quantity 0' });
    expect(r.session.notes.find((n) => n.id === bug!.id)).toMatchObject({ defectCode: 'DEF-001' });
    http(() => wk.raiseDefectFromNote(db, bug!.id, {}, 'human'), 409, 'already_raised');
  });
  it('validates input and redacts text', () => {
    http(() => wk.createSession(db, projectId, { charter: '' }, 'human'), 400, 'invalid_input');
    http(() => wk.createSession(db, projectId, { charter: 'x', timeboxMinutes: 1 }, 'human'), 400, 'invalid_input');
    http(() => wk.createSession(db, projectId, { charter: 'x' }, 'agent'), 403, 'human_required');
    const s = wk.createSession(db, projectId, { charter: 'Check jane.doe@example.com flows' }, 'human');
    expect(s.charter).not.toContain('jane.doe@example.com');
    expect(wk.listSessions(db, projectId)).toHaveLength(1);
    expect(wk.listSessions(db, otherProjectId)).toHaveLength(0);
  });
});

describe('task board', () => {
  const task = (extra: object = {}, actor: 'human' | 'agent' = 'human') => wk.createTask(db, projectId, { title: 'Write checkout tests', ...extra }, actor);
  const mv = (id: string, to: string, note = '', actor: 'human' | 'agent' = 'human') => wk.moveTask(db, id, { to, note }, actor);
  it('creates in Backlog, never auto-assigned, with history', () => {
    const t = task();
    expect(t).toMatchObject({ code: 'TSK-001', stage: 'backlog', assignee: '', priority: 'medium', createdBy: 'human' });
    expect(wk.getTask(db, t.id).history.map((h) => `${h.action}:${h.toStage}`)).toEqual(['created:backlog']);
    expect(task({ assignee: 'Manual QA – Unit 3' }).assignee).toBe('Manual QA – Unit 3');
  });
  it('moves through the six stages; blocking needs a reason; only a person completes', () => {
    const t = task();
    for (const to of ['ready', 'in_progress', 'waiting_review']) mv(t.id, to);
    http(() => mv(t.id, 'completed', '', 'agent'), 403, 'human_required');
    http(() => mv(t.id, 'blocked'), 422, 'note_required');
    expect(mv(t.id, 'blocked', 'Waiting for test data').stage).toBe('blocked');
    mv(t.id, 'in_progress');
    const done = mv(t.id, 'completed');
    expect(done).toMatchObject({ stage: 'completed', completedBy: 'human' });
    http(() => mv(t.id, 'in_progress'), 422, 'note_required');
    expect(mv(t.id, 'in_progress', 'More cases needed').completedAt).toBeNull();
    http(() => mv(t.id, 'in_progress', 'again'), 409, 'unchanged');
  });
  it('an agent can create a task and move it, but cannot complete it', () => {
    const t = task({}, 'agent');
    expect(t.createdBy).toBe('agent');
    expect(mv(t.id, 'ready', '', 'agent').stage).toBe('ready');
    http(() => mv(t.id, 'completed', 'done', 'agent'), 403, 'human_required');
  });
  it('the database refuses a COMPLETED task not recorded by a human', () => {
    const t = task();
    const ts = new Date().toISOString();
    const up = (by: string | null) => () => db.prepare("UPDATE tasks SET stage = 'completed', completed_by = ?, completed_at = ? WHERE id = ?").run(by, ts, t.id);
    expect(up('agent')).toThrow(/CHECK/);
    expect(up(null)).toThrow(/CHECK/);
    expect(up('human')).not.toThrow();
  });
  it('validates links and fields; edits are human-only and recorded', () => {
    const foreign = defect({}, otherProjectId);
    http(() => task({ defectId: foreign.id }), 400, 'link_invalid');
    http(() => task({ dueDate: '22/11/2026' }), 400, 'invalid_input');
    http(() => task({ stage: 'completed' }), 400, 'invalid_input');
    const own = defect();
    const t = task({ defectId: own.id, dueDate: '2026-12-01' });
    expect(t).toMatchObject({ defectCode: 'DEF-001', dueDate: '2026-12-01' });
    http(() => wk.updateTask(db, t.id, { title: 'x' }, 'agent'), 403, 'human_required');
    wk.updateTask(db, t.id, { assignee: 'Sam', priority: 'high' }, 'human');
    expect(wk.getTask(db, t.id).history.at(-1)).toMatchObject({ action: 'edited', note: 'Changed: priority, assignee' });
    expect(wk.updateTask(db, t.id, { dueDate: null }, 'human').dueDate).toBeNull();
  });
  it('lists by stage and counts open and blocked tasks', () => {
    const a = task({ title: 'A' });
    const b = task({ title: 'B' });
    task({ title: 'C' });
    mv(b.id, 'blocked', 'Needs data');
    mv(a.id, 'completed');
    expect(wk.listTasks(db, { projectId, stage: 'blocked' }).map((x) => x.id)).toEqual([b.id]);
    expect(wk.taskSummary(db)).toEqual({ total: 3, open: 2, blocked: 1 });
    http(() => deleteProject(db, projectId), 409, 'project_has_qa_data');
  });
});
