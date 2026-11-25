/**
 * Test data profiles (Pass 3, D1). FAKE or masked data and secret REFERENCES only.
 * A person creates, edits and deletes profiles; agents have no tools for them yet. Every value is checked by the shared
 * rules (`whyNotFake`): real-looking personal data or secrets are refused with a reason, never stored.
 */
import { z } from 'zod';
import { KEY_RE, maskText, redact, TEST_DATA_KINDS, TEST_DATA_LIMITS, whyNotFake, type Actor, type TestDataKind } from '@qavo/shared';
import type { DB } from './db/index.ts';
import { HttpError, newId } from './store.ts';

type Row = Record<string, unknown>;
const nowIso = () => new Date().toISOString();
const code = (seq: number) => `TD-${String(seq).padStart(3, '0')}`;
const needHuman = (actor: Actor) => {
  if (actor !== 'human') throw new HttpError(403, 'human_required', 'Only a person can do this');
};
function parse<T extends z.ZodTypeAny>(schema: T, input: unknown): z.infer<T> {
  const r = schema.safeParse(input);
  if (!r.success) throw new HttpError(400, 'invalid_input', `Invalid fields: ${[...new Set(r.error.issues.map((i) => i.path.join('.') || '(root)'))].join(', ')}`);
  return r.data;
}
function requireProject(db: DB, projectId: string) {
  if (!db.prepare('SELECT 1 FROM projects WHERE id = ?').get(projectId)) throw new HttpError(404, 'project_not_found');
}

const FieldInput = z.object({ key: z.string().trim().min(1).max(TEST_DATA_LIMITS.keyLen), kind: z.enum(TEST_DATA_KINDS), value: z.string().max(TEST_DATA_LIMITS.valueLen) }).strict();
const ProfileInput = z
  .object({
    name: z.string().trim().min(1).max(TEST_DATA_LIMITS.nameLen),
    environment: z.string().trim().max(TEST_DATA_LIMITS.envLen).default(''),
    description: z.string().max(TEST_DATA_LIMITS.descLen).default(''),
    fields: z.array(FieldInput).max(TEST_DATA_LIMITS.fields).default([]),
  })
  .strict();
const CheckInput = z.object({ text: z.string().max(100_000) }).strict();

export interface TestDataField {
  key: string;
  kind: TestDataKind;
  value: string;
}
export interface TestDataProfile {
  id: string;
  projectId: string;
  code: string;
  name: string;
  environment: string;
  description: string;
  fieldCount: number;
  updatedAt: string;
}
export interface TestDataProfileDetail extends TestDataProfile {
  fields: TestDataField[];
}

const dto = (r: Row, fieldCount: number): TestDataProfile => ({
  id: r.id as string,
  projectId: r.project_id as string,
  code: code(r.seq as number),
  name: r.name as string,
  environment: r.environment as string,
  description: r.description as string,
  fieldCount,
  updatedAt: r.updated_at as string,
});
const countFields = (db: DB, id: string) => (db.prepare('SELECT COUNT(*) AS n FROM test_data_fields WHERE profile_id = ?').get(id) as { n: number }).n;

export function listProfiles(db: DB, projectId: string): TestDataProfile[] {
  requireProject(db, projectId);
  return (db.prepare('SELECT * FROM test_data_profiles WHERE project_id = ? ORDER BY lower(environment), lower(name)').all(projectId) as Row[]).map((r) => dto(r, countFields(db, r.id as string)));
}
export function getProfile(db: DB, id: string): TestDataProfileDetail {
  const r = db.prepare('SELECT * FROM test_data_profiles WHERE id = ?').get(id) as Row | undefined;
  if (!r) throw new HttpError(404, 'test_data_not_found');
  const fields = (db.prepare('SELECT key, kind, value FROM test_data_fields WHERE profile_id = ? ORDER BY position').all(id) as Array<{ key: string; kind: TestDataKind; value: string }>).map((f) => ({ key: f.key, kind: f.kind, value: f.value }));
  return { ...dto(r, fields.length), fields };
}
export function projectOfProfile(db: DB, id: string): string | undefined {
  return (db.prepare('SELECT project_id FROM test_data_profiles WHERE id = ?').get(id) as { project_id: string } | undefined)?.project_id;
}

