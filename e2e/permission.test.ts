/**
 * V4b end to end: the REAL permission hook script (as Claude Code would run it) waits while a person answers in the
 * browser. Covers install from Settings, allow, deny, details hidden, expiry, answered in the terminal, and that
 * the script never decides on its own.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { chromium, type Browser, type Page } from 'playwright-core';
import { makeEnv, uiHeaders, type TestEnv } from '../apps/server/test/helpers.ts';

const ROOT = path.resolve(__dirname, '..');
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const SHOTS = process.env.QAVO_E2E_SHOTS;

let env: TestEnv;
let browser: Browser;
let page: Page;
let cookie: string;
let projectDir: string;
let projectId: string;

const api = async (method: string, url: string, payload?: unknown) => {
  const r = await env.app.inject({ method: method as 'GET', url, headers: { ...uiHeaders(env), cookie }, payload: payload as object });
  return r.body ? r.json() : null;
};
async function post(sessionId: string, event: string, extra: Record<string, unknown> = {}) {
  const r = await env.app.inject({
    method: 'POST',
    url: '/api/hooks',
    headers: { host: env.host, 'x-qavo-token': env.token, 'content-type': 'application/json' },
    payload: { v: 1, eventId: crypto.randomUUID(), ts: new Date().toISOString(), sessionId, event, projectId, folderKeys: [], ...extra },
  });
  expect(r.statusCode).toBe(204);
}

/** Runs the installed permission hook script exactly like Claude Code would: payload on stdin, decision on stdout. */
function runHook(over: Record<string, unknown> = {}) {
  const child: ChildProcessWithoutNullStreams = spawn(process.execPath, [env.paths.permissionHook], { stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '';
  child.stdout.on('data', (d) => (stdout += d));
  const done = new Promise<{ code: number | null; stdout: string }>((resolve) => child.on('close', (code) => resolve({ code, stdout })));
  child.stdin.end(
    JSON.stringify({ session_id: 'sess-perm', cwd: projectDir, hook_event_name: 'PermissionRequest', permission_mode: 'default', tool_name: 'Bash', tool_input: { command: 'npm test --silent', description: 'run the tests' }, ...over }),
  );
  return { child, done };
}
const card = '[data-permission-panel] [data-permission]';
const waitCard = () => page.waitForSelector(card, { timeout: 15_000 });

beforeAll(async () => {
  expect(fs.existsSync(path.join(ROOT, 'apps/web/dist/index.html')), 'run `npm run build:web` first').toBe(true);
  expect(fs.existsSync(path.join(ROOT, 'apps/forwarder/dist/permission.mjs')), 'run `npm run build:forwarder` first').toBe(true);
  env = await makeEnv({ listen: true, auth: true, webDist: path.join(ROOT, 'apps/web/dist') });
  cookie = `qavo_session=${env.auth.issueSession()}`;
  projectDir = path.join(env.root, 'PaymentsWeb');
  fs.mkdirSync(projectDir);
  projectId = (await api('POST', '/api/projects', { alias: 'Payments Web', path: projectDir })).project.id;
  await api('PUT', '/api/settings/privacy', { toolInputs: true, confirm: true });
  browser = await chromium.launch({ executablePath: EDGE, headless: true });
  page = await (await browser.newContext({ viewport: { width: 1300, height: 1000 } })).newPage();
  page.on('dialog', (d) => void d.accept());
  await page.goto(env.createLaunchUrl());
  await page.waitForSelector('[data-page="overview"]');
});
afterAll(async () => {
  await browser?.close();
  await env.cleanup();
});

describe('Settings: install the hook and turn the bridge on (nothing happens by itself)', () => {
  it('starts with the hook not installed and the bridge off; "turn on" is disabled until the hook is installed', async () => {
    await page.goto(env.origin + '/#/settings');
    await page.waitForSelector('[data-permission-bridge]');
    expect(await page.getAttribute('[data-bridge-hook]', 'data-bridge-hook')).toBe('not_installed');
    expect(await page.getAttribute('[data-bridge-status]', 'data-bridge-status')).toBe('off');
    expect(await page.isDisabled('[data-bridge-on]')).toBe(true);
    expect(fs.existsSync(env.settingsPath)).toBe(false);
  });

  it('shows the plan and warning, needs an acknowledgement, then installs ONE synchronous PermissionRequest hook', async () => {
    await page.click('[data-bridge-plan]');
    await page.waitForSelector('[data-bridge-plan-box]');
    expect(await page.textContent('[data-bridge-plan-box]')).toContain('never approves anything by itself');
    expect(await page.isDisabled('[data-bridge-install]')).toBe(true);
    await page.check('[data-bridge-ack]');
    await page.click('[data-bridge-install]');
    await page.waitForSelector('[data-bridge-hook="installed"]');
    const settings = JSON.parse(fs.readFileSync(env.settingsPath, 'utf8')) as { hooks: Record<string, Array<{ hooks: Array<Record<string, unknown>> }>> };
    expect(Object.keys(settings.hooks)).toEqual(['PermissionRequest']);
    expect(settings.hooks.PermissionRequest![0]!.hooks[0]).toMatchObject({ type: 'command', async: false, timeout: 130 });
    expect(fs.existsSync(env.paths.permissionHook)).toBe(true);
    expect(await page.isDisabled('[data-bridge-on]')).toBe(false);
  });

  it('with the hook installed but the bridge OFF the script stays silent and creates no request', async () => {
    const { done } = runHook();
    const r = await done;
    expect(r).toEqual({ code: 0, stdout: '' });
    expect(env.db.prepare('SELECT COUNT(*) AS c FROM permission_requests').get()).toEqual({ c: 0 });
  });

  it('turning the bridge on (after a confirmation) updates the capture policy the script reads', async () => {
    await page.click('[data-bridge-on]');
    await page.waitForSelector('[data-bridge-status="on"]');
    expect(JSON.parse(fs.readFileSync(env.paths.policy, 'utf8')).permissionBridge).toMatchObject({ enabled: true });
    expect(await page.getAttribute('[data-bridge-capture]', 'data-bridge-capture')).toBe('on');
  });
});

describe('answering a real request from the browser', () => {
  it('ALLOW: the waiting script prints the allow decision after the person clicks "Allow once"', async () => {
    await post('sess-perm', 'SessionStart', { source: 'startup' });
    await post('sess-perm', 'UserPromptSubmit');
    await post('sess-perm', 'PermissionRequest', { toolName: 'Bash' }); // the (async) status hook: the robot raises its alert
    await page.goto(env.origin + '/#/');
    const { child, done } = runHook();
    await waitCard();
    expect(await page.textContent('[data-perm-summary]')).toBe('npm test --silent');
    expect(await page.textContent(card)).toContain('Bash');
    expect(await page.isEnabled('[data-perm-allow]')).toBe(true);
    expect(child.exitCode).toBeNull(); // still waiting: it has decided nothing
    if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'v4b-request.png') });
    await page.click('[data-perm-allow]');
    const r = await done;
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } });
    await page.waitForFunction(() => !document.querySelector('[data-permission]'));
  });

  it('DENY: the script prints the deny decision', async () => {
    const { done } = runHook({ tool_input: { command: 'rm -rf build' } });
    await waitCard();
    expect(await page.textContent('[data-perm-summary]')).toBe('rm -rf build');
    await page.click('[data-perm-deny]');
    const r = await done;
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout).hookSpecificOutput.decision).toMatchObject({ behavior: 'deny' });
    await page.waitForFunction(() => !document.querySelector('[data-permission]'));
  });

  it('can also be answered from the robot in the office (details card)', async () => {
    await page.waitForSelector('[data-office-robots] li[data-alert="permission"]', { state: 'attached' });
    const { done } = runHook({ tool_name: 'Edit', tool_input: { file_path: path.join(projectDir, 'src', 'a.ts'), old_string: 'SECRET-OLD', new_string: 'SECRET-NEW' } });
    await waitCard();
    expect(await page.textContent('[data-perm-summary]')).toBe('edit <project>\\src\\a.ts'); // path relative to the project, never the file contents
    await page.click('[data-perm-allow]');
    expect((await done).stdout).toContain('"behavior":"allow"');
  });

  it('a secret in the command is redacted before it ever reaches the screen', async () => {
    const { done } = runHook({ tool_input: { command: 'curl -H "Authorization: Bearer ABCDEFGHIJKLMNOPQRSTUV123456" https://x.example' } });
    await waitCard();
    const text = (await page.textContent('[data-perm-summary]')) ?? '';
    expect(text).not.toContain('ABCDEFGHIJKLMNOPQRSTUV123456');
    await page.click('[data-perm-deny]');
    await done;
  });

  it('DETAILS HIDDEN (tool-input capture off): the request shows no command, "Allow" is disabled, and Deny still works', async () => {
    await api('PUT', '/api/settings/privacy', { toolInputs: false });
    const { done } = runHook({ tool_input: { command: 'echo HIDDEN-COMMAND-TEXT' } });
    await waitCard();
    expect(await page.getAttribute(card, 'data-can-allow')).toBe('false');
    expect(await page.isDisabled('[data-perm-allow]')).toBe(true);
    expect(await page.textContent(card)).toContain('hidden by your privacy settings');
    expect(await page.textContent(card)).not.toContain('HIDDEN-COMMAND-TEXT');
    await page.click('[data-perm-deny]');
    expect(JSON.parse((await done).stdout).hookSpecificOutput.decision.behavior).toBe('deny');
    await api('PUT', '/api/settings/privacy', { toolInputs: true, confirm: true });
  });

  it('NO ANSWER: when the request expires the script prints NOTHING (Claude Code asks in the terminal) and the card disappears', async () => {
    const { done } = runHook();
    await waitCard();
    env.db.prepare("UPDATE permission_requests SET expires_at = ? WHERE status = 'pending'").run(Date.now() - 1000);
    const r = await done;
    expect(r).toEqual({ code: 0, stdout: '' });
    await page.waitForFunction(() => !document.querySelector('[data-permission]'), undefined, { timeout: 15_000 });
  });

  it('ANSWERED IN THE TERMINAL: when the session carries on, the card goes away and the script prints nothing', async () => {
    const { done } = runHook({ tool_name: 'Bash' });
    await waitCard();
    await post('sess-perm', 'PostToolUse', { toolName: 'Bash' }); // Claude Code went on: the person answered in the terminal
    const r = await done;
    expect(r).toEqual({ code: 0, stdout: '' });
    await page.waitForFunction(() => !document.querySelector('[data-permission]'), undefined, { timeout: 15_000 });
  });

  it('a request from an unregistered folder never reaches the office', async () => {
    const other = path.join(env.root, 'Elsewhere');
    fs.mkdirSync(other);
    const before = (env.db.prepare('SELECT COUNT(*) AS c FROM permission_requests').get() as { c: number }).c;
    const r = await runHook({ cwd: other }).done;
    expect(r).toEqual({ code: 0, stdout: '' });
    expect((env.db.prepare('SELECT COUNT(*) AS c FROM permission_requests').get() as { c: number }).c).toBe(before);
  });
});

