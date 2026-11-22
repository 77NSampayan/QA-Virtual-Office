import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { install, installStatusLine, uninstall, uninstallStatusLine, hookStatus, isOurStatusLine } from '../src/installer.ts';
import { makeEnv, uiHeaders, type TestEnv } from './helpers.ts';

const ROOT = path.resolve(__dirname, '../../..');
const STATUSLINE = path.join(ROOT, 'apps/forwarder/dist/statusline.mjs');
beforeAll(() => {
  execFileSync(process.execPath, [path.join(ROOT, 'apps/forwarder/build.mjs')]);
});

let env: TestEnv;
beforeEach(async () => {
  env = await makeEnv({ listen: true });
});
afterEach(async () => env.cleanup());

const api = async (method: string, url: string, payload?: unknown) => {
  const r = await env.app.inject({ method: method as 'GET', url, headers: uiHeaders(env), payload: payload as object });
  return { status: r.statusCode, body: r.body && r.headers['content-type']?.toString().includes('json') ? r.json() : null, raw: r.body, headers: r.headers };
};
const ctx = () => ({ paths: env.paths, settingsPath: env.settingsPath, nodePath: process.execPath });
const settings = () => JSON.parse(fs.readFileSync(env.settingsPath, 'utf8'));
const writeSettings = (o: unknown) => {
  fs.mkdirSync(path.dirname(env.settingsPath), { recursive: true });
  fs.writeFileSync(env.settingsPath, JSON.stringify(o));
};

describe('status line install / wrap / restore', () => {
  it('installs when none exists, uninstall removes the key, original file restored exactly', () => {
    const original = { model: 'opus', theme: 'dark' };
    writeSettings(original);
    const r = installStatusLine(ctx());
    expect(r).toMatchObject({ changed: true, verified: true, wrapped: false });
    expect(isOurStatusLine(settings().statusLine, env.paths.statuslineScript)).toBe(true);
    expect(settings().statusLine.command).toMatch(/^".*node(\.exe)?" ".*statusline\.mjs"$/);
    expect(installStatusLine(ctx()).changed).toBe(false); // idempotent
    const u = uninstallStatusLine(ctx());
    expect(u).toMatchObject({ changed: true, verified: true });
    expect(settings()).toEqual(original);
  });

  it('wraps an existing status line, keeps its settings, and restores it on uninstall', () => {
    const original = { model: 'opus', statusLine: { type: 'command', command: 'echo ORIGINAL-LINE', padding: 2, refreshInterval: 7 } };
    writeSettings(original);
    const r = installStatusLine(ctx());
    expect(r.wrapped).toBe(true);
    expect(settings().statusLine).toMatchObject({ type: 'command', padding: 2, refreshInterval: 7 });
    expect(JSON.parse(fs.readFileSync(env.paths.statuslineWrap, 'utf8'))).toEqual({ command: 'echo ORIGINAL-LINE' });
    expect(hookStatus(ctx()).statusLine).toBe('installed');
    uninstallStatusLine(ctx());
    expect(settings()).toEqual(original);
    expect(fs.existsSync(env.paths.statuslineWrap)).toBe(false);
  });

  it('hooks and status line coexist: uninstalling one never removes the other (manifest keeps both)', () => {
    writeSettings({ model: 'opus' });
    install({ ...ctx(), forwarderSource: path.join(ROOT, 'apps/forwarder/dist/forward.mjs') });
    installStatusLine(ctx());
    uninstall(ctx());
    expect(settings().hooks).toBeUndefined();
    expect(isOurStatusLine(settings().statusLine, env.paths.statuslineScript)).toBe(true);
    uninstallStatusLine(ctx());
    expect(settings()).toEqual({ model: 'opus' });
    expect(fs.existsSync(env.paths.installManifest)).toBe(false);
  });

  it('reads a Pass 1A (flat) install manifest', () => {
    writeSettings({ model: 'opus' });
    install({ ...ctx(), forwarderSource: path.join(ROOT, 'apps/forwarder/dist/forward.mjs') });
    const m = JSON.parse(fs.readFileSync(env.paths.installManifest, 'utf8'));
    fs.writeFileSync(
      env.paths.installManifest,
      JSON.stringify({ installedAt: m.hooks.installedAt, forwarderPath: m.forwarderPath, nodePath: m.nodePath, createdHooksKey: m.hooks.createdHooksKey, createdEventKeys: m.hooks.createdEventKeys }),
    );
    uninstall(ctx());
    expect(settings()).toEqual({ model: 'opus' });
  });

  it('refuses invalid JSON', () => {
    fs.mkdirSync(path.dirname(env.settingsPath), { recursive: true });
    fs.writeFileSync(env.settingsPath, '{ nope');
    expect(() => installStatusLine(ctx())).toThrow(/settings_invalid_json/);
  });
});