/** All problems with the fields at once, so the person can fix them in one go. */
function validateFields(fields: TestDataField[]): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  fields.forEach((f, i) => {
    const label = f.key || `field ${i + 1}`;
    const k = f.key.toLowerCase();
    if (KEY_RE.test(f.key) && seen.has(k)) problems.push(`${label}: used twice`);
    seen.add(k);
    const why = whyNotFake(f.key, f.kind, f.value);
    if (why) problems.push(`${label}: ${why}`);
  });
  return problems;
}

function write(db: DB, id: string, input: z.infer<typeof ProfileInput>) {
  const problems = validateFields(input.fields);
  if (problems.length) throw new HttpError(400, 'not_fake_data', problems.slice(0, 20).join('; '));
  const name = redact(input.name).trim();
  db.transaction(() => {
    db.prepare('DELETE FROM test_data_fields WHERE profile_id = ?').run(id);
    const ins = db.prepare('INSERT INTO test_data_fields (id, profile_id, position, key, kind, value) VALUES (?, ?, ?, ?, ?, ?)');
    input.fields.forEach((f, i) => ins.run(newId('tdf'), id, i, f.key, f.kind, f.value));
    db.prepare('UPDATE test_data_profiles SET name = ?, environment = ?, description = ?, updated_at = ? WHERE id = ?').run(name, redact(input.environment).trim(), redact(input.description).trim(), nowIso(), id);
  })();
}

export function createProfile(db: DB, projectId: string, input: unknown, actor: Actor): TestDataProfileDetail {
  needHuman(actor);
  const v = parse(ProfileInput, input);
  requireProject(db, projectId);
  const id = newId('tdp');
  const ts = nowIso();
  try {
    db.transaction(() => {
      const seq = ((db.prepare('SELECT COALESCE(MAX(seq), 0) AS m FROM test_data_profiles WHERE project_id = ?').get(projectId) as { m: number }).m ?? 0) + 1;
      db.prepare('INSERT INTO test_data_profiles (id, project_id, seq, name, environment, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(id, projectId, seq, redact(v.name).trim(), redact(v.environment).trim(), '', ts, ts);
      write(db, id, v);
    })();
  } catch (e) {
    if (/UNIQUE constraint failed: test_data_profiles\.project_id/.test(String((e as Error).message)) || /idx_test_data_profile_name/.test(String((e as Error).message))) {
      throw new HttpError(409, 'name_taken', 'This project already has a profile with that name for that environment');
    }
    throw e;
  }
  return getProfile(db, id);
}

export function updateProfile(db: DB, id: string, input: unknown, actor: Actor): TestDataProfileDetail {
  needHuman(actor);
  const v = parse(ProfileInput, input);
  if (!db.prepare('SELECT 1 FROM test_data_profiles WHERE id = ?').get(id)) throw new HttpError(404, 'test_data_not_found');
  try {
    write(db, id, v);
  } catch (e) {
    if (/idx_test_data_profile_name|UNIQUE constraint failed: test_data_profiles/.test(String((e as Error).message))) {
      throw new HttpError(409, 'name_taken', 'This project already has a profile with that name for that environment');
    }
    throw e;
  }
  return getProfile(db, id);
}

export function deleteProfile(db: DB, id: string, actor: Actor): { deleted: true } {
  needHuman(actor);
  if (!db.prepare('SELECT 1 FROM test_data_profiles WHERE id = ?').get(id)) throw new HttpError(404, 'test_data_not_found');
  db.prepare('DELETE FROM test_data_profiles WHERE id = ?').run(id);
  return { deleted: true };
}

/** The masking helper: show what would be masked in a pasted text. Nothing is stored or logged. */
export function checkText(input: unknown, actor: Actor) {
  needHuman(actor);
  return maskText(parse(CheckInput, input).text);
}
