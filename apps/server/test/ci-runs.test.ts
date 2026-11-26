import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { COOKIE_NAME } from '../src/auth.ts';
import { callProvider, parseRuns, runsRequest } from '../src/ciProviders.ts';
import { readAgentToken } from '../src/dataDir.ts';
import { openDb, type DB } from '../src/db/index.ts';
import * as ci from '../src/qaCi.ts';
import { createMemoryStore } from '../src/secretStore.ts';
import { createProject, HttpError } from '../src/store.ts';
import { makeEnv, uiHeaders } from './helpers.ts';

const GH_TOKEN = 'github_pat_11ABCDEFG0abcdefghijklmnopqrstuvwxyz0123456789';
const AZ_TOKEN = 'abcdefghijklmnopqrstuvwxyz234567abcdefghijklmnopqrst';
const json = (status: number, body: unknown, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
const NOW = Date.parse('2026-11-26T10:00:00Z');
const ago = (min: number) => new Date(NOW - min * 60_000).toISOString();

/** A GitHub run exactly as the real API sends it: with the person, commit message and PR title that must never be kept. */
const ghRun = (id: number, extra: Record<string, unknown> = {}) => ({
  id,
  name: 'CI',
  display_title: 'Fix login for maria.santos@gmail.com (PR title)',
  head_branch: 'main',
  head_sha: 'abcdef0123456789abcdef0123456789abcdef01',
  status: 'completed',
  conclusion: 'success',
  run_started_at: ago(30),
  created_at: ago(31),
  updated_at: ago(25),
  html_url: `https://github.com/octo-org/shop/actions/runs/${id}`,
  actor: { login: 'maria-santos', email: 'maria.santos@gmail.com', avatar_url: 'https://avatars.githubusercontent.com/u/1' },
  triggering_actor: { login: 'pedro-cruz' },
  head_commit: { message: 'Secret commit message about Juan dela Cruz', author: { name: 'Juan dela Cruz', email: 'juan@gmail.com' } },
  repository: { full_name: 'octo-org/shop', owner: { login: 'octo-org' } },
  ...extra,
});

describe('reading runs: only the allowed fields, never people or messages', () => {
  it('GitHub: maps statuses, keeps 7 characters of the commit, and drops the actor, commit message and PR title', () => {
    const runs = parseRuns('github', {
      workflow_runs: [
        ghRun(1),
        ghRun(2, { conclusion: 'failure' }),
        ghRun(3, { conclusion: 'cancelled' }),
        ghRun(4, { status: 'in_progress', conclusion: null }),
        ghRun(5, { status: 'queued', conclusion: null }),
        ghRun(6, { conclusion: 'skipped' }),
        ghRun(7, { conclusion: 'timed_out' }),
      ],
    });
    expect(runs.map((r) => r.status)).toEqual(['passed', 'failed', 'cancelled', 'running', 'queued', 'other', 'failed']);
    expect(runs[0]).toMatchObject({ externalId: '1', name: 'CI', branch: 'main', sha7: 'abcdef0', url: 'https://github.com/octo-org/shop/actions/runs/1' });
    expect(runs[3]!.finishedAt).toBeNull(); // a running run has no finish time
    const all = JSON.stringify(runs);
    expect(all).not.toMatch(/maria|pedro|juan|Secret commit|PR title|avatars|login|abcdef0123456789/i);
  });

  it('Azure DevOps: maps statuses, strips refs/heads/, and drops who requested it', () => {
    const b = (id: number, extra: Record<string, unknown> = {}) => ({
      id,
      buildNumber: '20261126.1',
      definition: { name: 'Shop CI' },
      sourceBranch: 'refs/heads/feature/login',
      sourceVersion: '0123456789abcdef0123456789abcdef01234567',
      status: 'completed',
      result: 'succeeded',
      queueTime: ago(40),
      startTime: ago(35),
      finishTime: ago(30),
      requestedFor: { displayName: 'Maria Santos', uniqueName: 'maria@contoso.com' },
      requestedBy: { displayName: 'Pedro Cruz' },
      triggerInfo: { 'ci.message': 'Secret commit message' },
      _links: { web: { href: `https://dev.azure.com/my-org/Shop%20Web/_build/results?buildId=${id}` } },
      ...extra,
    });
    const runs = parseRuns('azure_devops', { value: [b(1), b(2, { result: 'failed' }), b(3, { result: 'canceled' }), b(4, { status: 'inProgress', result: undefined }), b(5, { status: 'notStarted', result: undefined }), b(6, { result: 'partiallySucceeded' })] });
    expect(runs.map((r) => r.status)).toEqual(['passed', 'failed', 'cancelled', 'running', 'queued', 'other']);
    expect(runs[0]).toMatchObject({ name: 'Shop CI', branch: 'feature/login', sha7: '0123456', url: 'https://dev.azure.com/my-org/Shop%20Web/_build/results?buildId=1' });
    expect(JSON.stringify(runs)).not.toMatch(/maria|pedro|contoso|Secret commit/i);
  });

  it('links that are not https on the provider’s own site are dropped; text is redacted, capped and cleaned; junk entries are skipped', () => {
    const runs = parseRuns('github', {
      workflow_runs: [
        ghRun(1, { html_url: 'https://evil.example/x' }),
        ghRun(2, { html_url: 'javascript:alert(1)' }),
        ghRun(3, { html_url: 'http://github.com/o/r/actions/runs/3' }),
        ghRun(4, { html_url: 'https://user:pw@github.com/o/r' }),
        ghRun(5, { name: 'Deploy token=abcdefghijklmnopqrstuvwxyz123456', head_branch: 'x'.repeat(500) + '\u0007' }),
        { id: null, name: 'bad' },
        'junk',
        null,
        ghRun(6, { run_started_at: 'not a date', created_at: undefined, updated_at: undefined }),
      ],
    });
    expect(runs).toHaveLength(6);
    expect(runs.slice(0, 4).map((r) => r.url)).toEqual(['', '', '', '']);
    expect(runs[4]!.name).not.toMatch(/abcdefghijklmnop/);
    expect(runs[4]!.branch.length).toBeLessThanOrEqual(200);
    expect(runs[5]).toMatchObject({ startedAt: null, finishedAt: null });
    expect(parseRuns('github', { nothing: 1 })).toEqual([]);
    expect(parseRuns('azure_devops', null)).toEqual([]);
  });

  it('reads at most 30 runs, builds the runs requests on the fixed hosts, and asks GitHub "has anything changed" with the saved validator', () => {
    expect(parseRuns('github', { workflow_runs: Array.from({ length: 100 }, (_, i) => ghRun(i + 1)) })).toHaveLength(30);
    const g = runsRequest('github', 'octo-org', 'shop', GH_TOKEN, '"abc123"');
    expect(g.url).toBe('https://api.github.com/repos/octo-org/shop/actions/runs?per_page=30');
    expect(g.headers['If-None-Match']).toBe('"abc123"');
    expect(runsRequest('github', 'octo-org', 'shop', GH_TOKEN).headers['If-None-Match']).toBeUndefined();
    const a = runsRequest('azure_devops', 'my-org', 'Shop Web', AZ_TOKEN, '"ignored"');
    expect(a.url).toBe('https://dev.azure.com/my-org/Shop%20Web/_apis/build/builds?%24top=30&queryOrder=queueTimeDescending&api-version=7.1');
    expect(a.headers['If-None-Match']).toBeUndefined();
  });

  it('understands 304 (unchanged), the validator and a rate-limit wait', async () => {
    const req = runsRequest('github', 'o', 'r', GH_TOKEN, '"v1"');
    const r304 = await callProvider('github', req, (async () => new Response(null, { status: 304, headers: { etag: '"v1"' } })) as unknown as typeof fetch);
    expect(r304).toMatchObject({ status: 304, notModified: true, redirected: false, etag: '"v1"' });
    const limited = await callProvider('github', req, (async () => json(403, {}, { 'x-ratelimit-remaining': '0', 'retry-after': '120' })) as unknown as typeof fetch);
    expect(limited).toMatchObject({ rateLimited: true, retryAfterMs: 120_000 });
  });
});

describe('refresh, retention and polling (service)', () => {
  let db: DB;
  let root: string;
  let pid: string;
  let secrets: ReturnType<typeof createMemoryStore>;
  let calls: Array<{ url: string; ifNoneMatch: string | undefined }>;
  let answer: () => Response;
  let deps: ci.CiDeps;
  let connId: string;
  beforeEach(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'qavo-ciruns-'));
    db = openDb(path.join(root, 'test.db'));
    const dir = path.join(root, 'Alpha');
    fs.mkdirSync(dir);
    pid = createProject(db, { alias: 'Alpha', path: dir }).project.id;
    secrets = createMemoryStore();
    calls = [];
    answer = () => json(200, { workflow_runs: [ghRun(1), ghRun(2, { conclusion: 'failure' })] }, { etag: '"v1"' });
    deps = {
      secrets,
      fetch: (async (url: string, init?: RequestInit) => (calls.push({ url: String(url), ifNoneMatch: (init?.headers as Record<string, string>)['If-None-Match'] }), answer())) as unknown as typeof fetch,
    };
    connId = (await ci.connect(db, deps, pid, { provider: 'github', owner: 'octo-org', name: 'shop', token: GH_TOKEN }, 'human')).id;
  });
  afterEach(() => {
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const http = async (p: Promise<unknown> | (() => unknown), status: number, code?: string) => {
    try {
      await (typeof p === 'function' ? p() : p);
    } catch (e) {
      expect(e).toBeInstanceOf(HttpError);
      expect((e as HttpError).status).toBe(status);
      if (code) expect((e as HttpError).code).toBe(code);
      expect(String((e as HttpError).message)).not.toContain(GH_TOKEN);
      return;
    }
    throw new Error('expected an HttpError');
  };
  const dbText = () =>
    (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map((t) => JSON.stringify(db.prepare(`SELECT * FROM "${t.name}"`).all())).join('\n');

  it('reads runs, saves only the allowed fields, and nothing about people or messages reaches the database', async () => {
    const r = await ci.refreshRuns(db, deps, connId, {}, 'human', NOW);
    expect(r.ok).toBe(true);
    expect(r.runs.map((x) => [x.status, x.name, x.branch, x.sha7])).toEqual([
      ['passed', 'CI', 'main', 'abcdef0'],
      ['failed', 'CI', 'main', 'abcdef0'],
    ]);
    expect(r.runs[0]!.durationMs).toBe(5 * 60_000);
    expect(r.connection).toMatchObject({ runsAsOf: new Date(NOW).toISOString(), lastRefreshOk: true, lastRefreshMessage: '' });
    expect(calls[0]!.url).toBe('https://api.github.com/repos/octo-org/shop/actions/runs?per_page=30');
    expect(dbText()).not.toMatch(/maria|pedro|juan|Secret commit|PR title|avatars|abcdef0123456789|gmail/i);
    expect(dbText()).not.toContain(GH_TOKEN);
  });

  it('the saved copy always equals the latest answer: a run that dropped out is removed, never left looking running', async () => {
    answer = () => json(200, { workflow_runs: [ghRun(1, { status: 'in_progress', conclusion: null }), ghRun(2)] });
    await ci.refreshRuns(db, deps, connId, {}, 'human', NOW);
    expect(ci.listRuns(db, deps, connId).runs.map((r) => r.status)).toEqual(['running', 'passed']);
    answer = () => json(200, { workflow_runs: [ghRun(2), ghRun(3)] });
    const r = await ci.refreshRuns(db, deps, connId, {}, 'human', NOW + 60_000);
    expect(r.runs.map((x) => x.name)).toHaveLength(2);
    expect((db.prepare("SELECT external_id AS e FROM ci_runs ORDER BY external_id").all() as Array<{ e: string }>).map((x) => x.e)).toEqual(['2', '3']);
  });

  it('keeps at most 30 runs and nothing older than 30 days', async () => {
    answer = () => json(200, { workflow_runs: [...Array.from({ length: 35 }, (_, i) => ghRun(i + 1)), ghRun(99, { run_started_at: new Date(NOW - 31 * 86_400_000).toISOString() })] });
    await ci.refreshRuns(db, deps, connId, {}, 'human', NOW);
    expect(ci.listRuns(db, deps, connId).runs).toHaveLength(30);
    answer = () => json(200, { workflow_runs: [ghRun(1), ghRun(98, { run_started_at: new Date(NOW - 31 * 86_400_000).toISOString() })] });
    await ci.refreshRuns(db, deps, connId, {}, 'human', NOW + 60_000);
    expect(ci.listRuns(db, deps, connId).runs).toHaveLength(1);
  });

  it('asks GitHub whether anything changed; "not modified" keeps the runs and moves "as of" forward', async () => {
    await ci.refreshRuns(db, deps, connId, {}, 'human', NOW);
    answer = () => new Response(null, { status: 304 });
    const r = await ci.refreshRuns(db, deps, connId, {}, 'human', NOW + 60_000);
    expect(calls[1]!.ifNoneMatch).toBe('"v1"');
    expect(r.ok).toBe(true);
    expect(r.runs).toHaveLength(2);
    expect(r.connection.runsAsOf).toBe(new Date(NOW + 60_000).toISOString());
  });

  it('an error keeps the saved runs "as of" their last good read, says why in our own words, and never invents a status', async () => {
    await ci.refreshRuns(db, deps, connId, {}, 'human', NOW);
    answer = () => json(401, { message: `Bad credentials ${GH_TOKEN}` });
    const r = await ci.refreshRuns(db, deps, connId, {}, 'human', NOW + 60_000);
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/rejected the token/);
    expect(r.runs).toHaveLength(2);
    expect(r.connection).toMatchObject({ runsAsOf: new Date(NOW).toISOString(), lastRefreshOk: false });
    expect(JSON.stringify(r)).not.toContain(GH_TOKEN);
    expect(dbText()).not.toContain(GH_TOKEN);
    answer = () => new Response(null, { status: 0 as 200 }) as Response; // an unusable answer
    await expect(ci.refreshRuns(db, deps, connId, {}, 'human', NOW + 120_000)).resolves.toMatchObject({ ok: false });
  });

  it('a rate limit makes the app wait as long as the provider asked, and says so', async () => {
    answer = () => json(403, {}, { 'x-ratelimit-remaining': '0', 'retry-after': '600' });
    const r = await ci.refreshRuns(db, deps, connId, {}, 'human', NOW);
    expect(r).toMatchObject({ ok: false });
    expect(r.message).toMatch(/too many requests/);
    const before = calls.length;
    await http(ci.refreshRuns(db, deps, connId, {}, 'human', NOW + 300_000), 429, 'backoff');
    expect(calls).toHaveLength(before); // no request was made while waiting
    answer = () => json(200, { workflow_runs: [ghRun(1)] });
    expect((await ci.refreshRuns(db, deps, connId, {}, 'human', NOW + 601_000)).ok).toBe(true);
  });

  it('manual refresh is limited to once every 10 seconds per connection', async () => {
    await ci.refreshRuns(db, deps, connId, {}, 'human', NOW);
    await http(ci.refreshRuns(db, deps, connId, {}, 'human', NOW + 5_000), 429, 'too_soon');
    expect(calls).toHaveLength(1);
    await ci.refreshRuns(db, deps, connId, {}, 'human', NOW + 11_000);
    expect(calls).toHaveLength(2);
  });

  it('polling is off by default, and the server (not the browser) enforces: on only when a person turns it on, never faster than every 5 minutes, and it stops after 2 hours', async () => {
    expect(ci.listRuns(db, deps, connId).connection).toMatchObject({ pollingEnabled: false, pollingUntil: null });
    await http(ci.refreshRuns(db, deps, connId, { polling: true }, 'human', NOW), 409, 'polling_off');
    expect(calls).toHaveLength(0);
    const c = ci.setPolling(db, deps, connId, { enabled: true }, 'human', Date.now());
    expect(c.pollingEnabled).toBe(true);
    const t0 = Date.now();
    await ci.refreshRuns(db, deps, connId, { polling: true }, 'human', t0);
    await http(ci.refreshRuns(db, deps, connId, { polling: true }, 'human', t0 + 60_000), 429, 'too_soon'); // 1 minute later
    await http(ci.refreshRuns(db, deps, connId, { polling: true }, 'human', t0 + 4 * 60_000), 429, 'too_soon'); // 4 minutes later
    await ci.refreshRuns(db, deps, connId, { polling: true }, 'human', t0 + 5 * 60_000); // 5 minutes later is fine
    expect(calls).toHaveLength(2);
    // after the 2 hour window the server refuses polling refreshes without any click
    await http(ci.refreshRuns(db, deps, connId, { polling: true }, 'human', t0 + 2 * 3_600_000 + 10 * 60_000), 409, 'polling_off');
    // turning it off works, and polling needs a stored token
    ci.setPolling(db, deps, connId, { enabled: false }, 'human');
    expect(ci.listRuns(db, deps, connId).connection.pollingEnabled).toBe(false);
    await secrets.remove(connId);
    await http(() => ci.setPolling(db, deps, connId, { enabled: true }, 'human'), 409, 'token_missing');
  });

  it('a click keeps polling alive for another 2 hours', async () => {
    ci.setPolling(db, deps, connId, { enabled: true }, 'human', NOW);
    await ci.refreshRuns(db, deps, connId, {}, 'human', NOW + 100 * 60_000); // a click after 100 minutes
    const until = (db.prepare('SELECT polling_until AS u FROM ci_connections WHERE id = ?').get(connId) as { u: string }).u;
    expect(Date.parse(until)).toBe(NOW + 100 * 60_000 + 2 * 3_600_000);
  });

  it('only a person can refresh, read the runs through the API, or change polling; disconnect removes the runs', async () => {
    for (const actor of ['agent', 'system'] as const) {
      await http(ci.refreshRuns(db, deps, connId, {}, actor), 403, 'human_required');
      await http(() => ci.setPolling(db, deps, connId, { enabled: true }, actor), 403, 'human_required');
    }
    expect(calls).toHaveLength(0);
    await http(ci.refreshRuns(db, deps, connId, { surprise: 1 }, 'human', NOW), 400, 'invalid_input');
    await ci.refreshRuns(db, deps, connId, {}, 'human', NOW);
    await ci.disconnect(db, deps, connId, 'human');
    expect((db.prepare('SELECT COUNT(*) AS n FROM ci_runs').get() as { n: number }).n).toBe(0);
  });
});