describe('status line process', () => {
  const run = (stdin: object, dataDir = env.dataDir) =>
    new Promise<{ code: number | null; out: string }>((resolve) => {
      const child = spawn(process.execPath, [STATUSLINE], { stdio: ['pipe', 'pipe', 'ignore'], env: { ...process.env, QAVO_DATA_DIR: dataDir } });
      let out = '';
      child.stdout.on('data', (d) => (out += d));
      child.on('close', (code) => resolve({ code, out }));
      child.stdin.end(JSON.stringify(stdin));
    });

  it('posts a numbers-only snapshot, prints a compact line, fills the session model and usage', async () => {
    const projectDir = path.join(env.root, 'StatusProject');
    fs.mkdirSync(projectDir);
    const created = await api('POST', '/api/projects', { alias: 'Status', path: projectDir });
    // a session must exist for the model/usage to attach
    await env.app.inject({
      method: 'POST',
      url: '/api/hooks',
      headers: { host: env.host, 'x-qavo-token': env.token, 'content-type': 'application/json' },
      payload: { v: 1, eventId: crypto.randomUUID(), ts: new Date().toISOString(), sessionId: 'sl-1', event: 'SessionStart', source: 'startup', projectId: created.body.project.id, folderKeys: [] },
    });
    const r = await run({
      session_id: 'sl-1',
      cwd: projectDir,
      transcript_path: projectDir + '\\t.jsonl',
      workspace: { current_dir: projectDir },
      model: { id: 'claude-haiku-5-5', display_name: 'Haiku 5.5' },
      cost: { total_cost_usd: 0.42, total_duration_ms: 1000 },
      context_window: { used_percentage: 17.4 },
      rate_limits: { five_hour: { used_percentage: 9, resets_at: 1795400000 } },
    });
    expect(r.code).toBe(0);
    expect(r.out.trim()).toBe('QA Office · Haiku 5.5 · ctx 17%');
    const s = (await api('GET', '/api/sessions/sl-1')).body;
    expect(s.model).toBe('claude-haiku-5-5');
    expect(s.usage).toMatchObject({ modelName: 'Haiku 5.5', costUsd: 0.42, contextUsedPct: 17.4, fiveHourPct: 9 });
    const dump = JSON.stringify(env.db.prepare('SELECT * FROM statusline_snapshots').all());
    expect(dump).not.toMatch(/StatusProject|transcript/);
  });

  it('drops snapshots from unregistered folders (nothing stored) but still prints a line', async () => {
    const r = await run({ session_id: 'sl-2', cwd: path.join(env.root, 'Elsewhere'), model: { id: 'claude-haiku-5-5', display_name: 'H' } });
    expect(r.code).toBe(0);
    expect(r.out.trim()).toBe(''); // dropped before any formatting
    expect(env.db.prepare('SELECT COUNT(*) AS c FROM statusline_snapshots').get()).toEqual({ c: 0 });
  });

  it('prints the wrapped command output instead of its own line, and survives a failing wrap', async () => {
    const projectDir = path.join(env.root, 'WrapProject');
    fs.mkdirSync(projectDir);
    await api('POST', '/api/projects', { alias: 'Wrap', path: projectDir });
    const nodeCmd = `"${process.execPath.replace(/\\/g, '/')}" -e "process.stdin.on('data',()=>{});process.stdin.on('end',()=>console.log('USER-STATUS-LINE'))"`;
    fs.writeFileSync(env.paths.statuslineWrap, JSON.stringify({ command: nodeCmd }));
    const r = await run({ session_id: 'sl-3', cwd: projectDir });
    expect(r.out.trim()).toBe('USER-STATUS-LINE');
    fs.writeFileSync(env.paths.statuslineWrap, JSON.stringify({ command: 'definitely-not-a-command-xyz' }));
    const r2 = await run({ session_id: 'sl-3', cwd: projectDir });
    expect(r2.code).toBe(0);
    expect(r2.out.trim()).toBe('QA Office'); // fell back to our own compact line
  });

  it('exits 0 with the collector down', async () => {
    const projectDir = path.join(env.root, 'DownProject');
    fs.mkdirSync(projectDir);
    await api('POST', '/api/projects', { alias: 'Down', path: projectDir });
    await env.app.close();
    const t0 = Date.now();
    const r = await run({ session_id: 'sl-4', cwd: projectDir });
    expect(r.code).toBe(0);
    expect(Date.now() - t0).toBeLessThan(3000);
    env.app = { close: async () => undefined } as never;
  });

  it('server rejects invalid snapshots', async () => {
    const r = await env.app.inject({
      method: 'POST',
      url: '/api/statusline',
      headers: { host: env.host, 'x-qavo-token': env.token, 'content-type': 'application/json' },
      payload: { v: 1, sessionId: 's', cwd: 'C:\\leak' },
    });
    expect(r.statusCode).toBe(400);
  });
});

