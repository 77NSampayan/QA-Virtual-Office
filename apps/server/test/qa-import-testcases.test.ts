import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb, type DB } from '../src/db/index.ts';
import * as qa from '../src/qa.ts';
import { createProject, HttpError } from '../src/store.ts';

let db: DB;
let root: string;
let pid: string;
let otherPid: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'qavo-tcimp-'));
  db = openDb(path.join(root, 'test.db'));
  const mk = (name: string) => {
    const dir = path.join(root, name);
    fs.mkdirSync(dir);
    return createProject(db, { alias: name, path: dir }).project.id;
  };
  pid = mk('Alpha');
  otherPid = mk('Beta');
});
afterEach(() => {
  db.close();
  fs.rmSync(root, { recursive: true, force: true });
});

function http(fn: () => unknown, status: number, code?: string) {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(HttpError);
    expect((e as HttpError).status).toBe(status);
    if (code) expect((e as HttpError).code).toBe(code);
    return;
  }
  throw new Error('expected an HttpError');
}

const TABLE = [
  '| Module | Sub Module | Test Case ID | Test Case Description | Test Case Type | Pre-Condition | Steps | Expected Result | Test Data | Assigned Tester | Requirement Refs | Status | Test Execution Status | Actual Result |',
  '|---|---|---|---|---|---|---|---|---|---|---|---|---|---|',
  '| Auth | Login | TC_001 | Sign in with valid credentials | Positive | Account exists | 1. Open login<br>2. Submit | Dashboard shown | user=demo | Alex | FR-1, FR-9 | Passed | Passed | Dashboard shown |',
  '| Auth | Login | TC_002 | Wrong password is refused | Negative | | | Error shown | | | | | | |',
].join('\n');

describe('importTestCases', () => {
  it('previews without writing, then imports as human-authored DRAFTS with no results', () => {
    qa.createRequirement(db, pid, { ref: 'FR-1', title: 'Login' }, 'human');
    const preview = qa.importTestCases(db, pid, { text: TABLE, dryRun: true }, 'human');
    expect(preview.dryRun).toBe(true);
    expect(preview.wouldCreate.map((w) => w.externalId)).toEqual(['TC_001', 'TC_002']);
    expect(preview.created).toBe(0);
    expect(qa.listTestCases(db, { projectId: pid })).toHaveLength(0); // nothing written
    expect(preview.columns.ignored).toEqual(expect.arrayContaining(['Status', 'Test Execution Status', 'Actual Result']));
    expect(preview.warnings.map((w) => w.text).join('|')).toMatch(/FR-9/); // unknown requirement is warned, not invented

    const r = qa.importTestCases(db, pid, { text: TABLE }, 'human');
    expect(r.created).toBe(2);
    const list = qa.listTestCases(db, { projectId: pid });
    expect(list.map((t) => t.code)).toEqual(['TC-0001', 'TC-0002']);
    expect(list[0]).toMatchObject({
      externalId: 'TC_001',
      scenario: 'Auth › Login',
      title: 'Sign in with valid credentials',
      status: 'draft',
      authoredBy: 'human',
      approvedBy: null,
      executionStatus: 'NOT RUN', // an imported "Passed" is NOT a result
      steps: ['Open login', 'Submit'],
      testType: 'positive',
      assignedTester: 'Alex',
      requirementRefs: ['FR-1'],
    });
    expect(list[1]).toMatchObject({ testType: 'negative', steps: [] });
    const detail = qa.getTestCase(db, list[0]!.id);
    expect(detail.history.map((h) => [h.action, h.actor, h.toStatus])).toEqual([['imported', 'human', 'draft']]);
    expect(db.prepare('SELECT COUNT(*) AS n FROM test_executions').get()).toEqual({ n: 0 });
  });

  it('is safe to run again: rows whose Test Case ID exists are skipped', () => {
    qa.importTestCases(db, pid, { text: TABLE }, 'human');
    const again = qa.importTestCases(db, pid, { text: TABLE }, 'human');
    expect(again.created).toBe(0);
    expect(again.skippedExisting.sort()).toEqual(['TC_001', 'TC_002']);
    expect(qa.listTestCases(db, { projectId: pid })).toHaveLength(2);
    // the same ids are independent in another project
    expect(qa.importTestCases(db, otherPid, { text: TABLE }, 'human').created).toBe(2);
  });

  it('repeated ids inside the text: the first wins; rows without an id are always new and counted', () => {
    const text = ['| Test Case ID | Test Case Description |', '|---|---|', '| A | one |', '| a | duplicate |', '| | no id |'].join('\n');
    const r = qa.importTestCases(db, pid, { text }, 'human');
    expect(r.created).toBe(2);
    expect(r.duplicatesInText).toEqual(['a']);
    expect(r.rowsWithoutId).toBe(1);
  });

  it('imports a spreadsheet paste (tab separated)', () => {
    const tsv = ['Module\tTest Case ID\tTest Case Description\tExpected Result', 'Cart\tC1\tAdd a product\t"Cart has 1 item,\nsubtotal updated"'].join('\n');
    const r = qa.importTestCases(db, pid, { text: tsv }, 'human');
    expect(r.format).toBe('tsv');
    expect(qa.listTestCases(db, { projectId: pid })[0]).toMatchObject({ expectedResult: 'Cart has 1 item,\nsubtotal updated', scenario: 'Cart' });
  });

  it('only a person can import, and bad input is refused', () => {
    http(() => qa.importTestCases(db, pid, { text: TABLE }, 'agent'), 403, 'human_required');
    http(() => qa.importTestCases(db, pid, { text: TABLE }, 'system'), 403, 'human_required');
    http(() => qa.importTestCases(db, pid, { text: 'no table here' }, 'human'), 400, 'nothing_to_import');
    http(() => qa.importTestCases(db, pid, { text: '| Module |\n|---|\n| a |' }, 'human'), 400, 'missing_column');
    http(() => qa.importTestCases(db, pid, { text: 'x'.repeat(400_001) }, 'human'), 400, 'invalid_input');
    http(() => qa.importTestCases(db, pid, { text: TABLE, status: 'approved' }, 'human'), 400, 'invalid_input'); // no way to import as approved
    http(() => qa.importTestCases(db, 'nope', { text: TABLE }, 'human'), 404, 'project_not_found');
    expect(qa.listTestCases(db, { projectId: pid })).toHaveLength(0);
  });

  it('is all-or-nothing and keeps problems visible (row errors, warnings)', () => {
    const text = ['| Test Case ID | Test Case Description | Test Case Type |', '|---|---|---|', '| 1 | fine | Smoke |', '| 2 | | Positive |'].join('\n');
    const r = qa.importTestCases(db, pid, { text }, 'human');
    expect(r.created).toBe(1);
    expect(r.rowErrors).toEqual([{ row: 2, reason: 'The test case description is empty' }]);
    expect(r.warnings).toHaveLength(1);
  });

  it('the database keeps a Test Case ID unique per project, whatever the case', () => {
    qa.importTestCases(db, pid, { text: '| Test Case ID | Test Case Description |\n|---|---|\n| Abc | x |' }, 'human');
    const t = qa.listTestCases(db, { projectId: pid })[0]!;
    expect(() => db.prepare("UPDATE test_cases SET external_id = 'ABC' WHERE id = ?").run(t.id)).not.toThrow(); // itself
    qa.createTestCase(db, pid, { title: 'second' }, 'human');
    const second = qa.listTestCases(db, { projectId: pid })[1]!;
    expect(() => db.prepare("UPDATE test_cases SET external_id = 'abc' WHERE id = ?").run(second.id)).toThrow(/UNIQUE/);
  });
});
