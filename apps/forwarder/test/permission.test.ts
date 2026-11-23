/**
 * The permission hook (V4b). The most important property: it NEVER decides on its own. It prints a decision only
 * after the server reports that a person allowed or denied; every other path prints nothing and exits 0, which
 * leaves Claude Code's normal permission prompt in place.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { lexicalForm } from '@qavo/shared/paths';
import { decisionJson, MAX_WAIT_SECONDS, runPermissionHook } from '../src/permissionCore.ts';

const ROOT = path.resolve(__dirname, '../../..');
const BUNDLE = path.join(ROOT, 'apps/forwarder/dist/permission.mjs');
const TOKEN = 'perm-token-0123456789abcdef';
const CANARY_CMD = 'curl -H "Authorization: Bearer CANARYSECRET0123456789abcd" https://x.example && echo CANARY-COMMAND-BODY';

let tmp: string;
let projectDir: string;
let otherDir: string;

function policyFor(dataDir: string, over: Record<string, unknown> = {}, bridge: Record<string, unknown> | false = { enabled: true, waitSeconds: 60 }) {
  const policy: Record<string, unknown> = {
    schema: 1,
    version: 5,
    generatedAt: new Date().toISOString(),
    scope: 'registered',
    capture: { prompts: false, toolInputs: false, toolOutputs: false, notificationText: false },
    projects: [{ id: 'proj_A', lexical: lexicalForm(projectDir), canonical: null }],
    excludes: [],
    collector: { port: 9 },
    ...(bridge ? { permissionBridge: bridge } : {}),
    ...over,
  };
  fs.writeFileSync(path.join(dataDir, 'capture-policy.json'), JSON.stringify(policy));
}
function newDataDir(): string {
  const d = fs.mkdtempSync(path.join(tmp, 'data-'));
  fs.writeFileSync(path.join(d, 'token'), TOKEN);
  return d;
}
const payload = (over: Record<string, unknown> = {}) =>
  JSON.stringify({ session_id: 'sess-1', cwd: projectDir, hook_event_name: 'PermissionRequest', permission_mode: 'default', tool_name: 'Bash', tool_input: { command: CANARY_CMD, description: 'x' }, ...over });

interface Call {
  url: string;
  method: string;
  body: string;
  token: string | null;
}
/** A fake server: the request is accepted, then the wait endpoint answers with the scripted statuses. */
function fakeFetch(statuses: string[], opts: { requestStatus?: number; throwOn?: 'request' | 'wait'; clock?: { t: number } } = {}) {
  const calls: Call[] = [];
  let i = 0;
  const impl = (async (url: string, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({ url, method: init?.method ?? 'GET', body: typeof init?.body === 'string' ? init.body : '', token: headers['x-qavo-token'] ?? null });
    if (url.endsWith('/request')) {
      if (opts.throwOn === 'request') throw new Error('connect ECONNREFUSED');
      if ((opts.requestStatus ?? 200) !== 200) return new Response('{"error":"bridge_disabled"}', { status: opts.requestStatus });
      return new Response(JSON.stringify({ id: 'prm_abc123', status: 'pending' }), { status: 200 });
    }
    if (opts.throwOn === 'wait') throw new Error('network down');
    if (opts.clock) opts.clock.t += 20_000;
    const status = statuses[Math.min(i++, statuses.length - 1)]!;
    return new Response(JSON.stringify({ status }), { status: 200 });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qavo-perm-'));
  projectDir = path.join(tmp, 'Project');
  otherDir = path.join(tmp, 'Elsewhere');
  fs.mkdirSync(projectDir);
  fs.mkdirSync(otherDir);
  execFileSync(process.execPath, [path.join(ROOT, 'apps/forwarder/build.mjs')], { stdio: 'ignore' });
});
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe('the decision JSON follows the documented Claude Code format and carries nothing extra', () => {
  it('allow grants this one request only (no updated input, no permanent rules)', () => {
    expect(JSON.parse(decisionJson('allow'))).toEqual({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } });
    const text = decisionJson('allow');
    expect(text).not.toMatch(/updatedInput|updatedPermissions|addRules|setMode/);
  });
  it('deny says why and does not stop the whole session', () => {
    expect(JSON.parse(decisionJson('deny'))).toEqual({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'deny', message: 'Denied from QA Virtual Office', interrupt: false } } });
  });
});

