import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { lexicalForm } from '@qavo/shared/paths';

const ROOT = path.resolve(__dirname, '../../..');
const BUNDLE = path.join(ROOT, 'apps/forwarder/dist/forward.mjs');
const TOKEN = 'test-token-0123456789abcdef';
const CANARY = {
  secret: 'sk-' + 'ant-api03-FWDCANARY0123456789abcdef',
  email: 'fwd.canary@example.com',
  body: 'FWD-CANARY-FILE-BODY-91c2',
};

let tmp: string;
let projectDir: string;
let otherDir: string;

function writePolicy(dataDir: string, port: number, over: Record<string, unknown> = {}) {
  const policy = {
    schema: 1,
    version: 3,
    generatedAt: new Date().toISOString(),
    scope: 'registered',
    capture: { prompts: false, toolInputs: false, toolOutputs: false, notificationText: false },
    projects: [{ id: 'proj_A', lexical: lexicalForm(projectDir), canonical: null }],
    excludes: [],
    collector: { port },
    ...over,
  };
  fs.writeFileSync(path.join(dataDir, 'capture-policy.json'), JSON.stringify(policy));
}

function newDataDir(): string {
  const d = fs.mkdtempSync(path.join(tmp, 'data-'));
  fs.writeFileSync(path.join(d, 'token'), TOKEN);
  return d;
}

