import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb, type DB } from '../src/db/index.ts';
import * as qa from '../src/qa.ts';
import * as au from '../src/qaAutomation.ts';
import { createProject, deleteProject, HttpError } from '../src/store.ts';

let db: DB;
let root: string;
let pid: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'qavo-auto-'));
  db = openDb(path.join(root, 'test.db'));
  const dir = path.join(root, 'Alpha');
  fs.mkdirSync(dir);
  pid = createProject(db, { alias: 'Alpha', path: dir }).project.id;
});
afterEach(() => {
  db.close();
  fs.rmSync(root, { recursive: true, force: true });
});

const xml = (extra = '') =>
  `<testsuite name="s"><testcase classname="c" name="TC-0001 sign in" time="1"/><testcase classname="c" name="boom"><failure message="bad&#10;trace line"/></testcase><testcase classname="c" name="later"><skipped/></testcase>${extra}</testsuite>`;
const http = (fn: () => unknown, status: number, code?: string) => {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(HttpError);
    expect((e as HttpError).status).toBe(status);
    if (code) expect((e as HttpError).code).toBe(code);
    return;
  }
  throw new Error('expected an HttpError');
};

describe('automation results', () => {
  it('imports a JUnit file, with a pass rate that shows its denominator and skipped tests left out', () => {
    const r = au.importJunit(db, pid, { text: xml(), name: 'Nightly', environment: 'staging' }, 'human');
    expect(r.created).toMatchObject({ code: 'AR-001', name: 'Nightly', environment: 'staging', unclassifiedFailures: 1 });
    expect(r.counts).toEqual({ total: 3, passed: 1, failed: 1, errored: 0, skipped: 1 });
    expect(r.passRate).toEqual({ numerator: 1, denominator: 2, percent: 50 });
    const d = au.getRun(db, r.created!.id);
    expect(d.results.map((x) => x.status)).toEqual(['failed', 'passed', 'skipped']); // failures first
    expect(d.results[0]).toMatchObject({ message: 'bad', classification: 'unknown' }); // unknown until a person decides
  });

  it('a dry run changes nothing and says what would happen', () => {
    const r = au.importJunit(db, pid, { text: xml(), dryRun: true }, 'human');
    expect(r).toMatchObject({ dryRun: true, total: 3, created: null });
    expect(au.listRuns(db, pid)).toHaveLength(0);
  });

  it('refuses the same file twice (and says which run it is), but accepts a changed file', () => {
    au.importJunit(db, pid, { text: xml() }, 'human');
    http(() => au.importJunit(db, pid, { text: xml() }, 'human'), 409, 'already_imported');
    expect(au.importJunit(db, pid, { text: xml(), dryRun: true }, 'human').alreadyImported).toBe('AR-001');
    expect(au.importJunit(db, pid, { text: xml('<testcase name="extra"/>') }, 'human').created!.code).toBe('AR-002');
  });

  it('refuses a file that is not JUnit', () => {
    http(() => au.importJunit(db, pid, { text: '<html/>' }, 'human'), 400, 'nothing_to_import');
    http(() => au.importJunit(db, pid, { text: xml(), extra: 1 }, 'human'), 400, 'invalid_input');
  });

  it('only a person can import, classify or delete (agent and system are refused)', () => {
    for (const actor of ['agent', 'system'] as const) http(() => au.importJunit(db, pid, { text: xml() }, actor), 403, 'human_required');
    const run = au.importJunit(db, pid, { text: xml() }, 'human').created!;
    const failed = au.getRun(db, run.id).results[0]!;
    for (const actor of ['agent', 'system'] as const) {
      http(() => au.classifyResult(db, failed.id, { classification: 'flaky' }, actor), 403, 'human_required');
      http(() => au.deleteRun(db, run.id, actor), 403, 'human_required');
    }
    expect(au.getRun(db, run.id).results[0]!.classification).toBe('unknown');
  });

  it('a person classifies failures only (not passes), and the unclassified count follows', () => {
    const run = au.importJunit(db, pid, { text: xml() }, 'human').created!;
    const [failed, passed] = au.getRun(db, run.id).results;
    expect(au.classifyResult(db, failed!.id, { classification: 'environment' }, 'human').classification).toBe('environment');
    expect(au.listRuns(db, pid)[0]!.unclassifiedFailures).toBe(0);
    http(() => au.classifyResult(db, passed!.id, { classification: 'flaky' }, 'human'), 409, 'not_a_failure');
    http(() => au.classifyResult(db, failed!.id, { classification: 'nonsense' }, 'human'), 400);
    au.classifyResult(db, failed!.id, { classification: 'unknown' }, 'human');
    expect(au.listRuns(db, pid)[0]!.unclassifiedFailures).toBe(1);
  });

  it('links a result to a test case by its code or Test Case ID, and never changes the test case', () => {
    const tc = qa.createTestCase(db, pid, { title: 'Sign in', steps: ['a'], expectedResult: 'b' }, 'human');
    const before = JSON.stringify(qa.getTestCase(db, tc.id));
    const run = au.importJunit(db, pid, { text: xml() }, 'human').created!;
    const linked = au.getRun(db, run.id).results.find((x) => x.name.startsWith('TC-0001'))!;
    expect(linked.testCaseCode).toBe(tc.code);
    expect(JSON.stringify(qa.getTestCase(db, tc.id))).toBe(before);
  });

  it('stores no stack traces or logs, and redacts what it keeps', () => {
    const text = '<testsuite name="s"><testcase name="mail bob@example.com" classname="c"><failure message="Bearer abcdefghijklmnopqrstuvwxyz123456"><![CDATA[Traceback C:\\Users\\someone\\x.py]]></failure><system-out>secret log</system-out></testcase></testsuite>';
    au.importJunit(db, pid, { text }, 'human');
    const all = JSON.stringify(db.prepare('SELECT * FROM automation_results').all()) + JSON.stringify(db.prepare('SELECT * FROM automation_runs').all());
    expect(all).not.toMatch(/bob@example\.com|abcdefghijklmnopqrstuvwxyz123456|Traceback|someone|secret log/);
  });

  it('deleting a run removes its results; a project with runs is archived, not removed', () => {
    const run = au.importJunit(db, pid, { text: xml() }, 'human').created!;
    http(() => deleteProject(db, pid), 409, 'project_has_qa_data');
    au.deleteRun(db, run.id, 'human');
    expect((db.prepare('SELECT COUNT(*) AS n FROM automation_results').get() as { n: number }).n).toBe(0);
  });
});