describe('it stays completely silent (and makes no network call) unless everything is in place', () => {
  const silent = async (dataDir: string, stdin: string, expectOutcome: string) => {
    const f = fakeFetch(['allowed']);
    const r = await runPermissionHook({ dataDir, stdinText: stdin, fetchImpl: f.impl });
    expect(r.stdout).toBe('');
    expect(r.outcome).toBe(expectOutcome);
    expect(f.calls).toEqual([]);
  };
  it('the bridge is off (default, or no setting in an older policy file)', async () => {
    const a = newDataDir();
    policyFor(a, {}, { enabled: false, waitSeconds: 60 });
    await silent(a, payload(), 'ignored:bridge_off');
    const b = newDataDir();
    policyFor(b, {}, false); // an older policy without the field
    await silent(b, payload(), 'ignored:bridge_off');
  });
  it('there is no policy file (fail closed)', async () => {
    await silent(newDataDir(), payload(), 'ignored:bridge_off');
  });
  it('the folder is not a registered project, even when scope is "all sessions"', async () => {
    const d = newDataDir();
    policyFor(d);
    await silent(d, payload({ cwd: otherDir }), 'ignored:unregistered');
    policyFor(d, { scope: 'all' });
    await silent(d, payload({ cwd: otherDir }), 'ignored:unregistered');
  });
  it('the folder is excluded', async () => {
    const d = newDataDir();
    policyFor(d, { excludes: [{ lexical: lexicalForm(projectDir), canonical: null }] });
    await silent(d, payload(), 'ignored:unregistered');
  });
  it('it is not a permission request, or the payload is not valid', async () => {
    const d = newDataDir();
    policyFor(d);
    await silent(d, payload({ hook_event_name: 'PreToolUse' }), 'ignored:not_a_permission_request');
    await silent(d, 'this is not json', 'ignored:invalid_payload');
    await silent(d, '[1,2]', 'ignored:invalid_payload');
    await silent(d, payload({ session_id: '../../etc' }), 'ignored:invalid_payload');
  });
  it('there is no hook token', async () => {
    const d = newDataDir();
    fs.rmSync(path.join(d, 'token'));
    policyFor(d);
    await silent(d, payload(), 'ignored:no_token');
  });
});

describe('it asks the server and relays ONLY a person\'s decision', () => {
  it('"allowed" prints the allow decision; "denied" prints the deny decision', async () => {
    const d = newDataDir();
    policyFor(d);
    const a = await runPermissionHook({ dataDir: d, stdinText: payload(), fetchImpl: fakeFetch(['pending', 'allowed']).impl });
    expect(a.outcome).toBe('allowed');
    expect(JSON.parse(a.stdout).hookSpecificOutput.decision).toEqual({ behavior: 'allow' });
    const b = await runPermissionHook({ dataDir: d, stdinText: payload(), fetchImpl: fakeFetch(['denied']).impl });
    expect(b.outcome).toBe('denied');
    expect(JSON.parse(b.stdout).hookSpecificOutput.decision.behavior).toBe('deny');
  });

  it('every other outcome prints nothing: expired, unknown, refused, unreachable, network failure', async () => {
    const d = newDataDir();
    policyFor(d);
    const cases: Array<[ReturnType<typeof fakeFetch>, string]> = [
      [fakeFetch(['expired']), 'no_answer'],
      [fakeFetch(['unknown']), 'no_answer'],
      [fakeFetch(['something-else']), 'no_answer'],
      [fakeFetch([], { requestStatus: 409 }), 'failed:server_refused'],
      [fakeFetch([], { throwOn: 'request' }), 'failed:server_unreachable'],
      [fakeFetch([], { throwOn: 'wait' }), 'failed:server_unreachable'],
    ];
    for (const [f, outcome] of cases) {
      const r = await runPermissionHook({ dataDir: d, stdinText: payload(), fetchImpl: f.impl });
      expect(r.stdout, outcome).toBe('');
      expect(r.outcome).toBe(outcome);
    }
  });

  it('with no answer it gives up on its own, well before Claude Code\'s timeout, and says nothing', async () => {
    const d = newDataDir();
    policyFor(d, {}, { enabled: true, waitSeconds: 300 }); // asks for far longer than allowed
    const clock = { t: 1_000_000 };
    const f = fakeFetch(['pending'], { clock });
    const r = await runPermissionHook({ dataDir: d, stdinText: payload(), fetchImpl: f.impl, now: () => clock.t });
    expect(r.stdout).toBe('');
    expect(r.outcome).toBe('no_answer');
    expect(clock.t - 1_000_000).toBeLessThanOrEqual((MAX_WAIT_SECONDS + 20) * 1000);
    expect(MAX_WAIT_SECONDS).toBeLessThan(130);
  });

  it('only the hook token is sent, to the local server', async () => {
    const d = newDataDir();
    policyFor(d, { collector: { port: 47999 } });
    const f = fakeFetch(['allowed']);
    await runPermissionHook({ dataDir: d, stdinText: payload(), fetchImpl: f.impl });
    for (const c of f.calls) {
      expect(c.url.startsWith('http://127.0.0.1:47999/api/permission-hook/')).toBe(true);
      expect(c.token).toBe(TOKEN);
    }
  });
});

