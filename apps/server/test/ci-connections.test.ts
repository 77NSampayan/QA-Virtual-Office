import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { COOKIE_NAME } from '../src/auth.ts';
import { callProvider, interpretTest, LIMITS, testRequest, whyBadTarget, whyBadToken } from '../src/ciProviders.ts';
import { readAgentToken } from '../src/dataDir.ts';
import { openDb, type DB } from '../src/db/index.ts';
import * as ci from '../src/qaCi.ts';
import { createDpapiStore, createMemoryStore } from '../src/secretStore.ts';
import { createProject, HttpError } from '../src/store.ts';
import { makeEnv, uiHeaders } from './helpers.ts';

const GH_TOKEN = 'github_pat_11ABCDEFG0abcdefghijklmnopqrstuvwxyz0123456789';
const AZ_TOKEN = 'abcdefghijklmnopqrstuvwxyz234567abcdefghijklmnopqrst';

type FetchLike = (url: string | URL | Request, init?: RequestInit) => Promise<Response>;
const json = (status: number, body: unknown, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

describe('provider rules', () => {
  it('accepts normal names and refuses anything that could change the URL', () => {
    expect(whyBadTarget('github', 'octo-org', 'my.repo_1')).toBeNull();
    for (const [o, n] of [['a/b', 'r'], ['o', '../x'], ['o', '..'], ['o', 'r?x=1'], ['o', 'r#x'], ['o@evil', 'r'], ['', 'r'], ['o', 'r r'], ['o', 'r\\x'], ['-', 'r'], ['o', 'r%2e']] as const) {
      expect(whyBadTarget('github', o, n), `${o}/${n}`).not.toBeNull();
    }
    expect(whyBadTarget('azure_devops', 'my-org', 'Shop Web.v2')).toBeNull();
    for (const [o, n] of [['org/x', 'p'], ['org', '../p'], ['org', 'p/q'], ['org', 'p?'], ['org', ' p'], ['org', 'p '], ['org', 'p.'], ['o.rg', 'p'], ['org', '..']] as const) {
      expect(whyBadTarget('azure_devops', o, n), `${o}/${n}`).not.toBeNull();
    }
    expect(whyBadToken(GH_TOKEN)).toBeNull();
    for (const t of ['', 'short', 'has space in it which is long enough ok', 'x'.repeat(401), `ok${'a'.repeat(30)}\n`]) expect(whyBadToken(t), t).not.toBeNull();
  });

  it('builds requests only to the fixed hosts, GET targets with encoded names, token only in the header', () => {
    const g = testRequest('github', 'octo-org', 'repo', GH_TOKEN);
    expect(new URL(g.url).hostname).toBe('api.github.com');
    expect(g.url).toBe('https://api.github.com/repos/octo-org/repo/actions/runs?per_page=1');
    expect(g.url).not.toContain(GH_TOKEN);
    expect(g.headers.Authorization).toBe(`Bearer ${GH_TOKEN}`);
    expect(g.headers['User-Agent']).toBe('qa-virtual-office');
    const a = testRequest('azure_devops', 'my-org', 'Shop Web', AZ_TOKEN);
    expect(new URL(a.url).hostname).toBe('dev.azure.com');
    expect(a.url).toBe('https://dev.azure.com/my-org/Shop%20Web/_apis/build/builds?%24top=1&api-version=7.1');
    expect(a.url).not.toContain(AZ_TOKEN);
    expect(a.headers.Authorization).toBe(`Basic ${Buffer.from(`:${AZ_TOKEN}`).toString('base64')}`);
    expect(() => testRequest('github', 'a/b', 'r', GH_TOKEN)).toThrow();
  });

  it('refuses to call any other host, scheme or a URL with credentials, and never calls fetch for them', async () => {
    let calls = 0;
    const f: FetchLike = async () => (calls++, json(200, {}));
    for (const url of ['https://evil.example/repos/o/r', 'http://api.github.com/repos/o/r', 'https://api.github.com.evil.example/x', 'https://user:pw@api.github.com/x', 'https://localhost/x', 'https://127.0.0.1/x']) {
      await expect(callProvider('github', { url, headers: {} }, f as typeof fetch), url).rejects.toThrow(/refused/);
    }
    await expect(callProvider('azure_devops', { url: 'https://api.github.com/x', headers: {} }, f as typeof fetch)).rejects.toThrow(/refused/); // a provider's token never goes to the other provider's host
    expect(calls).toBe(0);
  });

  it('sends GET without following redirects, with a timeout; redirects, big and non-JSON answers and network errors are handled', async () => {
    let seen: RequestInit | undefined;
    const ok: FetchLike = async (_u, init) => ((seen = init), json(200, { workflow_runs: [] }));
    const req = testRequest('github', 'o', 'r', GH_TOKEN);
    const r = await callProvider('github', req, ok as typeof fetch);
    expect(r.status).toBe(200);
    expect(seen).toMatchObject({ method: 'GET', redirect: 'manual' });
    expect(seen!.signal).toBeInstanceOf(AbortSignal);
    expect((await callProvider('github', req, (async () => new Response(null, { status: 302, headers: { location: 'https://evil.example' } })) as FetchLike as typeof fetch)).redirected).toBe(true);
    expect((await callProvider('github', req, (async () => new Response('x'.repeat(LIMITS.maxBytes + 10), { status: 200 })) as FetchLike as typeof fetch)).tooLarge).toBe(true);
    expect((await callProvider('github', req, (async () => new Response('<html>sign in</html>', { status: 200 })) as FetchLike as typeof fetch)).json).toBeNull();
    expect((await callProvider('github', req, (async () => Promise.reject(new Error(`connect ECONNREFUSED ${GH_TOKEN}`))) as FetchLike as typeof fetch)).status).toBe(0);
    expect((await callProvider('github', req, (async () => json(403, {}, { 'x-ratelimit-remaining': '0' })) as FetchLike as typeof fetch)).rateLimited).toBe(true);
  });

  it('turns answers into plain sentences that never contain provider text or the token', () => {
    const base = { json: null, etag: null, notModified: false, retryAfterMs: null, rateLimited: false, redirected: false, tooLarge: false };
    const cases: Array<[string, Parameters<typeof interpretTest>[1], boolean, RegExp]> = [
      ['github', { ...base, status: 200, json: { workflow_runs: [] } }, true, /Connected/],
      ['github', { ...base, status: 401, json: { message: `Bad credentials ${GH_TOKEN}` } }, false, /rejected the token/],
      ['github', { ...base, status: 403 }, false, /Actions: Read/],
      ['github', { ...base, status: 403, rateLimited: true }, false, /too many requests/],
      ['github', { ...base, status: 404 }, false, /not found/],
      ['github', { ...base, status: 0 }, false, /Could not reach/],
      ['github', { ...base, status: 200, json: { other: 1 } }, false, /expected form/],
      ['azure_devops', { ...base, status: 200, json: { value: [] } }, true, /Connected/],
      ['azure_devops', { ...base, status: 203 }, false, /did not accept the token/],
      ['azure_devops', { ...base, status: 302, redirected: true }, false, /sign in/],
      ['azure_devops', { ...base, status: 404 }, false, /Organisation or project/],
    ];
    for (const [p, r, ok, text] of cases) {
      const o = interpretTest(p as 'github', r);
      expect(o.ok, `${p} ${r.status}`).toBe(ok);
      expect(o.message).toMatch(text);
      expect(o.message).not.toContain(GH_TOKEN);
    }
  });
});

describe('connections (service)', () => {
  let db: DB;
  let root: string;
  let pid: string;
  let secrets: ReturnType<typeof createMemoryStore>;
  let calls: Array<{ url: string; auth: string }>;
  let answer: () => Response;
  let deps: ci.CiDeps;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'qavo-ci-'));
    db = openDb(path.join(root, 'test.db'));
    const dir = path.join(root, 'Alpha');
    fs.mkdirSync(dir);
    pid = createProject(db, { alias: 'Alpha', path: dir }).project.id;
    secrets = createMemoryStore();
    calls = [];
    answer = () => json(200, { workflow_runs: [] });
    deps = { secrets, fetch: (async (url: string, init?: RequestInit) => (calls.push({ url: String(url), auth: String((init?.headers as Record<string, string>).Authorization) }), answer())) as unknown as typeof fetch };
  });
  afterEach(() => {
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const input = (extra: object = {}) => ({ provider: 'github', owner: 'octo-org', name: 'shop', token: GH_TOKEN, ...extra });
  const http = async (p: Promise<unknown>, status: number, code?: string) => {
    try {
      await p;
    } catch (e) {
      expect(e).toBeInstanceOf(HttpError);
      expect((e as HttpError).status).toBe(status);
      if (code) expect((e as HttpError).code).toBe(code);
      expect(JSON.stringify([(e as HttpError).message])).not.toContain(GH_TOKEN);
      return;
    }
    throw new Error('expected an HttpError');
  };
  const everythingInDb = () => {
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map((t) => t.name);
    return tables.map((t) => JSON.stringify(db.prepare(`SELECT * FROM "${t}"`).all())).join('\n');
  };

  it('connects: the token goes to protected storage only, never to the database, and no answer contains it', async () => {
    const c = await ci.connect(db, deps, pid, input(), 'human');
    expect(c).toMatchObject({ provider: 'github', providerLabel: 'GitHub Actions', owner: 'octo-org', name: 'shop', tokenStored: true, lastTestedAt: null, lastTestOk: null });
    expect(secrets.all()).toEqual([GH_TOKEN]);
    expect(everythingInDb()).not.toContain(GH_TOKEN);
    expect(JSON.stringify(ci.listConnections(db, deps, pid))).not.toContain(GH_TOKEN);
    expect(calls).toEqual([]); // connecting alone does not call the provider
  });

  it('refuses bad targets and tokens, duplicates, and an unknown project; nothing is stored', async () => {
    await http(ci.connect(db, deps, pid, input({ owner: 'a/b' }), 'human'), 400, 'invalid_target');
    await http(ci.connect(db, deps, pid, input({ token: 'short' }), 'human'), 400, 'invalid_token');
    await http(ci.connect(db, deps, pid, input({ host: 'evil.example' }), 'human'), 400, 'invalid_input'); // a host can never be supplied
    await http(ci.connect(db, deps, pid, input({ provider: 'jenkins' }), 'human'), 400, 'invalid_input');
    await http(ci.connect(db, deps, 'nope', input(), 'human'), 404);
    await ci.connect(db, deps, pid, input(), 'human');
    await http(ci.connect(db, deps, pid, input({ owner: 'OCTO-ORG', name: 'SHOP' }), 'human'), 409, 'already_connected');
    expect(secrets.size()).toBe(1);
  });

  it('if protected storage fails, nothing is connected', async () => {
    const broken = { ...secrets, save: async () => Promise.reject(new Error('boom')) } as unknown as ci.CiDeps['secrets'];
    await http(ci.connect(db, { ...deps, secrets: broken }, pid, input(), 'human'), 500, 'protected_storage_failed');
    expect(ci.listConnections(db, deps, pid)).toEqual([]);
  });

  it('tests a connection with the stored token, and records only our own sentence', async () => {
    const c = await ci.connect(db, deps, pid, input(), 'human');
    const r = await ci.testConnection(db, deps, c.id, 'human');
    expect(r).toMatchObject({ ok: true });
    expect(calls).toEqual([{ url: 'https://api.github.com/repos/octo-org/shop/actions/runs?per_page=1', auth: `Bearer ${GH_TOKEN}` }]);
    expect(r.connection).toMatchObject({ lastTestOk: true, lastTestMessage: expect.stringMatching(/Connected/) });
    // the provider echoes the token in its error: it must not appear anywhere
    answer = () => json(401, { message: `Bad credentials: ${GH_TOKEN}` });
    const later = Date.now() + 10_000;
    const bad = await ci.testConnection(db, deps, c.id, 'human', later);
    expect(bad.ok).toBe(false);
    expect(JSON.stringify(bad)).not.toContain(GH_TOKEN);
    expect(everythingInDb()).not.toContain(GH_TOKEN);
    expect(bad.connection.lastTestOk).toBe(false);
  });

  it('azure devops: Basic auth to dev.azure.com with the project name encoded', async () => {
    const c = await ci.connect(db, deps, pid, input({ provider: 'azure_devops', owner: 'my-org', name: 'Shop Web', token: AZ_TOKEN }), 'human');
    answer = () => json(200, { value: [] });
    expect((await ci.testConnection(db, deps, c.id, 'human')).ok).toBe(true);
    expect(calls[0]).toEqual({ url: 'https://dev.azure.com/my-org/Shop%20Web/_apis/build/builds?%24top=1&api-version=7.1', auth: `Basic ${Buffer.from(`:${AZ_TOKEN}`).toString('base64')}` });
    expect(everythingInDb()).not.toContain(AZ_TOKEN);
  });

  it('limits how often a connection can be tested', async () => {
    const c = await ci.connect(db, deps, pid, input(), 'human');
    await ci.testConnection(db, deps, c.id, 'human');
    await http(ci.testConnection(db, deps, c.id, 'human'), 429, 'too_soon');
    expect(calls).toHaveLength(1);
  });

  it('replacing the token swaps the secret and clears the old test result; disconnecting removes the secret and the row', async () => {
    const c = await ci.connect(db, deps, pid, input(), 'human');
    await ci.testConnection(db, deps, c.id, 'human');
    const NEW = 'github_pat_22ZZZZZZZ0abcdefghijklmnopqrstuvwxyz0123456789';
    const r = await ci.replaceToken(db, deps, c.id, { token: NEW }, 'human');
    expect(r).toMatchObject({ lastTestedAt: null, lastTestOk: null, tokenStored: true });
    expect(secrets.all()).toEqual([NEW]);
    await http(ci.replaceToken(db, deps, c.id, { token: 'bad' }, 'human'), 400, 'invalid_token');
    await ci.disconnect(db, deps, c.id, 'human');
    expect(secrets.size()).toBe(0);
    expect(ci.listConnections(db, deps, pid)).toEqual([]);
    expect(everythingInDb()).not.toContain(NEW);
  });

  it('a project with a connection cannot be removed (archive instead), and a missing token is reported', async () => {
    const c = await ci.connect(db, deps, pid, input(), 'human');
    expect(() => db.prepare('DELETE FROM projects WHERE id = ?').run(pid)).toThrow(/FOREIGN KEY/);
    await secrets.remove(c.id);
    await http(ci.testConnection(db, deps, c.id, 'human'), 409, 'token_missing');
  });

  it('only a person can connect, test, replace the token or disconnect', async () => {
    const c = await ci.connect(db, deps, pid, input(), 'human');
    for (const actor of ['agent', 'system'] as const) {
      await http(ci.connect(db, deps, pid, input({ name: 'other' }), actor), 403, 'human_required');
      await http(ci.testConnection(db, deps, c.id, actor), 403, 'human_required');
      await http(ci.replaceToken(db, deps, c.id, { token: GH_TOKEN }, actor), 403, 'human_required');
      await http(ci.disconnect(db, deps, c.id, actor), 403, 'human_required');
    }
    expect(calls).toEqual([]);
  });
});

