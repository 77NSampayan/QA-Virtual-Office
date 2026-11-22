import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb, type DB } from '../src/db/index.ts';
import * as qa from '../src/qa.ts';
import * as ex from '../src/qaExec.ts';
import { createProject, HttpError } from '../src/store.ts';

let db: DB;
let root: string;
let evidenceDir: string;
let projectId: string;
let otherProjectId: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'qavo-exec-'));
  evidenceDir = path.join(root, 'evidence');
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

function approvedCase(title: string, pid = projectId) {
  const t = qa.createTestCase(db, pid, { title, steps: ['Open the page', 'Do it'], expectedResult: 'It works' }, 'human');
  qa.transitionTestCase(db, t.id, 'in_review', '', 'human');
  return qa.transitionTestCase(db, t.id, 'approved', 'ok', 'human');
}
function draftCase(title: string) {
  return qa.createTestCase(db, projectId, { title, steps: ['a'], expectedResult: 'b' }, 'human');
}
function run(ids: string[], extra: object = {}) {
  return ex.createRun(db, projectId, { name: 'Sprint 1', environment: 'staging', build: '1.0.3', testCaseIds: ids, ...extra }, 'human');
}
const firstExec = (runId: string) => ex.getRun(db, runId).executions[0]!;

describe('test runs', () => {
  it('only APPROVED, non-archived test cases are added; others are reported as skipped, not silently dropped', () => {
    const a = approvedCase('A');
    const d = draftCase('D');
    const r = run([a.id, d.id]);
    expect(r.counts).toMatchObject({ total: 1, not_run: 1 });
    expect(r.skipped).toEqual([`${d.code} (not approved)`]);
    expect(r.code).toBe('RUN-001');
    expect(ex.createRun(db, projectId, { name: 'Second' }, 'human').code).toBe('RUN-002');
  });

  it('"add all approved" adds every approved case once; adding again is a no-op that says so', () => {
    approvedCase('A');
    approvedCase('B');
    draftCase('C');
    const r = run([], { addAllApproved: true });
    expect(r.counts.total).toBe(2);
    const again = ex.addCasesToRun(db, r.id, { addAllApproved: true }, 'human');
    expect(again.added).toBe(0);
    expect(again.skipped).toHaveLength(2);
  });

  it('refuses test cases from another project, an unknown run, bad input, and non-humans', () => {
    const foreign = approvedCase('Foreign', otherProjectId);
    http(() => run([foreign.id]), 400, 'test_case_invalid');
    http(() => ex.getRun(db, 'nope'), 404, 'run_not_found');
    http(() => ex.createRun(db, projectId, { name: '' }, 'human'), 400, 'invalid_input');
    http(() => ex.createRun(db, projectId, { name: 'x', extra: 1 }, 'human'), 400, 'invalid_input');
    http(() => ex.createRun(db, projectId, { name: 'x' }, 'agent'), 403, 'human_required');
    http(() => ex.createRun(db, 'missing-project', { name: 'x' }, 'human'), 404, 'project_not_found');
  });

  it('closing is human-only and a closed run rejects every change', () => {
    const a = approvedCase('A');
    const r = run([a.id]);
    const e = firstExec(r.id);
    http(() => ex.closeRun(db, r.id, 'agent'), 403, 'human_required');
    expect(ex.closeRun(db, r.id, 'human')).toMatchObject({ status: 'closed' });
    http(() => ex.closeRun(db, r.id, 'human'), 409, 'run_closed');
    http(() => ex.setResult(db, e.id, { status: 'in_progress' }, 'human'), 409, 'run_closed');
    http(() => ex.addCasesToRun(db, r.id, { addAllApproved: true }, 'human'), 409, 'run_closed');
    http(() => ex.addNoteEvidence(db, e.id, { body: 'x' }, 'human'), 409, 'run_closed');
  });
});