describe('what it sends (privacy)', () => {
  const sentRequest = async (dataDir: string, stdin: string) => {
    const f = fakeFetch(['allowed']);
    await runPermissionHook({ dataDir, stdinText: stdin, fetchImpl: f.impl });
    return JSON.parse(f.calls.find((c) => c.url.endsWith('/request'))!.body) as Record<string, unknown>;
  };

  it('with tool-input capture OFF: only the tool name and project id; no details at all, no folder path', async () => {
    const d = newDataDir();
    policyFor(d);
    const body = await sentRequest(d, payload());
    expect(body).toEqual({ sessionId: 'sess-1', projectId: 'proj_A', toolName: 'Bash', summary: null });
    const text = JSON.stringify(body);
    expect(text).not.toContain('CANARY');
    expect(text).not.toContain(projectDir);
    expect(text).not.toContain('cwd');
  });

  it('with capture ON: a short redacted summary, never the raw input', async () => {
    const d = newDataDir();
    policyFor(d, { capture: { prompts: false, toolInputs: true, toolOutputs: false, notificationText: false } });
    const body = await sentRequest(d, payload());
    expect(typeof body.summary).toBe('string');
    const text = JSON.stringify(body);
    expect(text).not.toContain('CANARYSECRET0123456789abcd');
    expect(Object.keys(body).sort()).toEqual(['projectId', 'sessionId', 'summary', 'toolName']);
    expect(String(body.summary).length).toBeLessThanOrEqual(400);
  });

  it('file tools show a project-relative path and never file contents or a user name', async () => {
    const d = newDataDir();
    policyFor(d, { capture: { prompts: false, toolInputs: true, toolOutputs: false, notificationText: false } });
    const body = await sentRequest(d, payload({ tool_name: 'Write', tool_input: { file_path: path.join(projectDir, 'src', 'a.ts'), content: 'TOP-SECRET-FILE-BODY' } }));
    expect(body.summary).toBe('write <project>\\src\\a.ts');
    expect(JSON.stringify(body)).not.toContain('TOP-SECRET-FILE-BODY');
    expect(JSON.stringify(body)).not.toContain(os.userInfo().username);
  });

  it('an unusual tool name is replaced by a fixed word', async () => {
    const d = newDataDir();
    policyFor(d);
    expect((await sentRequest(d, payload({ tool_name: 'Bash; rm -rf /' }))).toolName).toBe('tool');
  });

  it('its log keeps only the tool name and the outcome', async () => {
    const d = newDataDir();
    policyFor(d, { capture: { prompts: false, toolInputs: true, toolOutputs: false, notificationText: false } });
    await runPermissionHook({ dataDir: d, stdinText: payload(), fetchImpl: fakeFetch(['denied']).impl });
    const log = fs.readFileSync(path.join(d, 'logs', 'permission-hook.log'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(log.at(-1)).toMatchObject({ tool: 'Bash', outcome: 'denied' });
    expect(Object.keys(log.at(-1)!).sort()).toEqual(['outcome', 'tool', 'ts']);
    expect(JSON.stringify(log)).not.toContain('CANARY');
  });
});

// ---------------------------------------------------------------------------- the real built script, against a stub server
function stubServer(script: { answer: 'allowed' | 'denied' | 'expired' | 'pending'; refuse?: boolean }) {
  const hits: Array<{ url: string; token: string | undefined; body: string }> = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      hits.push({ url: req.url ?? '', token: req.headers['x-qavo-token'] as string | undefined, body });
      res.setHeader('content-type', 'application/json');
      if (script.refuse) return res.writeHead(409).end('{"error":"bridge_disabled"}');
      if (req.url?.endsWith('/request')) return res.end('{"id":"prm_stub1","status":"pending"}');
      res.end(JSON.stringify({ status: script.answer }));
    });
  });
  return new Promise<{ port: number; hits: typeof hits; close: () => Promise<void> }>((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve({ port: (server.address() as AddressInfo).port, hits, close: () => new Promise((r) => server.close(() => r())) })),
  );
}
function runBundle(dataDir: string, stdin: string) {
  return new Promise<{ code: number | null; stdout: string; ms: number }>((resolve) => {
    const t0 = Date.now();
    const child = spawn(process.execPath, [BUNDLE], { env: { ...process.env, QAVO_DATA_DIR: dataDir }, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.on('close', (code) => resolve({ code, stdout, ms: Date.now() - t0 }));
    child.stdin.end(stdin);
  });
}

describe('the real built script', () => {
  let d: string;
  beforeEach(() => {
    d = newDataDir();
  });

  it('prints exactly the allow decision after a person allowed, and exits 0', async () => {
    const s = await stubServer({ answer: 'allowed' });
    policyFor(d, { collector: { port: s.port } });
    const r = await runBundle(d, payload());
    await s.close();
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } });
    expect(s.hits[0]!.url).toBe('/api/permission-hook/request');
    expect(s.hits.every((h) => h.token === TOKEN)).toBe(true);
    expect(s.hits.map((h) => h.body).join('')).not.toContain('CANARY');
  });

  it('prints the deny decision after a person denied', async () => {
    const s = await stubServer({ answer: 'denied' });
    policyFor(d, { collector: { port: s.port } });
    const r = await runBundle(d, payload());
    await s.close();
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout).hookSpecificOutput.decision.behavior).toBe('deny');
  });

  it('prints NOTHING and exits 0 when the request expired, was refused, or the server is not running', async () => {
    const expired = await stubServer({ answer: 'expired' });
    policyFor(d, { collector: { port: expired.port } });
    expect(await runBundle(d, payload())).toMatchObject({ code: 0, stdout: '' });
    await expired.close();
    const refusing = await stubServer({ answer: 'allowed', refuse: true });
    policyFor(d, { collector: { port: refusing.port } });
    expect(await runBundle(d, payload())).toMatchObject({ code: 0, stdout: '' });
    await refusing.close();
    policyFor(d, { collector: { port: refusing.port } }); // the port is closed now
    const down = await runBundle(d, payload());
    expect(down).toMatchObject({ code: 0, stdout: '' });
    expect(down.ms).toBeLessThan(6000);
  });

  it('does nothing and contacts nobody when the bridge is off or the input is garbage', async () => {
    const s = await stubServer({ answer: 'allowed' });
    policyFor(d, { collector: { port: s.port } }, { enabled: false, waitSeconds: 60 });
    expect(await runBundle(d, payload())).toMatchObject({ code: 0, stdout: '' });
    policyFor(d, { collector: { port: s.port } });
    expect(await runBundle(d, 'garbage')).toMatchObject({ code: 0, stdout: '' });
    expect(await runBundle(d, '')).toMatchObject({ code: 0, stdout: '' });
    await s.close();
    expect(s.hits).toEqual([]);
  });
});
