/**
 * V4b server side: permission requests a person answers from the office.
 * The rules under test: off by default; only a person decides; allow needs the details; a decision is final and
 * erases the summary; requests expire; the agent token and the hook token can never decide anything.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { COOKIE_NAME } from '../src/auth.ts';
import { readAgentToken } from '../src/dataDir.ts';
import { openDb, type DB } from '../src/db/index.ts';
import { createRequest, decide, expireOnEvent, expireForSession, listPending, MAX_PENDING, recentDecisions, setBridge, statusOf, sweep } from '../src/permissions.ts';
import { HttpError } from '../src/store.ts';
import { hookHeaders, makeEnv, uiHeaders, type TestEnv } from './helpers.ts';

const NOW = 2_000_000_000_000;
const input = (over: Record<string, unknown> = {}) => ({ sessionId: 'sess-1', projectId: null, toolName: 'Bash', summary: 'npm test', ...over });

function http(fn: () => unknown, status: number, code?: string) {
  try {
    fn();
  } catch (e) {
    expect(e, `expected HttpError, got ${String(e)}`).toBeInstanceOf(HttpError);
    expect((e as HttpError).status).toBe(status);
    if (code) expect((e as HttpError).code).toBe(code);
    return;
  }
  throw new Error(`expected HttpError ${status}${code ? ' ' + code : ''}, but nothing was thrown`);
}

describe('permission service', () => {
  let db: DB;
  let root: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'qavo-perm-'));
    db = openDb(path.join(root, 'test.db'));
  });
  afterEach(() => {
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('is OFF by default: no request is accepted until a person turns the bridge on', () => {
    http(() => createRequest(db, input(), NOW), 409, 'bridge_disabled');
    setBridge(db, true);
    expect(createRequest(db, input(), NOW).id).toMatch(/^prm_/);
    setBridge(db, false);
    http(() => createRequest(db, input(), NOW), 409, 'bridge_disabled');
  });

  it('validates input strictly and stores only safe, redacted values', () => {
    setBridge(db, true);
    http(() => createRequest(db, input({ sessionId: '../x' }), NOW), 400, 'invalid_input');
    http(() => createRequest(db, input({ extra: 1 }), NOW), 400, 'invalid_input');
    http(() => createRequest(db, input({ summary: 'x'.repeat(3000) }), NOW), 400, 'invalid_input');
    const r = createRequest(db, input({ toolName: 'Bash; rm -rf /', summary: 'echo jane.doe@example.com with key sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789', projectId: 'no-such-project' }), NOW);
    const row = db.prepare('SELECT tool_name, summary, project_id FROM permission_requests WHERE id = ?').get(r.id) as { tool_name: string; summary: string; project_id: string | null };
    expect(row.tool_name).toBe('tool');
    expect(row.summary).not.toContain('jane.doe@example.com');
    expect(row.summary).not.toContain('sk-ant-');
    expect(row.project_id).toBeNull();
  });

  it('caps how many requests can wait at once', () => {
    setBridge(db, true);
    for (let i = 0; i < MAX_PENDING; i++) createRequest(db, input({ sessionId: 's' + i }), NOW);
    http(() => createRequest(db, input(), NOW), 429, 'too_many_pending');
  });

  it('only a person can decide: agents, the system and anything else are refused', () => {
    setBridge(db, true);
    const { id } = createRequest(db, input(), NOW);
    for (const actor of ['agent', 'system'] as const) http(() => decide(db, id, 'allow', actor, NOW), 403, 'human_required');
    expect(statusOf(db, id, NOW)!.status).toBe('pending');
    http(() => decide(db, id, 'maybe', 'human', NOW), 400, 'invalid_input');
    http(() => decide(db, 'nope', 'deny', 'human', NOW), 404, 'request_not_found');
  });

  it('ALLOW needs the details (a person must not approve what they cannot see); DENY always works', () => {
    setBridge(db, true);
    const blind = createRequest(db, input({ summary: null }), NOW);
    http(() => decide(db, blind.id, 'allow', 'human', NOW), 422, 'details_hidden');
    expect(statusOf(db, blind.id, NOW)!.status).toBe('pending');
    expect(decide(db, blind.id, 'deny', 'human', NOW)).toEqual({ status: 'denied' });
    const seen = createRequest(db, input(), NOW);
    expect(decide(db, seen.id, 'allow', 'human', NOW)).toEqual({ status: 'allowed' });
  });

  it('a decision is final, single-use, and erases the command summary', () => {
    setBridge(db, true);
    const { id } = createRequest(db, input({ summary: 'rm -rf build' }), NOW);
    decide(db, id, 'allow', 'human', NOW + 1000);
    expect((db.prepare('SELECT summary FROM permission_requests WHERE id = ?').get(id) as { summary: string | null }).summary).toBeNull();
    http(() => decide(db, id, 'deny', 'human', NOW + 2000), 409, 'not_pending');
    http(() => decide(db, id, 'allow', 'human', NOW + 2000), 409, 'not_pending');
    expect(statusOf(db, id, NOW + 2000)!.status).toBe('allowed');
    // the database itself refuses to flip a decision
    expect(() => db.prepare("UPDATE permission_requests SET status = 'denied' WHERE id = ?").run(id)).toThrow(/final/);
  });

  it('the database refuses an allowed/denied row that was not decided by a human', () => {
    setBridge(db, true);
    const { id } = createRequest(db, input(), NOW);
    for (const by of ['agent', 'system', null]) {
      expect(() => db.prepare("UPDATE permission_requests SET status = 'allowed', decided_by = ?, decided_at = ? WHERE id = ?").run(by, NOW, id)).toThrow();
    }
    expect(() => db.prepare("UPDATE permission_requests SET status = 'allowed', decided_by = 'human' WHERE id = ?").run(id)).toThrow(); // no timestamp
    expect(() => db.prepare("UPDATE permission_requests SET status = 'allowed', decided_by = 'human', decided_at = ? WHERE id = ?").run(NOW, id)).not.toThrow();
  });

  it('a request expires on its own (summary erased) and an expired request cannot be answered', () => {
    setBridge(db, true);
    const { id, expiresAt } = createRequest(db, input(), NOW, 60);
    expect(expiresAt).toBe(NOW + 60_000);
    expect(statusOf(db, id, NOW + 59_000)!.status).toBe('pending');
    expect(statusOf(db, id, NOW + 60_001)!.status).toBe('expired');
    expect((db.prepare('SELECT summary FROM permission_requests WHERE id = ?').get(id) as { summary: string | null }).summary).toBeNull();
    http(() => decide(db, id, 'allow', 'human', NOW + 61_000), 409, 'not_pending');
    expect(listPending(db, NOW + 61_000)).toEqual([]);
  });

  it('old answered requests are forgotten after a week', () => {
    setBridge(db, true);
    const { id } = createRequest(db, input(), NOW);
    decide(db, id, 'deny', 'human', NOW + 1000);
    sweep(db, NOW + 6 * 24 * 3600_000);
    expect(statusOf(db, id, NOW + 6 * 24 * 3600_000)).not.toBeNull();
    sweep(db, NOW + 8 * 24 * 3600_000);
    expect(statusOf(db, id, NOW + 8 * 24 * 3600_000)).toBeNull();
  });

  it('listing shows what is waiting without extra fields, and recent decisions never include the command', () => {
    setBridge(db, true);
    const a = createRequest(db, input({ summary: 'npm test' }), NOW);
    createRequest(db, input({ sessionId: 's2', summary: null }), NOW + 1);
    const list = listPending(db, NOW + 2);
    expect(list.map((r) => [r.toolName, r.canAllow])).toEqual([['Bash', true], ['Bash', false]]);
    decide(db, a.id, 'allow', 'human', NOW + 3);
    const recent = recentDecisions(db);
    expect(recent).toHaveLength(1);
    expect(Object.keys(recent[0]!).sort()).toEqual(['at', 'project', 'reason', 'status', 'tool']);
    expect(JSON.stringify(recent)).not.toContain('npm test');
  });

  it('when the session carries on, its waiting request expires: same tool finished, turn ended, session ended; never for subagents or other sessions', () => {
    setBridge(db, true);
    const mk = (sessionId: string, toolName = 'Bash') => createRequest(db, input({ sessionId, toolName }), NOW).id;
    const a = mk('sess-a');
    const b = mk('sess-b');
    expect(expireOnEvent(db, { sessionId: 'sess-a', event: 'PostToolUse', toolName: 'Read' })).toBe(0); // a different tool finished
    expect(expireOnEvent(db, { sessionId: 'sess-a', event: 'PostToolUse', toolName: 'Bash', agentId: 'sub1' })).toBe(0); // a subagent
    expect(expireOnEvent(db, { sessionId: 'sess-a', event: 'PreToolUse', toolName: 'Bash' })).toBe(0);
    expect(expireOnEvent(db, { sessionId: 'sess-a', event: 'Notification' })).toBe(0);
    expect(statusOf(db, a, NOW)!.status).toBe('pending');
    expect(expireOnEvent(db, { sessionId: 'sess-a', event: 'PostToolUse', toolName: 'Bash' })).toBe(1);
    expect(statusOf(db, a, NOW)!.status).toBe('expired');
    expect(statusOf(db, b, NOW)!.status).toBe('pending');
    expect(expireOnEvent(db, { sessionId: 'sess-b', event: 'Stop' })).toBe(1);
    const c = mk('sess-c');
    expect(expireOnEvent(db, 'garbage')).toBe(0);
    expect(expireForSession(db, 'sess-c', 'test')).toBe(1);
    expect(statusOf(db, c, NOW)!.status).toBe('expired');
  });
});

// ---------------------------------------------------------------------------- HTTP
describe('permission HTTP surface', () => {
  let env: TestEnv;
  let cookie: string;
  beforeEach(async () => {
    env = await makeEnv({ listen: true, auth: true });
    cookie = `${COOKIE_NAME}=${env.auth.issueSession()}`;
  });
  afterEach(async () => env.cleanup());

  const ui = async (method: string, url: string, payload?: unknown) => {
    const r = await env.app.inject({ method: method as 'GET', url, headers: { ...uiHeaders(env), cookie }, payload: payload as object });
    return { status: r.statusCode, body: r.body ? r.json() : null };
  };
  const hook = async (method: string, url: string, payload?: unknown) => {
    const r = await env.app.inject({ method: method as 'GET', url, headers: hookHeaders(env), payload: payload as object });
    return { status: r.statusCode, body: r.body ? r.json() : null };
  };
  const enable = () => ui('PUT', '/api/settings/permission-bridge', { enabled: true, confirm: true });
  const ask = async (summary: string | null = 'npm test') => (await hook('POST', '/api/permission-hook/request', input({ summary }))).body.id as string;

  it('the person turns the bridge on (with a confirmation) and the capture policy follows', async () => {
    expect((await ui('PUT', '/api/settings/permission-bridge', { enabled: true })).body.error).toBe('confirm_required');
    expect((await ui('GET', '/api/settings/permission-bridge')).body.enabled).toBe(false);
    expect((await hook('POST', '/api/permission-hook/request', input())).status).toBe(409); // off: refused
    expect((await enable()).body.enabled).toBe(true);
    const policy = JSON.parse(fs.readFileSync(env.paths.policy, 'utf8'));
    expect(policy.permissionBridge).toEqual({ enabled: true, waitSeconds: 110 });
    await ui('PUT', '/api/settings/permission-bridge', { enabled: false });
    expect(JSON.parse(fs.readFileSync(env.paths.policy, 'utf8')).permissionBridge.enabled).toBe(false);
  });

  it('full flow: the hook asks, the person sees it and decides, the hook is told; one answer only', async () => {
    await enable();
    const id = await ask('npm test');
    const pending = (await ui('GET', '/api/permissions/pending')).body;
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ id, toolName: 'Bash', summary: 'npm test', canAllow: true });
    expect((await hook('GET', `/api/permission-hook/wait/${id}?wait=300`)).body.status).toBe('pending');
    expect((await ui('POST', `/api/permissions/${id}/decide`, { decision: 'allow' })).body.status).toBe('allowed');
    expect((await hook('GET', `/api/permission-hook/wait/${id}?wait=300`)).body.status).toBe('allowed');
    expect((await ui('POST', `/api/permissions/${id}/decide`, { decision: 'deny' })).status).toBe(409);
    expect((await ui('GET', '/api/permissions/pending')).body).toEqual([]);
  });

  it('a waiting hook is released the moment the person decides (long poll)', async () => {
    await enable();
    const id = await ask();
    const waiting = hook('GET', `/api/permission-hook/wait/${id}?wait=5000`);
    await new Promise((r) => setTimeout(r, 300));
    await ui('POST', `/api/permissions/${id}/decide`, { decision: 'deny' });
    const t0 = Date.now();
    expect((await waiting).body.status).toBe('denied');
    expect(Date.now() - t0).toBeLessThan(2000);
  });

  it('a request without details can be denied but not allowed', async () => {
    await enable();
    const id = await ask(null);
    expect((await ui('GET', '/api/permissions/pending')).body[0].canAllow).toBe(false);
    const r = await ui('POST', `/api/permissions/${id}/decide`, { decision: 'allow' });
    expect(r.status).toBe(422);
    expect(r.body.error).toBe('details_hidden');
    expect((await ui('POST', `/api/permissions/${id}/decide`, { decision: 'deny' })).body.status).toBe('denied');
  });

  it('an unanswered request expires and the hook is told so; a late answer is refused', async () => {
    await enable();
    const id = await ask();
    env.db.prepare('UPDATE permission_requests SET expires_at = ? WHERE id = ?').run(Date.now() - 1000, id);
    expect((await hook('GET', `/api/permission-hook/wait/${id}?wait=0`)).body.status).toBe('expired');
    expect((await ui('POST', `/api/permissions/${id}/decide`, { decision: 'allow' })).status).toBe(409);
    expect((await hook('GET', '/api/permission-hook/wait/unknown_id?wait=0')).status).toBe(404);
  });

  it('a real "carried on" event expires the waiting request (answered in the terminal)', async () => {
    await enable();
    const id = await ask();
    const send = (event: string, extra: Record<string, unknown> = {}) =>
      env.app.inject({ method: 'POST', url: '/api/hooks', headers: hookHeaders(env), payload: { v: 1, eventId: crypto.randomUUID(), ts: new Date().toISOString(), sessionId: 'sess-1', event, projectId: null, folderKeys: [], ...extra } });
    await send('SessionStart', { source: 'startup' });
    await send('PreToolUse', { toolName: 'Bash' });
    expect((await hook('GET', `/api/permission-hook/wait/${id}?wait=0`)).body.status).toBe('pending');
    await send('PostToolUse', { toolName: 'Bash' });
    expect((await hook('GET', `/api/permission-hook/wait/${id}?wait=0`)).body.status).toBe('expired');
  });

  describe('who can reach what', () => {
    it('the hook routes need the hook token and no Origin; the agent token and a browser cookie are not enough', async () => {
      await enable();
      const body = input();
      const bad = [
        { headers: { host: env.host, 'content-type': 'application/json' } },
        { headers: { host: env.host, 'content-type': 'application/json', 'x-qavo-token': 'x'.repeat(64) } },
        { headers: { host: env.host, 'content-type': 'application/json', 'x-qavo-agent-token': readAgentToken(env.paths) } },
        { headers: { ...hookHeaders(env), origin: 'https://evil.example' } },
        { headers: { ...uiHeaders(env), cookie } },
      ];
      for (const b of bad) expect((await env.app.inject({ method: 'POST', url: '/api/permission-hook/request', headers: b.headers, payload: body })).statusCode, JSON.stringify(Object.keys(b.headers))).toBeGreaterThanOrEqual(401);
      expect(env.db.prepare('SELECT COUNT(*) AS c FROM permission_requests').get()).toEqual({ c: 0 });
      const id = await ask();
      expect((await env.app.inject({ method: 'GET', url: `/api/permission-hook/wait/${id}?wait=0`, headers: { host: env.host } })).statusCode).toBe(401);
    });

    it('NOBODY but the signed-in person can decide: not the hook token, not the agent token, not a browser without the CSRF header', async () => {
      await enable();
      const id = await ask();
      const attempts = [
        { host: env.host, 'x-qavo-token': env.token, 'content-type': 'application/json' },
        { host: env.host, 'x-qavo-agent-token': readAgentToken(env.paths), 'content-type': 'application/json' },
        { host: env.host, origin: env.origin, 'x-qavo-client': '1', 'content-type': 'application/json' }, // no session cookie
        { host: env.host, origin: env.origin, cookie, 'content-type': 'application/json' }, // no CSRF header
        { ...uiHeaders(env), cookie: 'qavo_session=forged', 'content-type': 'application/json' },
      ];
      for (const headers of attempts) {
        const r = await env.app.inject({ method: 'POST', url: `/api/permissions/${id}/decide`, headers, payload: { decision: 'allow' } });
        expect(r.statusCode).toBeGreaterThanOrEqual(401);
        expect(r.statusCode).toBeLessThan(500);
      }
      expect(env.db.prepare('SELECT status FROM permission_requests WHERE id = ?').get(id)).toEqual({ status: 'pending' });
      // listing is private too
      expect((await env.app.inject({ method: 'GET', url: '/api/permissions/pending', headers: { host: env.host, 'x-qavo-agent-token': readAgentToken(env.paths) } })).statusCode).toBe(401);
    });
  });
});

// ---------------------------------------------------------------------------- installer
describe('permission hook installer', () => {
  let env: TestEnv;
  let cookie: string;
  const read = () => JSON.parse(fs.readFileSync(env.settingsPath, 'utf8')) as { hooks?: Record<string, Array<{ hooks?: Array<Record<string, unknown>> }>> } & Record<string, unknown>;
  const ui = async (method: string, url: string, payload?: unknown) => {
    const r = await env.app.inject({ method: method as 'GET', url, headers: { ...uiHeaders(env), cookie }, payload: payload as object });
    return { status: r.statusCode, body: r.body ? r.json() : null };
  };
  beforeEach(async () => {
    env = await makeEnv({ listen: true, auth: true });
    cookie = `${COOKIE_NAME}=${env.auth.issueSession()}`;
  });
  afterEach(async () => env.cleanup());

  it('shows a plan (with the warning, no paths) and installs only after an acknowledgement', async () => {
    fs.mkdirSync(path.dirname(env.settingsPath), { recursive: true });
    fs.writeFileSync(env.settingsPath, JSON.stringify({ model: 'x' }));
    const plan = (await ui('GET', '/api/integration/permission-hook/plan?action=install')).body;
    expect(plan).toMatchObject({ kind: 'permission', eventsAdded: ['PermissionRequest'], noChange: false, willCreateBackup: true });
    expect(plan.warning).toContain('never approves anything by itself');
    expect(plan.handler).toMatchObject({ async: false, timeout: 130 });
    expect(JSON.stringify(plan)).not.toContain(env.root);
    expect((await ui('POST', '/api/integration/permission-hook/install', {})).body.error).toBe('acknowledge_required');
    expect(read().hooks).toBeUndefined();
    const r = (await ui('POST', '/api/integration/permission-hook/install', { acknowledge: true })).body;
    expect(r).toMatchObject({ changed: true, verified: true, backupCreated: true });
  });

  it('adds ONE synchronous entry on PermissionRequest only, keeps everything else, and is idempotent', async () => {
    fs.mkdirSync(path.dirname(env.settingsPath), { recursive: true });
    const mine = { type: 'command', command: 'my-own-permission-hook' };
    fs.writeFileSync(env.settingsPath, JSON.stringify({ model: 'x', hooks: { PermissionRequest: [{ hooks: [mine] }], Stop: [{ hooks: [{ type: 'command', command: 'keep-me' }] }] } }));
    await ui('POST', '/api/integration/permission-hook/install', { acknowledge: true });
    const s = read();
    expect(s.model).toBe('x');
    expect(s.hooks!.Stop).toEqual([{ hooks: [{ type: 'command', command: 'keep-me' }] }]);
    expect(Object.keys(s.hooks!).sort()).toEqual(['PermissionRequest', 'Stop']);
    const groups = s.hooks!.PermissionRequest!;
    expect(groups).toHaveLength(2);
    expect(groups[0]).toEqual({ hooks: [mine] }); // the user's own hook is untouched
    const ours = groups[1]!.hooks![0]!;
    expect(ours).toMatchObject({ type: 'command', async: false, timeout: 130 });
    expect(String((ours.args as string[])[0])).toMatch(/permission\.mjs$/);
    const again = (await ui('POST', '/api/integration/permission-hook/install', { acknowledge: true })).body;
    expect(again.changed).toBe(false);
    expect(read().hooks!.PermissionRequest).toHaveLength(2);
    expect((await ui('GET', '/api/settings/permission-bridge')).body.hook.state).toBe('installed');
  });

  it('uninstall removes only our entry and restores the file exactly', async () => {
    fs.mkdirSync(path.dirname(env.settingsPath), { recursive: true });
    const original = { model: 'x', hooks: { PermissionRequest: [{ hooks: [{ type: 'command', command: 'my-own-permission-hook' }] }] } };
    fs.writeFileSync(env.settingsPath, JSON.stringify(original));
    await ui('POST', '/api/integration/permission-hook/install', { acknowledge: true });
    expect((await ui('POST', '/api/integration/permission-hook/uninstall')).body).toMatchObject({ changed: true, verified: true });
    expect(read()).toEqual(original);
    // a file that had no hooks at all is restored to having none
    fs.writeFileSync(env.settingsPath, JSON.stringify({ model: 'y' }));
    await ui('POST', '/api/integration/permission-hook/install', { acknowledge: true });
    await ui('POST', '/api/integration/permission-hook/uninstall');
    expect(read()).toEqual({ model: 'y' });
    expect((await ui('GET', '/api/settings/permission-bridge')).body.hook.state).toBe('not_installed');
  });

  it('refuses to touch a settings file that is not valid JSON', async () => {
    fs.mkdirSync(path.dirname(env.settingsPath), { recursive: true });
    fs.writeFileSync(env.settingsPath, '{ not json');
    const r = await ui('POST', '/api/integration/permission-hook/install', { acknowledge: true });
    expect(r.status).toBe(409);
    expect(r.body.error).toBe('settings_invalid_json');
    expect(fs.readFileSync(env.settingsPath, 'utf8')).toBe('{ not json');
  });

  it('does not disturb the status hooks and is not counted as one', async () => {
    await ui('POST', '/api/integration/hooks/install', { acknowledge: true });
    const before = read().hooks!;
    await ui('POST', '/api/integration/permission-hook/install', { acknowledge: true });
    const after = read().hooks!;
    expect(after.PreToolUse).toEqual(before.PreToolUse);
    expect(after.PermissionRequest).toHaveLength(2); // the async status hook + our synchronous one
    const handlers = after.PermissionRequest!.flatMap((g) => g.hooks!);
    expect(handlers.filter((h) => h.async === true)).toHaveLength(1);
    expect(handlers.filter((h) => h.async === false)).toHaveLength(1);
    await ui('POST', '/api/integration/permission-hook/uninstall');
    expect(read().hooks).toEqual(before);
  });
});

describe('demo mode never touches Claude settings for the permission hook either', () => {
  it('refuses to install it', async () => {
    const env = await makeEnv({ listen: true, auth: true, demo: true });
    try {
      const cookie = `${COOKIE_NAME}=${env.auth.issueSession()}`;
      const r = await env.app.inject({ method: 'POST', url: '/api/integration/permission-hook/install', headers: { ...uiHeaders(env), cookie }, payload: { acknowledge: true } });
      expect(r.statusCode).toBe(403);
      expect(r.json().error).toBe('demo_mode');
      expect(fs.existsSync(env.settingsPath)).toBe(false);
    } finally {
      await env.cleanup();
    }
  });
});
