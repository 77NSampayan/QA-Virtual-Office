/**
 * CI/CD connections (Pass 3, A3a): connect a project to a GitHub repository or an Azure DevOps project, test the
 * connection, replace the token, disconnect. READ-ONLY: nothing here starts, changes or reads the content of a run.
 *
 * Only a person can do any of it. The token goes straight into protected storage (never the database, never an API
 * answer, never a log); the connection row holds only the target and the result of the last test.
 */
import { z } from 'zod';
import { redact, type Actor } from '@qavo/shared';
import { callProvider, CI_PROVIDER_LABEL, CI_PROVIDERS, interpretTest, testRequest, whyBadTarget, whyBadToken, type CiProvider } from './ciProviders.ts';
import type { DB } from './db/index.ts';
import type { SecretStore } from './secretStore.ts';
import { HttpError, newId } from './store.ts';

export interface CiDeps {
  secrets: SecretStore;
  fetch: typeof fetch;
}
type Row = Record<string, unknown>;
const nowIso = () => new Date().toISOString();
const needHuman = (actor: Actor) => {
  if (actor !== 'human') throw new HttpError(403, 'human_required', 'Only a person can do this');
};
function parse<T extends z.ZodTypeAny>(schema: T, input: unknown): z.infer<T> {
  const r = schema.safeParse(input);
  // never echo the input: it contains the token
  if (!r.success) throw new HttpError(400, 'invalid_input', `Invalid fields: ${[...new Set(r.error.issues.map((i) => i.path.join('.') || '(root)'))].join(', ')}`);
  return r.data;
}
const ConnectInput = z.object({ provider: z.enum(CI_PROVIDERS), owner: z.string().trim().min(1).max(50), name: z.string().trim().min(1).max(100), token: z.string().max(400) }).strict();
const TokenInput = z.object({ token: z.string().max(400) }).strict();

export interface CiConnectionDTO {
  id: string;
  projectId: string;
  provider: CiProvider;
  providerLabel: string;
  owner: string;
  name: string;
  /** True when a token is stored. The token itself is never returned. */
  tokenStored: boolean;
  lastTestedAt: string | null;
  lastTestOk: boolean | null;
  lastTestMessage: string;
}

const dto = (db: DB, deps: CiDeps, r: Row): CiConnectionDTO => ({
  id: r.id as string,
  projectId: r.project_id as string,
  provider: r.provider as CiProvider,
  providerLabel: CI_PROVIDER_LABEL[r.provider as CiProvider],
  owner: r.owner as string,
  name: r.name as string,
  tokenStored: deps.secrets.has(r.id as string),
  lastTestedAt: (r.last_tested_at as string | null) ?? null,
  lastTestOk: r.last_test_ok === null || r.last_test_ok === undefined ? null : r.last_test_ok === 1,
  lastTestMessage: r.last_test_message as string,
});
const get = (db: DB, id: string): Row => {
  const r = db.prepare('SELECT * FROM ci_connections WHERE id = ?').get(id) as Row | undefined;
  if (!r) throw new HttpError(404, 'ci_connection_not_found');
  return r;
};

export function listConnections(db: DB, deps: CiDeps, projectId: string): CiConnectionDTO[] {
  if (!db.prepare('SELECT 1 FROM projects WHERE id = ?').get(projectId)) throw new HttpError(404, 'project_not_found');
  return (db.prepare('SELECT * FROM ci_connections WHERE project_id = ? ORDER BY created_at').all(projectId) as Row[]).map((r) => dto(db, deps, r));
}
export const projectOfConnection = (db: DB, id: string): string | undefined => (db.prepare('SELECT project_id FROM ci_connections WHERE id = ?').get(id) as { project_id: string } | undefined)?.project_id;

export async function connect(db: DB, deps: CiDeps, projectId: string, input: unknown, actor: Actor): Promise<CiConnectionDTO> {
  needHuman(actor);
  const v = parse(ConnectInput, input);
  if (!db.prepare('SELECT archived FROM projects WHERE id = ?').get(projectId)) throw new HttpError(404, 'project_not_found');
  const badTarget = whyBadTarget(v.provider, v.owner, v.name);
  if (badTarget) throw new HttpError(400, 'invalid_target', badTarget);
  const badToken = whyBadToken(v.token);
  if (badToken) throw new HttpError(400, 'invalid_token', badToken);
  const id = newId('ci');
  try {
    db.prepare('INSERT INTO ci_connections (id, project_id, provider, owner, name, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(id, projectId, v.provider, v.owner, v.name, nowIso());
  } catch (e) {
    if (/UNIQUE|idx_ci_connection_target/.test(String((e as Error).message))) throw new HttpError(409, 'already_connected', 'This project is already connected to that repository or project');
    throw e;
  }
  try {
    await deps.secrets.save(id, v.token);
  } catch {
    db.prepare('DELETE FROM ci_connections WHERE id = ?').run(id);
    throw new HttpError(500, 'protected_storage_failed', 'The token could not be saved in Windows protected storage, so nothing was connected.');
  }
  return dto(db, deps, get(db, id));
}

export async function replaceToken(db: DB, deps: CiDeps, id: string, input: unknown, actor: Actor): Promise<CiConnectionDTO> {
  needHuman(actor);
  const v = parse(TokenInput, input);
  get(db, id);
  const bad = whyBadToken(v.token);
  if (bad) throw new HttpError(400, 'invalid_token', bad);
  try {
    await deps.secrets.save(id, v.token);
  } catch {
    throw new HttpError(500, 'protected_storage_failed', 'The token could not be saved in Windows protected storage.');
  }
  db.prepare('UPDATE ci_connections SET last_tested_at = NULL, last_test_ok = NULL, last_test_message = ? WHERE id = ?').run('', id);
  return dto(db, deps, get(db, id));
}

const TEST_GAP_MS = 3000;
export async function testConnection(db: DB, deps: CiDeps, id: string, actor: Actor, now = Date.now()): Promise<{ connection: CiConnectionDTO; ok: boolean; message: string }> {
  needHuman(actor);
  const row = get(db, id);
  if (row.last_tested_at && now - Date.parse(row.last_tested_at as string) < TEST_GAP_MS) throw new HttpError(429, 'too_soon', 'Wait a few seconds before testing again.');
  let token: string | null;
  try {
    token = await deps.secrets.load(id);
  } catch {
    throw new HttpError(500, 'protected_storage_failed', 'The stored token could not be read. Replace the token.');
  }
  if (!token) throw new HttpError(409, 'token_missing', 'No token is stored for this connection. Replace the token.');
  const provider = row.provider as CiProvider;
  const res = await callProvider(provider, testRequest(provider, row.owner as string, row.name as string, token), deps.fetch);
  const outcome = interpretTest(provider, res);
  db.prepare('UPDATE ci_connections SET last_tested_at = ?, last_test_ok = ?, last_test_message = ? WHERE id = ?').run(new Date(now).toISOString(), outcome.ok ? 1 : 0, redact(outcome.message).slice(0, 300), id);
  return { connection: dto(db, deps, get(db, id)), ok: outcome.ok, message: outcome.message };
}

export async function disconnect(db: DB, deps: CiDeps, id: string, actor: Actor): Promise<{ disconnected: true }> {
  needHuman(actor);
  get(db, id);
  await deps.secrets.remove(id); // the token first: if this fails the connection stays and can be retried
  db.prepare('DELETE FROM ci_connections WHERE id = ?').run(id);
  return { disconnected: true };
}
