import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { replaySpool, spoolStatus } from '../src/spool.ts';
import { makeEnv, uiHeaders, dirDump, type TestEnv } from './helpers.ts';

const ROOT = path.resolve(__dirname, '../../..');
const BUNDLE = path.join(ROOT, 'apps/forwarder/dist/forward.mjs');
let env: TestEnv | null = null;

beforeAll(() => {
  execFileSync(process.execPath, [path.join(ROOT, 'apps/forwarder/build.mjs')]);
});
afterEach(async () => {
  await env?.cleanup();
  env = null;
});

const CANARY = { secret: 'sk-' + 'ant-api03-SPOOLCANARY0123456789abcd', email: 'spool.canary@example.com', body: 'SPOOL-CANARY-BODY-77' };

function runHook(dataDir: string, payload: object) {
  return new Promise<number | null>((resolve) => {
    const child = spawn(process.execPath, [BUNDLE], { stdio: ['pipe', 'ignore', 'ignore'], env: { ...process.env, QAVO_DATA_DIR: dataDir } });
    child.on('close', resolve);
    child.stdin.end(JSON.stringify(payload));
  });
}

async function setup() {
  env = await makeEnv(); // server NOT listening: collector is "down"
  const projectDir = path.join(env.root, 'SpoolProject');
  fs.mkdirSync(projectDir, { recursive: true });
  const r = await env.app.inject({ method: 'POST', url: '/api/projects', headers: uiHeaders(env), payload: { alias: 'Spool', path: projectDir } });
  expect(r.statusCode).toBe(201);
  return { env, projectDir, projectId: r.json().project.id as string };
}

const hookPayload = (cwd: string, sid: string, extra: Record<string, unknown>) => ({
  session_id: sid,
  cwd,
  transcript_path: cwd + '\\t.jsonl',
  permission_mode: 'default',
  ...extra,
});