describe('history and privacy', () => {
  it('Settings lists what happened (tool, project, result) and never the command', async () => {
    await page.goto(env.origin + '/#/settings');
    await page.waitForSelector('[data-bridge-recent]');
    const text = (await page.textContent('[data-permission-bridge]')) ?? '';
    expect(text).toContain('Allowed by you');
    expect(text).toContain('Denied by you');
    expect(text).toContain('No answer');
    for (const secret of ['npm test', 'rm -rf build', 'HIDDEN-COMMAND-TEXT', 'SECRET-OLD', 'ABCDEFGHIJKLMNOPQRSTUV']) expect(text).not.toContain(secret);
    expect(env.db.prepare("SELECT COUNT(*) AS c FROM permission_requests WHERE summary IS NOT NULL AND status <> 'pending'").get()).toEqual({ c: 0 });
  });

  it('turning the bridge off makes the script silent again', async () => {
    await page.click('[data-bridge-off]');
    await page.waitForSelector('[data-bridge-status="off"]');
    expect(await runHook().done).toEqual({ code: 0, stdout: '' });
  });

  it('Removing the hook restores the settings file; the Settings page has no horizontal scroll at 360 px', async () => {
    await page.click('[data-bridge-uninstall]');
    await page.waitForSelector('[data-bridge-hook="not_installed"]');
    expect(JSON.parse(fs.readFileSync(env.settingsPath, 'utf8'))).toEqual({});
    const ctx = await browser.newContext({ viewport: { width: 360, height: 800 } });
    const p = await ctx.newPage();
    await p.goto(env.createLaunchUrl());
    await p.goto(env.origin + '/#/settings');
    await p.waitForSelector('[data-permission-bridge]');
    expect(await p.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
    await ctx.close();
  });
});