describe('integration API: plan, install, status', () => {
  it('plan summaries never contain filesystem paths; install requires acknowledgement', async () => {
    writeSettings({ model: 'opus' });
    const plan = await api('GET', '/api/integration/plan?kind=hooks&action=install');
    expect(plan.status).toBe(200);
    expect(plan.body).toMatchObject({ kind: 'hooks', action: 'install', noChange: false, willCreateBackup: true });
    expect(plan.body.eventsAdded).toHaveLength(12);
    expect(plan.body.warning).toContain('EVERY folder');
    expect(plan.raw).not.toMatch(/[A-Za-z]:\\/);
    expect(plan.raw).not.toContain(env.root.replace(/\\/g, '\\\\'));

    const noAck = await api('POST', '/api/integration/hooks/install', {});
    expect(noAck.status).toBe(400);
    expect(noAck.body.error).toBe('acknowledge_required');
    expect(fs.readFileSync(env.settingsPath, 'utf8')).toBe(JSON.stringify({ model: 'opus' }));

    const ok = await api('POST', '/api/integration/hooks/install', { acknowledge: true });
    expect(ok.body).toMatchObject({ changed: true, verified: true, backupCreated: true });
    const status = (await api('GET', '/api/integration/status')).body;
    expect(status.hooks.state).toBe('installed');
    expect(status.trustHint).toContain('workspace-trust');

    const un = await api('POST', '/api/integration/hooks/uninstall', {});
    expect(un.body).toMatchObject({ changed: true, verified: true });
    expect(JSON.parse(fs.readFileSync(env.settingsPath, 'utf8'))).toEqual({ model: 'opus' });
  });

  it('status-line plan reports wrapping and restore', async () => {
    writeSettings({ statusLine: { type: 'command', command: 'echo hi' } });
    expect((await api('GET', '/api/integration/plan?kind=statusLine&action=install')).body.wrapsExistingStatusLine).toBe(true);
    await api('POST', '/api/integration/statusline/install', { acknowledge: true });
    const p = (await api('GET', '/api/integration/plan?kind=statusLine&action=uninstall')).body;
    expect(p.restoresOriginalStatusLine).toBe(true);
    expect((await api('GET', '/api/integration/status')).body.hooks.statusLine).toBe('installed');
  });

  it('invalid plan params and invalid settings.json are reported, not thrown', async () => {
    expect((await api('GET', '/api/integration/plan?kind=x&action=install')).status).toBe(400);
    fs.mkdirSync(path.dirname(env.settingsPath), { recursive: true });
    fs.writeFileSync(env.settingsPath, '{bad');
    const r = await api('POST', '/api/integration/hooks/install', { acknowledge: true });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('settings_invalid_json');
  });

  it('health report: last event per hook type, spool, last backup', async () => {
    await env.app.inject({
      method: 'POST',
      url: '/api/hooks',
      headers: { host: env.host, 'x-qavo-token': env.token, 'content-type': 'application/json' },
      payload: { v: 1, eventId: crypto.randomUUID(), ts: new Date().toISOString(), sessionId: 'h-1', event: 'Stop', projectId: null, folderKeys: [] },
    });
    const s = (await api('GET', '/api/integration/status')).body;
    expect(s.lastEventByType.Stop).toMatch(/^\d{4}-/);
    expect(s.lastEventByType.SessionStart).toBeNull();
    expect(s.spool).toMatchObject({ pendingEvents: 0 });
    expect(s.lastHookEventAt).toBe(s.lastEventByType.Stop);
    expect(JSON.stringify(s)).not.toMatch(/[A-Za-z]:\\/);
  });
});

