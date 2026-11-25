import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb, type DB } from '../src/db/index.ts';
import * as td from '../src/qaTestData.ts';
import { createProject, deleteProject, HttpError } from '../src/store.ts';

let db: DB;
let root: string;
let pid: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'qavo-td-'));
  db = openDb(path.join(root, 'test.db'));
  const dir = path.join(root, 'Alpha');
  fs.mkdirSync(dir);
  pid = createProject(db, { alias: 'Alpha', path: dir }).project.id;
});
afterEach(() => {
  db.close();
  fs.rmSync(root, { recursive: true, force: true });
});

const http = (fn: () => unknown, status: number, code?: string, text?: RegExp) => {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(HttpError);
    expect((e as HttpError).status).toBe(status);
    if (code) expect((e as HttpError).code).toBe(code);
    if (text) expect(String((e as HttpError).message) + String((e as HttpError & { detail?: string }).detail ?? '')).toMatch(text);
    return;
  }
  throw new Error('expected an HttpError');
};
const good = () => ({
  name: 'Checkout user',
  environment: 'staging',
  description: 'Fake customer for the checkout tests',
  fields: [
    { key: 'email', kind: 'fixed', value: 'jane.tester@example.test' },
    { key: 'fullName', kind: 'fixed', value: 'Jane Tester' },
    { key: 'runId', kind: 'placeholder', value: '${RUN_ID}' },
    { key: 'password', kind: 'secret_ref', value: 'SHOP_TEST_PASSWORD' },
  ],
});

describe('test data profiles', () => {
  it('creates a profile with fake values, placeholders and a secret reference, and reads it back in order', () => {
    const p = td.createProfile(db, pid, good(), 'human');
    expect(p).toMatchObject({ code: 'TD-001', name: 'Checkout user', environment: 'staging', fieldCount: 4 });
    expect(p.fields.map((f) => f.key)).toEqual(['email', 'fullName', 'runId', 'password']);
    expect(td.listProfiles(db, pid)).toHaveLength(1);
  });

  it('refuses real-looking personal data and secrets with a reason per field, and stores nothing', () => {
    const bad = good();
    bad.fields.push({ key: 'contact', kind: 'fixed', value: 'maria.santos@gmail.com' }, { key: 'adminPassword', kind: 'fixed', value: 'Hunter2!' }, { key: 'token', kind: 'secret_ref', value: 'actualsecretvalue' });
    http(() => td.createProfile(db, pid, bad, 'human'), 400, 'not_fake_data', /contact: looks like real data.*adminPassword: a field named like a secret.*token: a secret reference is the NAME/s);
    expect(td.listProfiles(db, pid)).toEqual([]);
    expect((db.prepare('SELECT COUNT(*) AS n FROM test_data_fields').get() as { n: number }).n).toBe(0);
  });

  it('refuses a repeated field name, a bad name, and too many fields', () => {
    const dup = good();
    dup.fields.push({ key: 'EMAIL', kind: 'fixed', value: 'x@example.test' });
    http(() => td.createProfile(db, pid, dup, 'human'), 400, 'not_fake_data', /used twice/);
    const badKey = good();
    badKey.fields[0]!.key = '1 bad';
    http(() => td.createProfile(db, pid, badKey, 'human'), 400, 'not_fake_data', /must start with a letter/);
    const many = { ...good(), fields: Array.from({ length: 101 }, (_, i) => ({ key: `k${i}`, kind: 'fixed', value: 'x' })) };
    http(() => td.createProfile(db, pid, many, 'human'), 400, 'invalid_input');
    http(() => td.createProfile(db, pid, { ...good(), extra: 1 }, 'human'), 400, 'invalid_input');
  });

  it('one name per project and environment; the same name in another environment is fine', () => {
    td.createProfile(db, pid, good(), 'human');
    http(() => td.createProfile(db, pid, { ...good(), name: 'checkout USER' }, 'human'), 409, 'name_taken');
    expect(td.createProfile(db, pid, { ...good(), environment: 'qa' }, 'human').code).toBe('TD-002');
  });

  it('edits replace the fields (and are validated the same way); a refused edit changes nothing', () => {
    const p = td.createProfile(db, pid, good(), 'human');
    const edited = td.updateProfile(db, p.id, { ...good(), name: 'Renamed', fields: [{ key: 'email', kind: 'fixed', value: 'new@example.test' }] }, 'human');
    expect(edited).toMatchObject({ name: 'Renamed', fieldCount: 1 });
    http(() => td.updateProfile(db, p.id, { ...good(), name: 'Evil', fields: [{ key: 'email', kind: 'fixed', value: 'real.person@yahoo.com' }] }, 'human'), 400, 'not_fake_data');
    expect(td.getProfile(db, p.id)).toMatchObject({ name: 'Renamed', fields: [{ key: 'email', value: 'new@example.test' }] });
  });

  it('only a person can create, edit, delete or use the masking helper; agent and system are refused', () => {
    const p = td.createProfile(db, pid, good(), 'human');
    for (const actor of ['agent', 'system'] as const) {
      http(() => td.createProfile(db, pid, good(), actor), 403, 'human_required');
      http(() => td.updateProfile(db, p.id, good(), actor), 403, 'human_required');
      http(() => td.deleteProfile(db, p.id, actor), 403, 'human_required');
      http(() => td.checkText({ text: 'x' }, actor), 403, 'human_required');
    }
    expect(td.listProfiles(db, pid)).toHaveLength(1);
  });

  it('the masking helper masks and counts, and stores nothing', () => {
    const r = td.checkText({ text: 'Mail maria@gmail.com, password: hunter2secret' }, 'human');
    expect(r.masked).not.toMatch(/maria|hunter2secret/);
    expect(r.findings.length).toBeGreaterThan(0);
    expect((db.prepare('SELECT COUNT(*) AS n FROM test_data_fields').get() as { n: number }).n).toBe(0);
  });

  it('deleting removes its fields; a project with profiles cannot be removed (archive instead)', () => {
    const p = td.createProfile(db, pid, good(), 'human');
    http(() => deleteProject(db, pid), 409, 'project_has_qa_data');
    td.deleteProfile(db, p.id, 'human');
    expect((db.prepare('SELECT COUNT(*) AS n FROM test_data_fields').get() as { n: number }).n).toBe(0);
  });
});