describe('recording results', () => {
  it('a person can pass a test; it records who, when, and the history', () => {
    const r = run([approvedCase('A').id]);
    const e = firstExec(r.id);
    ex.setResult(db, e.id, { status: 'in_progress' }, 'human');
    const done = ex.setResult(db, e.id, { status: 'passed', actualResult: 'Dashboard shown' }, 'human');
    expect(done).toMatchObject({ status: 'passed', executedBy: 'human', actualResult: 'Dashboard shown' });
    expect(done.completedAt).toMatch(/^\d{4}-/);
    expect(done.history.map((h) => `${h.action}:${h.fromStatus}>${h.toStatus}:${h.actor}`)).toEqual([
      'added:null>not_run:human',
      'result:not_run>in_progress:human',
      'result:in_progress>passed:human',
    ]);
  });

  it('an agent can NEVER mark a test passed or skipped, with or without a note', () => {
    const r = run([approvedCase('A').id]);
    const e = firstExec(r.id);
    for (const actor of ['agent', 'system'] as const) {
      for (const status of ['passed', 'skipped']) http(() => ex.setResult(db, e.id, { status, note: 'trust me' }, actor), 403, 'human_required');
    }
    expect(ex.getExecution(db, e.id).status).toBe('not_run');
  });

  it('an agent can start a test and report it failed with a note; it is recorded as agent assisted', () => {
    const r = run([approvedCase('A').id]);
    const e = firstExec(r.id);
    ex.setResult(db, e.id, { status: 'in_progress' }, 'agent');
    const f = ex.setResult(db, e.id, { status: 'failed', note: 'Error banner shown' }, 'agent');
    expect(f).toMatchObject({ status: 'failed', executedBy: 'agent', executorKind: 'agent_assisted' });
  });

  it('the database itself refuses a PASSED row that was not recorded by a human', () => {
    const r = run([approvedCase('A').id]);
    const e = firstExec(r.id);
    const sql = (by: string | null) => db.prepare("UPDATE test_executions SET status = 'passed', executed_by = ? WHERE id = ?").run(by, e.id);
    expect(() => sql('agent')).toThrow(/CHECK/);
    expect(() => sql('system')).toThrow(/CHECK/);
    expect(() => sql(null)).toThrow(/CHECK/);
    expect(() => sql('human')).not.toThrow();
  });

  it('the database refuses an APPROVED test case with no approver or an agent approver (2A hole fixed by trigger)', () => {
    const t = draftCase('Raw');
    const ts = new Date().toISOString();
    const up = (by: string | null, at: string | null) => () => db.prepare("UPDATE test_cases SET status = 'approved', approved_by = ?, approved_at = ? WHERE id = ?").run(by, at, t.id);
    expect(up(null, ts)).toThrow(/approved by a human/);
    expect(up(null, null)).toThrow();
    expect(up('human', null)).toThrow();
    expect(up('human', ts)).not.toThrow();
  });

  it('failed, blocked and skipped need a note; finishing a finished result needs one too', () => {
    const r = run([approvedCase('A').id]);
    const e = firstExec(r.id);
    for (const status of ['failed', 'blocked', 'skipped']) http(() => ex.setResult(db, e.id, { status }, 'human'), 422, 'note_required');
    ex.setResult(db, e.id, { status: 'failed', note: 'Wrong total' }, 'human');
    http(() => ex.setResult(db, e.id, { status: 'passed' }, 'human'), 422, 'note_required');
    expect(ex.setResult(db, e.id, { status: 'passed', note: 'Fixed in 1.0.4' }, 'human').status).toBe('passed');
    http(() => ex.setResult(db, e.id, { status: 'passed', note: 'again' }, 'human'), 409, 'unchanged');
  });

  it('a person cannot record a result as automated; unknown statuses and extra fields are rejected', () => {
    const r = run([approvedCase('A').id]);
    const e = firstExec(r.id);
    http(() => ex.setResult(db, e.id, { status: 'in_progress', executorKind: 'automated' }, 'human'), 400, 'invalid_input');
    http(() => ex.setResult(db, e.id, { status: 'done' }, 'human'), 400, 'invalid_input');
    http(() => ex.setResult(db, e.id, { status: 'in_progress', executedBy: 'human' }, 'human'), 400, 'invalid_input');
    http(() => ex.setResult(db, 'nope', { status: 'in_progress' }, 'human'), 404, 'execution_not_found');
  });

  it('notes and actual results are redacted before they are stored', () => {
    const r = run([approvedCase('A').id]);
    const e = firstExec(r.id);
    const d = ex.setResult(db, e.id, { status: 'failed', note: 'Logged in as jane.doe@example.com, key sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789', actualResult: 'Card 4242 4242 4242 4242 shown' }, 'human');
    expect(d.note).not.toContain('jane.doe@example.com');
    expect(d.note).not.toContain('sk-ant-');
    expect(d.actualResult).not.toContain('4242 4242 4242 4242');
    expect(d.history.at(-1)!.note).not.toContain('jane.doe');
  });

  it('flags a test case that changed after it was added to the run', () => {
    const a = approvedCase('A');
    const r = run([a.id]);
    expect(firstExec(r.id).caseChanged).toBe(false);
    qa.transitionTestCase(db, a.id, 'draft', 'needs rework', 'human');
    expect(firstExec(r.id).caseChanged).toBe(true);
  });

  it('execution history is append-only', () => {
    const r = run([approvedCase('A').id]);
    const e = firstExec(r.id);
    ex.setResult(db, e.id, { status: 'in_progress' }, 'human');
    expect(() => db.prepare("UPDATE execution_history SET note = 'x'").run()).toThrow(/append-only/);
    expect(() => db.prepare('DELETE FROM execution_history').run()).toThrow(/append-only/);
  });
});