describe('B1: spool + replay', () => {
  it('events produced while the collector is down are replayed exactly once, in order, with original timestamps', async () => {
    const { env: e, projectDir } = await setup();
    const seq: Array<[string, Record<string, unknown>]> = [
      ['sess-a', { hook_event_name: 'SessionStart', source: 'startup' }],
      ['sess-a', { hook_event_name: 'UserPromptSubmit', prompt: `secret ${CANARY.secret} ${CANARY.email}` }],
      ['sess-b', { hook_event_name: 'SessionStart', source: 'startup' }],
      ['sess-a', { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'npx playwright test' } }],
      ['sess-b', { hook_event_name: 'PermissionRequest', tool_name: 'Write', tool_input: { file_path: 'x' } }],
      ['sess-a', { hook_event_name: 'Stop', last_assistant_message: CANARY.body }],
      ['sess-a', { hook_event_name: 'SessionEnd', reason: 'other' }],
    ];
    for (const [sid, p] of seq) {
      expect(await runHook(e.dataDir, hookPayload(projectDir, sid, p))).toBe(0);
      await new Promise((r) => setTimeout(r, 15)); // distinct timestamps
    }
    expect(spoolStatus(e.paths).pendingEvents).toBe(7);
    // nothing leaked into the spool: it holds only sanitized events
    const spoolText = fs.readFileSync(e.paths.spool, 'utf8');
    for (const c of Object.values(CANARY)) expect(spoolText).not.toContain(c);
    expect(spoolText).not.toMatch(/SpoolProject|transcript|"cwd"|"prompt"/);
    const copy = spoolText; // used later to prove duplicate lines are ignored

    await e.app.listen({ host: '127.0.0.1', port: e.port }); // collector comes back
    const report = replaySpool(e.db, e.paths, e.broadcast);
    expect(report).toMatchObject({ files: 1, lines: 7, applied: 7, duplicates: 0, invalid: 0 });
    expect(fs.existsSync(e.paths.spool)).toBe(false);

    const rows = e.db.prepare("SELECT session_id, event, rule, origin_source, occurred_at, received_at FROM agent_events ORDER BY occurred_at, rowid").all() as Array<Record<string, string>>;
    expect(rows.map((r) => `${r.session_id}:${r.event}`)).toEqual(seq.map(([sid, p]) => `${sid}:${p.hook_event_name}`));
    expect(rows.every((r) => r.origin_source === 'replay' && r.received_at === r.occurred_at)).toBe(true);
    const a = (await e.app.inject({ method: 'GET', url: '/api/sessions/sess-a', headers: { host: e.host } })).json();
    expect(a.status).toBe('disconnected');
    const b = (await e.app.inject({ method: 'GET', url: '/api/sessions/sess-b', headers: { host: e.host } })).json();
    expect(b.status).toBe('awaiting_permission');
    // replayed events never raise (stale) notifications
    expect(e.db.prepare('SELECT COUNT(*) AS c FROM notifications').get()).toEqual({ c: 0 });

    // exactly once: replaying the same lines again changes nothing
    fs.writeFileSync(e.paths.spool, copy);
    const again = replaySpool(e.db, e.paths, e.broadcast);
    expect(again).toMatchObject({ lines: 7, applied: 0, duplicates: 7 });
    expect(e.db.prepare('SELECT COUNT(*) AS c FROM agent_events').get()).toEqual({ c: 7 });
    for (const c of Object.values(CANARY)) expect(dirDump(e.dataDir)).not.toContain(c);
  });

  it('a crash mid-replay leaves a processing file that is safely re-read (dedupe)', async () => {
    const { env: e, projectDir } = await setup();
    await runHook(e.dataDir, hookPayload(projectDir, 'sess-c', { hook_event_name: 'SessionStart', source: 'startup' }));
    await runHook(e.dataDir, hookPayload(projectDir, 'sess-c', { hook_event_name: 'UserPromptSubmit' }));
    const lines = fs.readFileSync(e.paths.spool, 'utf8').trim().split('\n');
    // simulate: first line already stored, process died before deleting the file
    fs.renameSync(e.paths.spool, path.join(e.root, 'data', 'spool.processing.1.jsonl'));
    const { ingest } = await import('../src/collector.ts');
    ingest(e.db, JSON.parse(lines[0]!), e.broadcast, 'replay');
    const report = replaySpool(e.db, e.paths, e.broadcast);
    expect(report).toMatchObject({ applied: 1, duplicates: 1 });
    expect(e.db.prepare('SELECT COUNT(*) AS c FROM agent_events').get()).toEqual({ c: 2 });
    expect(fs.readdirSync(e.paths.root).filter((f) => f.startsWith('spool.processing'))).toEqual([]);
  });

  it('a replayed event older than the live state is recorded but does not rewind the session ("stale")', async () => {
    const { env: e, projectDir } = await setup();
    await runHook(e.dataDir, hookPayload(projectDir, 'sess-d', { hook_event_name: 'UserPromptSubmit' })); // spooled (old)
    await new Promise((r) => setTimeout(r, 30));
    await e.app.listen({ host: '127.0.0.1', port: e.port });
    // a newer live event arrives first
    const { ingest } = await import('../src/collector.ts');
    const proj = (await e.app.inject({ method: 'GET', url: '/api/projects', headers: { host: e.host } })).json()[0].id;
    ingest(e.db, { v: 1, eventId: crypto.randomUUID(), ts: new Date().toISOString(), sessionId: 'sess-d', event: 'Stop', projectId: proj, folderKeys: [] }, e.broadcast);
    const before = (await e.app.inject({ method: 'GET', url: '/api/sessions/sess-d', headers: { host: e.host } })).json();
    expect(before.status).toBe('completed');
    replaySpool(e.db, e.paths, e.broadcast);
    const after = (await e.app.inject({ method: 'GET', url: '/api/sessions/sess-d', headers: { host: e.host } })).json();
    expect(after.status).toBe('completed');
    const rules = (e.db.prepare('SELECT rule FROM agent_events WHERE session_id = ? ORDER BY occurred_at').all('sess-d') as Array<{ rule: string }>).map((r) => r.rule);
    expect(rules).toEqual(['stale', '29+19']); // live Stop created the session (row 29); the older replayed prompt is stale
  });

  it('server errors (5xx/429) spool; client rejections (4xx) do not', async () => {
    const { env: e, projectDir } = await setup();
    for (const [status, expectSpool] of [[500, true], [503, true], [429, true], [400, false], [401, false]] as const) {
      const stub = http.createServer((_req, res) => ((res.statusCode = status), res.end()));
      await new Promise<void>((r) => stub.listen(0, '127.0.0.1', r));
      const stubPort = (stub.address() as AddressInfo).port;
      const policy = JSON.parse(fs.readFileSync(e.paths.policy, 'utf8'));
      policy.collector.port = stubPort;
      fs.writeFileSync(e.paths.policy, JSON.stringify(policy));
      fs.rmSync(e.paths.spool, { force: true });
      await runHook(e.dataDir, hookPayload(projectDir, 'sess-e', { hook_event_name: 'UserPromptSubmit' }));
      expect(fs.existsSync(e.paths.spool), `status ${status}`).toBe(expectSpool);
      await new Promise<void>((r) => stub.close(() => r()));
    }
  });

  it('the spool is size-capped (events beyond the cap are dropped, never grown without bound)', async () => {
    const { env: e, projectDir } = await setup();
    fs.writeFileSync(e.paths.spool, 'x'.repeat(5 * 1024 * 1024));
    await runHook(e.dataDir, hookPayload(projectDir, 'sess-f', { hook_event_name: 'UserPromptSubmit' }));
    expect(fs.statSync(e.paths.spool).size).toBe(5 * 1024 * 1024);
    expect(fs.readFileSync(path.join(e.paths.logs, 'forwarder.log'), 'utf8')).toContain('failed:spool_full');
  });

  it('invalid spool lines are counted and skipped', async () => {
    const { env: e } = await setup();
    fs.writeFileSync(e.paths.spool, 'not json\n{"v":1}\n\n');
    const r = replaySpool(e.db, e.paths, e.broadcast);
    expect(r).toMatchObject({ lines: 2, applied: 0, invalid: 2 });
  });
});