describe('HTTP', () => {
  it('the new routes need the signed-in person and never answer with the token or people', async () => {
    const secrets = createMemoryStore();
    const env = await makeEnv({ auth: true, ci: { secrets, fetch: (async () => json(200, { workflow_runs: [ghRun(1)] })) as unknown as typeof fetch } });
    try {
      const cookie = `${COOKIE_NAME}=${env.auth.issueSession()}`;
      const dir = path.join(env.root, 'Shop');
      fs.mkdirSync(dir);
      const ui = (method: string, url: string, payload?: unknown) => env.app.inject({ method: method as 'GET', url, headers: { ...uiHeaders(env), cookie }, payload: payload as object });
      const pid = (await ui('POST', '/api/projects', { alias: 'Shop', path: dir })).json().project.id as string;
      const id = (await ui('POST', `/api/projects/${pid}/ci/connections`, { provider: 'github', owner: 'octo-org', name: 'shop', token: GH_TOKEN })).json().id as string;
      const r = await ui('POST', `/api/ci/connections/${id}/refresh`, {});
      expect(r.statusCode).toBe(200);
      expect(r.body).not.toMatch(/maria|juan|PR title|gmail/i);
      expect(r.body).not.toContain(GH_TOKEN);
      expect((await ui('GET', `/api/ci/connections/${id}/runs`)).json().runs).toHaveLength(1);
      expect((await ui('PUT', `/api/ci/connections/${id}/polling`, { enabled: true })).json().pollingEnabled).toBe(true);
      for (const [method, url] of [['GET', `/api/ci/connections/${id}/runs`], ['POST', `/api/ci/connections/${id}/refresh`], ['PUT', `/api/ci/connections/${id}/polling`]] as const) {
        expect((await env.app.inject({ method, url, headers: { ...uiHeaders(env) }, payload: {} })).statusCode, `${method} ${url} without cookie`).toBe(401);
        expect((await env.app.inject({ method, url, headers: { host: env.host, 'x-qavo-agent-token': readAgentToken(env.paths) }, payload: {} })).statusCode).toBeGreaterThanOrEqual(400);
        expect((await env.app.inject({ method, url, headers: { host: env.host, 'x-qavo-token': env.token }, payload: {} })).statusCode).toBeGreaterThanOrEqual(400);
      }
    } finally {
      await env.cleanup().catch(() => undefined);
    }
  });
});