function run(dataDir: string, stdin: string, env: Record<string, string> = {}) {
  return new Promise<{ code: number | null; stdout: string; ms: number }>((resolve) => {
    const t0 = Date.now();
    const child = spawn(process.execPath, [BUNDLE], {
      env: { ...process.env, QAVO_DATA_DIR: dataDir, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.on('close', (code) => resolve({ code, stdout, ms: Date.now() - t0 }));
    child.stdin.end(stdin);
  });
}

function dirText(dir: string): string {
  let out = '';
  for (const entry of fs.readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (entry.isFile()) out += fs.readFileSync(path.join(entry.parentPath, entry.name), 'utf8');
  }
  return out;
}

const payload = (cwd: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    session_id: 'abcd1234-0000-4000-8000-000000000001',
    transcript_path: path.join(cwd, 'x.jsonl'),
    cwd,
    hook_event_name: 'UserPromptSubmit',
    prompt: `secret ${CANARY.secret} mail ${CANARY.email} body ${CANARY.body}`,
    ...extra,
  });

let server: http.Server;
let port: number;
let received: Array<{ headers: http.IncomingHttpHeaders; body: string }> = [];

beforeAll(async () => {
  execFileSync(process.execPath, [path.join(ROOT, 'apps/forwarder/build.mjs')]);
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qavo-fwd-'));
  projectDir = path.join(tmp, 'ClientAlphaSecretName', 'repo');
  otherDir = path.join(tmp, 'UnregisteredPlace');
  fs.mkdirSync(projectDir, { recursive: true });
  fs.mkdirSync(otherDir, { recursive: true });
  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      received.push({ headers: req.headers, body });
      res.statusCode = 204;
      res.end();
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  port = (server.address() as AddressInfo).port;
});

afterAll(() => {
  server.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

beforeEach(() => {
  received = [];
});

describe('forwarder process', () => {
  it('sends a metadata-only event for a registered project (no prompt, cwd, path, canaries)', async () => {
    const dataDir = newDataDir();
    writePolicy(dataDir, port);
    const r = await run(dataDir, payload(path.join(projectDir, 'src')));
    expect(r.code).toBe(0);
    expect(r.stdout).toBe('');
    expect(received).toHaveLength(1);
    const { headers, body } = received[0]!;
    expect(headers['x-qavo-token']).toBe(TOKEN);
    expect(headers.origin).toBeUndefined();
    const ev = JSON.parse(body);
    expect(ev).toMatchObject({ event: 'UserPromptSubmit', projectId: 'proj_A', folderKeys: [] });
    for (const c of Object.values(CANARY)) expect(body).not.toContain(c);
    expect(body).not.toMatch(/ClientAlphaSecretName|repo|transcript|"cwd"|"prompt"/i);
    expect(Object.keys(ev).sort()).toEqual(['event', 'eventId', 'folderKeys', 'projectId', 'sessionId', 'ts', 'v']);
    const logs = dirText(dataDir);
    for (const c of Object.values(CANARY)) expect(logs).not.toContain(c);
    expect(logs).not.toMatch(/ClientAlphaSecretName/);
    expect(logs).toContain('"decision":"sent"');
  });

  it('A5: exits 0 quickly when the collector is down, without persisting the payload', async () => {
    const dataDir = newDataDir();
    const closed = http.createServer();
    await new Promise<void>((r) => closed.listen(0, '127.0.0.1', r));
    const deadPort = (closed.address() as AddressInfo).port;
    await new Promise<void>((r) => closed.close(() => r()));
    writePolicy(dataDir, deadPort);
    const r = await run(dataDir, payload(projectDir));
    expect(r.code).toBe(0);
    expect(r.stdout).toBe('');
    expect(r.ms).toBeLessThan(3000);
    const logs = dirText(dataDir);
    expect(logs).toContain('spooled:collector_unreachable');
    for (const c of Object.values(CANARY)) expect(logs).not.toContain(c);
  });

  it('drops events from unregistered folders in registered-only scope (nothing sent)', async () => {
    const dataDir = newDataDir();
    writePolicy(dataDir, port);
    const r = await run(dataDir, payload(otherDir));
    expect(r.code).toBe(0);
    expect(received).toHaveLength(0);
    const log = fs.readFileSync(path.join(dataDir, 'logs', 'forwarder.log'), 'utf8');
    expect(log).toContain('dropped:unregistered');
    expect(log).not.toMatch(/UnregisteredPlace/);
  });

  it('fails closed when the policy file is missing or corrupt', async () => {
    const dataDir = newDataDir();
    let r = await run(dataDir, payload(projectDir));
    expect(r.code).toBe(0);
    fs.writeFileSync(path.join(dataDir, 'capture-policy.json'), '{corrupt');
    r = await run(dataDir, payload(projectDir));
    expect(r.code).toBe(0);
    expect(received).toHaveLength(0);
    const log = fs.readFileSync(path.join(dataDir, 'logs', 'forwarder.log'), 'utf8');
    expect(log.match(/dropped:fail_closed/g)).toHaveLength(2);
  });

  it('exits 0 on invalid stdin', async () => {
    const dataDir = newDataDir();
    writePolicy(dataDir, port);
    const r = await run(dataDir, 'not json at all');
    expect(r.code).toBe(0);
    expect(received).toHaveLength(0);
  });

  it('All sessions scope sends opaque folder keys only when a secret exists', async () => {
    const dataDir = newDataDir();
    writePolicy(dataDir, port, { scope: 'all' });
    fs.writeFileSync(
      path.join(dataDir, 'folder-key.secret'),
      JSON.stringify({ kid: 'a1b2c3d4', key: Buffer.alloc(32, 7).toString('base64'), createdAt: new Date().toISOString() }),
    );
    await run(dataDir, payload(otherDir));
    expect(received).toHaveLength(1);
    const ev = JSON.parse(received[0]!.body);
    expect(ev.projectId).toBeNull();
    expect(ev.folderKeys.length).toBeGreaterThan(0);
    expect(ev.folderKeys.every((k: string) => /^a1b2c3d4:[a-f0-9]{32}$/.test(k))).toBe(true);
    expect(received[0]!.body).not.toMatch(/UnregisteredPlace/);
  });

  it('QAVO_DEBUG_KEYS=1 logs key names only, never values', async () => {
    const dataDir = newDataDir();
    writePolicy(dataDir, port);
    await run(dataDir, payload(projectDir, { parent_session_id: 'zzz-parent' }), { QAVO_DEBUG_KEYS: '1' });
    const keysLog = fs.readFileSync(path.join(dataDir, 'logs', 'forwarder-keys.log'), 'utf8');
    const entry = JSON.parse(keysLog.trim());
    expect(entry.keys).toEqual(['cwd', 'hook_event_name', 'parent_session_id', 'prompt', 'session_id', 'transcript_path']);
    expect(keysLog).not.toContain('zzz-parent');
    for (const c of Object.values(CANARY)) expect(keysLog).not.toContain(c);
  });
});

describe('forwarder: playbook run id (P4)', () => {
  it('adds the run id from the environment, and nothing else about the run', async () => {
    const d = newDataDir();
    writePolicy(d, port);
    const r = await run(d, payload(projectDir), { QAVO_RUN_ID: 'run_0123456789abcdef' });
    expect(r.code).toBe(0);
    expect(received).toHaveLength(1);
    const ev = JSON.parse(received[0]!.body);
    expect(ev.runId).toBe('run_0123456789abcdef');
    expect(received[0]!.body).not.toMatch(/token|QAVO_RUN_TOKEN/i);
  });

  it('ignores a malformed run id and sends no run id when there is none', async () => {
    const d = newDataDir();
    writePolicy(d, port);
    for (const bad of ['nope', 'run_', 'run_x', 'run_with space', 'run_' + 'a'.repeat(80), '<script>']) {
      received = [];
      await run(d, payload(projectDir), { QAVO_RUN_ID: bad });
      expect(received).toHaveLength(1);
      expect(JSON.parse(received[0]!.body).runId, bad).toBeUndefined();
    }
    received = [];
    await run(d, payload(projectDir));
    expect(JSON.parse(received[0]!.body).runId).toBeUndefined();
  });
});