describe('settings API', () => {
  it('privacy: enabling content capture needs confirmation; policy follows; disabling offers purge', async () => {
    expect((await api('GET', '/api/settings')).body.capture).toEqual({ prompts: false, toolInputs: false, toolOutputs: false, notificationText: false });
    const refused = await api('PUT', '/api/settings/privacy', { prompts: true });
    expect(refused.status).toBe(400);
    expect(refused.body.error).toBe('confirmation_required');
    expect(JSON.parse(fs.readFileSync(env.paths.policy, 'utf8')).capture.prompts).toBe(false);
    const on = await api('PUT', '/api/settings/privacy', { prompts: true, confirm: true });
    expect(on.body.capture.prompts).toBe(true);
    expect(JSON.parse(fs.readFileSync(env.paths.policy, 'utf8')).capture.prompts).toBe(true);
    const off = await api('PUT', '/api/settings/privacy', { prompts: false });
    expect(off.body.purgeOffered).toEqual(['prompts']);
    expect((await api('PUT', '/api/settings/privacy', { prompts: 'yes' })).status).toBe(400);
  });

  it('scope: switching to all sessions needs confirmation', async () => {
    expect((await api('PUT', '/api/settings/scope', { scope: 'all' })).body.error).toBe('confirmation_required');
    expect((await api('PUT', '/api/settings/scope', { scope: 'all', confirm: true })).body.scope).toBe('all');
    expect((await api('PUT', '/api/settings/scope', { scope: 'registered' })).body.scope).toBe('registered');
    expect((await api('PUT', '/api/settings/scope', { scope: 'weird' })).status).toBe(400);
  });

  it('excludes: stored, regenerate the policy, path-bearing GET needs the client header, never in /api/settings', async () => {
    const dir = path.join(env.root, 'ExcludeMe');
    fs.mkdirSync(dir);
    const put = await api('PUT', '/api/settings/excludes', { paths: [dir] });
    expect(put.body.count).toBe(1);
    expect(JSON.parse(fs.readFileSync(env.paths.policy, 'utf8')).excludes).toHaveLength(1);
    expect((await api('GET', '/api/settings/excludes')).body.paths).toEqual([dir]);
    expect((await api('GET', '/api/settings')).raw).not.toContain('ExcludeMe');
    const noHeader = await env.app.inject({ method: 'GET', url: '/api/settings/excludes', headers: { host: env.host } });
    expect(noHeader.statusCode).toBe(403);
    expect((await api('PUT', '/api/settings/excludes', { paths: ['relative'] })).status).toBe(400);
  });

  it('retention: validated and persisted', async () => {
    expect((await api('GET', '/api/settings/retention')).body).toEqual({ eventDays: 30, contentDays: 7 });
    expect((await api('PUT', '/api/settings/retention', { eventDays: 60, contentDays: 14 })).body).toEqual({ eventDays: 60, contentDays: 14 });
    for (const bad of [{ eventDays: 0, contentDays: 1 }, { eventDays: 10, contentDays: 20 }, { eventDays: 'x', contentDays: 1 }, {}]) {
      expect((await api('PUT', '/api/settings/retention', bad)).status).toBe(400);
    }
    expect((await api('GET', '/api/settings/retention')).body.eventDays).toBe(60);
  });
});
