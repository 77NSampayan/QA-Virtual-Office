import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { HOOK_EVENTS } from '@qavo/shared';
import { bootstrapDataDir, verifyOwnerOnlyAcl } from '../src/dataDir.ts';
import { install, uninstall, hookStatus, isOurHandler } from '../src/installer.ts';
import { makeEnv, uiHeaders, dirDump, type TestEnv } from './helpers.ts';

const ROOT = path.resolve(__dirname, '../../..');
const BUNDLE = path.join(ROOT, 'apps/forwarder/dist/forward.mjs');

beforeAll(() => {
  execFileSync(process.execPath, [path.join(ROOT, 'apps/forwarder/build.mjs')]);
});

function tempCtx() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qavo-inst-'));
  const { paths } = bootstrapDataDir(path.join(root, 'data'), { applyAcl: false });
  const settingsPath = path.join(root, 'claude', 'settings.json');
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  return { root, paths, settingsPath, nodePath: process.execPath, forwarderSource: BUNDLE };
}

const ORIGINAL = {
  model: 'opus',
  enabledPlugins: { 'x@y': true },
  hooks: {
    PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo existing' }] }],
    PostCompact: [{ hooks: [{ type: 'command', command: 'echo other' }] }],
  },
  theme: 'dark',
};

describe('installer (A2, A7)', () => {
  it('install merges only our handlers; JSON-equal to the original apart from them; backup written', () => {
    const ctx = tempCtx();
    fs.writeFileSync(ctx.settingsPath, JSON.stringify(ORIGINAL, null, 4));
    const r = install(ctx);
    expect(r.changed).toBe(true);
    expect(r.verified).toBe(true);
    expect(JSON.parse(fs.readFileSync(r.backupPath!, 'utf8'))).toEqual(ORIGINAL);
    const after = JSON.parse(fs.readFileSync(ctx.settingsPath, 'utf8'));
    // strip our handlers -> must equal original (empty groups we added removed)
    const stripped = structuredClone(after);
    for (const [e, groups] of Object.entries(stripped.hooks as Record<string, Array<{ hooks: Array<Record<string, unknown>> }>>)) {
      stripped.hooks[e] = groups
        .map((g) => ({ ...g, hooks: g.hooks.filter((h) => !isOurHandler(h, ctx.paths.forwarder)) }))
        .filter((g) => g.hooks.length > 0);
      if (stripped.hooks[e].length === 0) delete stripped.hooks[e];
    }
    expect(stripped).toEqual(ORIGINAL);
    for (const e of HOOK_EVENTS) {
      const ours = after.hooks[e].flatMap((g: { hooks: unknown[] }) => g.hooks).filter((h: Record<string, unknown>) => isOurHandler(h, ctx.paths.forwarder));
      expect(ours).toEqual([{ type: 'command', command: process.execPath, args: [ctx.paths.forwarder], async: true, timeout: 10 }]);
    }
    expect(fs.readFileSync(ctx.paths.forwarder, 'utf8')).toBe(fs.readFileSync(BUNDLE, 'utf8'));
    expect(hookStatus(ctx).state).toBe('installed');
  });

  it('install is idempotent (second run is a no-op, no new backup)', () => {
    const ctx = tempCtx();
    fs.writeFileSync(ctx.settingsPath, JSON.stringify(ORIGINAL));
    install(ctx);
    const text = fs.readFileSync(ctx.settingsPath, 'utf8');
    const backups = fs.readdirSync(ctx.paths.settingsBackups).length;
    const r = install(ctx);
    expect(r.changed).toBe(false);
    expect(fs.readFileSync(ctx.settingsPath, 'utf8')).toBe(text);
    expect(fs.readdirSync(ctx.paths.settingsBackups).length).toBe(backups);
  });

  it('uninstall leaves settings JSON-equal to the pre-install backup', () => {
    const ctx = tempCtx();
    fs.writeFileSync(ctx.settingsPath, JSON.stringify(ORIGINAL));
    const inst = install(ctx);
    const r = uninstall(ctx);
    expect(r.changed).toBe(true);
    expect(r.verified).toBe(true);
    expect(JSON.parse(fs.readFileSync(ctx.settingsPath, 'utf8'))).toEqual(JSON.parse(fs.readFileSync(inst.backupPath!, 'utf8')));
    expect(hookStatus(ctx).state).toBe('not_installed');
  });

  it('uninstall restores exactly when settings had no hooks key (the real machine case)', () => {
    const ctx = tempCtx();
    const noHooks = { model: 'opus', theme: 'dark' };
    fs.writeFileSync(ctx.settingsPath, JSON.stringify(noHooks));
    install(ctx);
    uninstall(ctx);
    expect(JSON.parse(fs.readFileSync(ctx.settingsPath, 'utf8'))).toEqual(noHooks);
  });

  it('preserves user edits made between install and uninstall', () => {
    const ctx = tempCtx();
    fs.writeFileSync(ctx.settingsPath, JSON.stringify({ model: 'opus' }));
    install(ctx);
    const mid = JSON.parse(fs.readFileSync(ctx.settingsPath, 'utf8'));
    mid.hooks.Stop.push({ hooks: [{ type: 'command', command: 'echo user-added' }] });
    mid.theme = 'light';
    fs.writeFileSync(ctx.settingsPath, JSON.stringify(mid));
    uninstall(ctx);
    expect(JSON.parse(fs.readFileSync(ctx.settingsPath, 'utf8'))).toEqual({
      model: 'opus',
      hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo user-added' }] }] },
      theme: 'light',
    });
  });

  it('refuses to touch invalid JSON', () => {
    const ctx = tempCtx();
    fs.writeFileSync(ctx.settingsPath, '{ "model": "opus", ');
    expect(() => install(ctx)).toThrow(/settings_invalid_json/);
    expect(fs.readFileSync(ctx.settingsPath, 'utf8')).toBe('{ "model": "opus", ');
  });
});