describe('figures (real data only, visible denominators)', () => {
  it('nothing executed: every test case is pending and the pass rate is "—"', () => {
    approvedCase('A');
    approvedCase('B');
    draftCase('C');
    const s = ex.executionSummary(db);
    expect(s).toMatchObject({ approvedTestCases: 2, passed: 0, failed: 0, blocked: 0, skipped: 0, pending: 2, resultsRecorded: 0 });
    expect(s.passRate).toEqual({ numerator: 0, denominator: 0, percent: null });
  });

  it('counts the LATEST finished result per test case, so re-testing does not count twice', () => {
    const a = approvedCase('A');
    const b = approvedCase('B');
    approvedCase('C');
    const r1 = run([a.id, b.id]);
    const [e1, e2] = ex.getRun(db, r1.id).executions;
    ex.setResult(db, e1!.id, { status: 'failed', note: 'Broken' }, 'human');
    ex.setResult(db, e2!.id, { status: 'passed' }, 'human');
    expect(ex.executionSummary(db)).toMatchObject({ passed: 1, failed: 1, pending: 1, resultsRecorded: 2 });
    ex.closeRun(db, r1.id, 'human');
    const r2 = run([a.id]);
    ex.setResult(db, firstExec(r2.id).id, { status: 'passed' }, 'human');
    const s = ex.executionSummary(db);
    expect(s).toMatchObject({ passed: 2, failed: 0, pending: 1, resultsRecorded: 3, openRuns: 1 });
    expect(s.passRate).toEqual({ numerator: 2, denominator: 2, percent: 100 });
  });

  it('skipped tests are shown but left out of the pass rate; blocked ones count against it', () => {
    const [a, b, c] = [approvedCase('A'), approvedCase('B'), approvedCase('C')];
    const r = run([a.id, b.id, c.id]);
    const [x, y, z] = ex.getRun(db, r.id).executions;
    ex.setResult(db, x!.id, { status: 'passed' }, 'human');
    ex.setResult(db, y!.id, { status: 'blocked', note: 'Environment down' }, 'human');
    ex.setResult(db, z!.id, { status: 'skipped', note: 'Out of scope' }, 'human');
    const s = ex.executionSummary(db);
    expect(s).toMatchObject({ passed: 1, blocked: 1, skipped: 1, pending: 0 });
    expect(s.passRate).toEqual({ numerator: 1, denominator: 2, percent: 50 });
  });

  it('un-approving or archiving a test case removes it from the figures', () => {
    const a = approvedCase('A');
    const r = run([a.id]);
    ex.setResult(db, firstExec(r.id).id, { status: 'passed' }, 'human');
    qa.setArchived(db, a.id, true, 'human');
    expect(ex.executionSummary(db)).toMatchObject({ approvedTestCases: 0, passed: 0, pending: 0 });
  });

  it('is scoped per project when asked, and the test case list shows the latest result', () => {
    const a = approvedCase('A');
    approvedCase('Other', otherProjectId);
    const r = run([a.id]);
    expect(qa.listTestCases(db, { projectId, includeArchived: false })[0]!.executionStatus).toBe('NOT RUN');
    ex.setResult(db, firstExec(r.id).id, { status: 'in_progress' }, 'human');
    expect(qa.listTestCases(db, { projectId, includeArchived: false })[0]!.executionStatus).toBe('IN PROGRESS');
    ex.setResult(db, firstExec(r.id).id, { status: 'passed' }, 'human');
    expect(qa.listTestCases(db, { projectId, includeArchived: false })[0]!.executionStatus).toBe('PASSED');
    expect(ex.executionSummary(db, projectId).passed).toBe(1);
    expect(ex.executionSummary(db, otherProjectId)).toMatchObject({ approvedTestCases: 1, passed: 0, pending: 1 });
    expect(qa.qaSummary(db).execution.passed).toBe(1);
  });
});