describe('HTTP routes and the real protected store', () => {
  it('routes need the signed-in person, never answer with the token, and the log never holds it', async () => {
    const secrets = createMemoryStore();
    const env = await makeEnv({ auth: true, ci: { secrets, fetch: (async () => json(200, { workflow_runs: [] })) as unknown as typeof fetch } });
    try {
      const cookie = `${COOKIE_NAME}=${env.auth.issueSession()}`;
      const dir = path.join(env.root, 'Shop');
      fs.mkdirSync(dir);
      const ui = async (method: string, url: string, payload?: unknown) => env.app.inject({ method: method as 'GET', url, headers: { ...uiHeaders(env), cookie }, payload: payload as object });
      const pid = (await ui('POST', '/api/projects', { alias: 'Shop', path: dir })).json().project.id as string;
      const made = await ui('POST', `/api/projects/${pid}/ci/connections`, { provider: 'github', owner: 'octo-org', name: 'shop', token: GH_TOKEN });
      expect(made.statusCode).toBe(201);
      expect(made.body).not.toContain(GH_TOKEN);
      const id = made.json().id as string;
      const tested = await ui('POST', `/api/ci/connections/${id}/test`);
      expect(tested.json()).toMatchObject({ ok: true });
      expect(tested.body).not.toContain(GH_TOKEN);
      expect((await ui('GET', `/api/projects/${pid}/ci/connections`)).body).not.toContain(GH_TOKEN);
      // refused callers
      const attempt = (headers: Record<string, string>, method = 'POST', url = `/api/projects/${pid}/ci/connections`) => env.app.inject({ method: method as 'POST', url, headers: { ...headers, 'content-type': 'application/json' }, payload: { provider: 'github', owner: 'o', name: 'r2', token: GH_TOKEN } });
      expect((await attempt({ host: env.host, 'x-qavo-agent-token': readAgentToken(env.paths) })).statusCode).toBeGreaterThanOrEqual(400);
      expect((await attempt({ host: env.host, 'x-qavo-token': env.token })).statusCode).toBeGreaterThanOrEqual(400);
      expect((await attempt({ ...uiHeaders(env) })).statusCode).toBe(401);
      expect((await env.app.inject({ method: 'DELETE', url: `/api/ci/connections/${id}`, headers: { ...uiHeaders(env) } })).statusCode).toBe(401);
      // a body with a host field is refused outright
      expect((await ui('POST', `/api/projects/${pid}/ci/connections`, { provider: 'github', owner: 'o', name: 'r3', token: GH_TOKEN, host: 'evil.example' })).statusCode).toBe(400);
      expect((await ui('DELETE', `/api/ci/connections/${id}`)).statusCode).toBe(200);
      // nothing under the data folder (logs, database, backups) holds the token
      await env.app.close().catch(() => undefined);
      const hits: string[] = [];
      const walk = (d: string) => {
        for (const e of fs.readdirSync(d, { withFileTypes: true })) {
          const f = path.join(d, e.name);
          if (e.isDirectory()) walk(f);
          else if (fs.readFileSync(f).includes(GH_TOKEN)) hits.push(e.name);
        }
      };
      walk(env.dataDir);
      expect(hits).toEqual([]);
    } finally {
      await env.cleanup().catch(() => undefined);
    }
  });

  it.runIf(process.platform === 'win32')('Windows DPAPI: the file holds encrypted bytes, not the token, and it round-trips; remove deletes it', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qavo-dpapi-'));
    try {
      const store = createDpapiStore(dir);
      expect(store.has('ci_abc123')).toBe(false);
      await store.save('ci_abc123', GH_TOKEN);
      expect(store.has('ci_abc123')).toBe(true);
      const stored = fs.readFileSync(path.join(dir, 'ci_abc123.dpapi'), 'utf8');
      expect(stored).not.toContain(GH_TOKEN);
      expect(stored.length).toBeGreaterThan(100);
      expect(await store.load('ci_abc123')).toBe(GH_TOKEN);
      await store.save('ci_abc123', AZ_TOKEN);
      expect(await store.load('ci_abc123')).toBe(AZ_TOKEN);
      await store.remove('ci_abc123');
      expect(store.has('ci_abc123')).toBe(false);
      expect(await store.load('ci_abc123')).toBeNull();
      await expect(store.save('../evil', 'x')).rejects.toThrow(/invalid secret id/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