describe('A8: data directory ACL', () => {
  it('data dir and token are restricted to the current user only', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qavo-acl-'));
    const { paths } = bootstrapDataDir(path.join(root, 'data'), { applyAcl: true });
    for (const target of [paths.root, paths.token, paths.folderKeySecret]) {
      const report = verifyOwnerOnlyAcl(target);
      expect(report.ok, report.raw).toBe(true);
      expect(report.principals).toHaveLength(1);
    }
    fs.rmSync(root, { recursive: true, force: true });
  });
});

describe('end-to-end: real forwarder process -> live collector (A4 synthetic canary)', () => {
  let env: TestEnv;
  let projectDir: string;
  const CANARY = {
    secret: 'sk-' + 'ant-api03-E2ECANARY0123456789abcdefgh',
    email: 'e2e.canary@example.com',
    phone: '+1 415 555 0177',
    file: 'E2E-CANARY-FILE-CONTENTS-5d1e',
    folder: 'OmegaPrivateEngagement',
  };
  beforeAll(async () => {
    env = await makeEnv({ listen: true });
    projectDir = path.join(env.root, CANARY.folder, 'repo');
    fs.mkdirSync(projectDir, { recursive: true });
    fs.copyFileSync(BUNDLE, env.paths.forwarder);
  });
  afterAll(async () => env.cleanup());

  const runHook = (payload: object) =>
    new Promise<number | null>((resolve) => {
      const child = spawn(process.execPath, [env.paths.forwarder], { stdio: ['pipe', 'ignore', 'ignore'], env: { ...process.env, QAVO_DATA_DIR: '' } });
      child.on('close', resolve);
      child.stdin.end(JSON.stringify(payload));
    });

  it('a full session flows through and no canary reaches any file in the data dir', async () => {
    const r = await env.app.inject({ method: 'POST', url: '/api/projects', headers: uiHeaders(env), payload: { alias: 'Omega', path: projectDir } });
    expect(r.statusCode).toBe(201);
    const sid = 'e2e00000-0000-4000-8000-00000000abcd';
    const common = { session_id: sid, cwd: path.join(projectDir, 'src'), transcript_path: path.join(projectDir, 't.jsonl'), permission_mode: 'default' };
    const seq = [
      { hook_event_name: 'SessionStart', source: 'startup', model: 'claude-haiku-5-5' },
      { hook_event_name: 'UserPromptSubmit', prompt: `key ${CANARY.secret} mail ${CANARY.email} call ${CANARY.phone}` },
      { hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: path.join(projectDir, 'canary.txt') }, tool_use_id: 'toolu_01' },
      { hook_event_name: 'PostToolUse', tool_name: 'Read', tool_input: { file_path: path.join(projectDir, 'canary.txt') }, tool_response: { content: CANARY.file }, tool_use_id: 'toolu_01' },
      { hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: `curl -H "Authorization: Bearer ${CANARY.secret}"` } },
      { hook_event_name: 'Notification', notification_type: 'permission_prompt', message: `Claude needs your permission ${CANARY.email}` },
      { hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'npx playwright test' }, tool_response: { stdout: CANARY.file }, tool_use_id: 'toolu_02' },
      { hook_event_name: 'Stop', stop_hook_active: false, last_assistant_message: CANARY.file },
      { hook_event_name: 'SessionEnd', reason: 'prompt_input_exit' },
    ];
    const statuses: string[] = [];
    for (const p of seq) {
      expect(await runHook({ ...common, ...p })).toBe(0);
      const s = await env.app.inject({ method: 'GET', url: `/api/sessions/${sid}`, headers: { host: env.host } });
      statuses.push(s.json().status);
    }
    expect(statuses).toEqual([
      'idle',
      'analyzing',
      'analyzing',
      'analyzing',
      'awaiting_permission',
      'awaiting_permission',
      'analyzing',
      'completed',
      'disconnected',
    ]);
    const notifications = (await env.app.inject({ method: 'GET', url: '/api/notifications', headers: { host: env.host } })).json();
    expect(notifications.filter((n: { kind: string }) => n.kind === 'permission_required')).toHaveLength(1); // row 12 dedupe
    await new Promise((res) => setTimeout(res, 200));
    const dump = dirDump(env.dataDir);
    for (const c of [CANARY.secret, CANARY.email, CANARY.phone, CANARY.file]) expect(dump).not.toContain(c);
    // the folder name exists only in project_paths/capture-policy (protected); never in events/logs
    const logs = dirDump(env.paths.logs);
    expect(logs).not.toContain(CANARY.folder);
    expect(JSON.stringify(env.db.prepare('SELECT * FROM agent_events').all())).not.toContain(CANARY.folder);
  });
});