describe('evidence', () => {
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('pretend-image-bytes')]);
  const b64 = (b: Buffer | string) => Buffer.from(b).toString('base64');
  let execId: string;
  beforeEach(() => {
    execId = firstExec(run([approvedCase('A').id]).id).id;
  });

  it('stores a screenshot under a random name, with hash and size, and serves it back', () => {
    const e = ex.addFileEvidence(db, evidenceDir, execId, { fileName: 'C:\\Users\\jane\\Desktop\\shot.png', label: 'Error banner', dataBase64: b64(png) }, 'human');
    expect(e).toMatchObject({ kind: 'file', fileName: 'shot.png', mime: 'image/png', sizeBytes: png.length, redacted: false });
    expect(e.sha256).toMatch(/^[a-f0-9]{64}$/);
    const stored = fs.readdirSync(evidenceDir);
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatch(/^evd_[A-Za-z0-9_-]+\.png$/);
    expect(stored[0]).not.toContain('shot');
    const f = ex.getEvidenceFile(db, evidenceDir, e.id);
    expect(fs.readFileSync(f.filePath).equals(png)).toBe(true);
    expect(ex.getExecution(db, execId).evidenceCount).toBe(1);
    expect(ex.getExecution(db, execId).history.at(-1)).toMatchObject({ action: 'evidence_added', note: 'File: shot.png' });
  });

  it('refuses disallowed types, content that does not match the extension, empty, bad base64 and oversize files', () => {
    const add = (fileName: string, data: string) => () => ex.addFileEvidence(db, evidenceDir, execId, { fileName, dataBase64: data }, 'human');
    http(add('run.exe', b64('MZ')), 415, 'file_type_not_allowed');
    http(add('page.html', b64('<script>')), 415, 'file_type_not_allowed');
    http(add('fake.png', b64('<html>not a png</html>')), 415, 'file_content_mismatch');
    http(add('bin.txt', b64(Buffer.from([0x41, 0x00, 0x42]))), 415, 'file_content_mismatch');
    http(add('x.png', '!!!not-base64!!!'), 400, 'invalid_input');
    http(add('big.txt', b64(Buffer.alloc(5 * 1024 * 1024 + 1, 0x61))), 413, 'file_too_large');
    expect(fs.existsSync(evidenceDir) ? fs.readdirSync(evidenceDir) : []).toEqual([]);
  });

  it('redacts text files and notes before storing them', () => {
    const log = 'user jane.doe@example.com token=ghp_abcdefghijklmnopqrstuvwxyz0123456789 ok';
    const f = ex.addFileEvidence(db, evidenceDir, execId, { fileName: 'run.log', dataBase64: b64(log) }, 'human');
    expect(f.redacted).toBe(true);
    const text = fs.readFileSync(ex.getEvidenceFile(db, evidenceDir, f.id).filePath, 'utf8');
    expect(text).not.toContain('jane.doe@example.com');
    expect(text).not.toContain('ghp_');
    const n = ex.addNoteEvidence(db, execId, { label: 'Observed', body: 'Saw jane.doe@example.com in the header' }, 'human');
    expect(n).toMatchObject({ kind: 'note', redacted: true });
    expect(n.body).not.toContain('jane.doe');
  });

  it('is limited per test, and deleting evidence is human-only, removes the file and is recorded in the history', () => {
    const e = ex.addFileEvidence(db, evidenceDir, execId, { fileName: 's.png', dataBase64: b64(png) }, 'agent');
    http(() => ex.deleteEvidence(db, evidenceDir, e.id, 'agent'), 403, 'human_required');
    ex.deleteEvidence(db, evidenceDir, e.id, 'human');
    expect(fs.readdirSync(evidenceDir)).toEqual([]);
    expect(ex.getExecution(db, execId).history.at(-1)).toMatchObject({ action: 'evidence_deleted' });
    http(() => ex.getEvidenceFile(db, evidenceDir, e.id), 404, 'evidence_not_found');
    for (let i = 0; i < 20; i++) ex.addNoteEvidence(db, execId, { body: `n${i}` }, 'human');
    http(() => ex.addNoteEvidence(db, execId, { body: 'one too many' }, 'human'), 409, 'evidence_limit');
  });

  it('never serves a file outside the evidence directory, even if the stored name were tampered with', () => {
    const e = ex.addFileEvidence(db, evidenceDir, execId, { fileName: 's.png', dataBase64: b64(png) }, 'human');
    const secret = path.join(root, 'secret.png');
    fs.writeFileSync(secret, png);
    db.prepare('UPDATE evidence SET stored_name = ? WHERE id = ?').run('..\\secret.png', e.id);
    http(() => ex.getEvidenceFile(db, evidenceDir, e.id), 404, 'evidence_file_missing');
  });

  it('keeps the test cases and runs referenced by executions protected from deletion', () => {
    const tc = qa.listTestCases(db, { projectId, includeArchived: false })[0]!;
    expect(() => db.prepare('DELETE FROM test_cases WHERE id = ?').run(tc.id)).toThrow(/FOREIGN KEY/);
  });
});
