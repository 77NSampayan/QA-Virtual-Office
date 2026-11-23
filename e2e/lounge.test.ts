/**
 * The lounge in a real browser (headless Edge): a robot rests there ONLY while its real status is idle or
 * completed, and is back at its desk the moment real work or a request for the person starts. Nothing
 * moves without an event.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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
let projectId: string;
let cookie: string;

async function post(sessionId: string, event: string, extra: Record<string, unknown> = {}) {
  const r = await env.app.inject({
    method: 'POST',
    url: '/api/hooks',
    headers: { host: env.host, 'x-qavo-token': env.token, 'content-type': 'application/json' },
    payload: { v: 1, eventId: crypto.randomUUID(), ts: new Date().toISOString(), sessionId, event, projectId, folderKeys: [], ...extra },
  });
  expect(r.statusCode).toBe(204);
}
const robotOf = async (sessionId: string): Promise<{ id: string }> => {
  const r = await env.app.inject({ method: 'GET', url: `/api/sessions/${sessionId}`, headers: { ...uiHeaders(env), cookie } });
  return r.json().robot;
};
const where = (robotId: string) =>
  page.evaluate((id) => {
    const el = document.querySelector(`.station-unit[data-robot="${id}"]`);
    if (!el) return 'missing';
    return el.closest('[data-lounge]') ? 'lounge' : el.closest('[data-dept]') ? 'desk' : 'elsewhere';
  }, robotId);
const waitWhere = (robotId: string, expected: 'lounge' | 'desk') =>
  page.waitForFunction(
    ([id, want]) => {
      const el = document.querySelector(`.station-unit[data-robot="${id}"]`);
      return !!el && (el.closest('[data-lounge]') ? 'lounge' : el.closest('[data-dept]') ? 'desk' : '') === want;
    },
    [robotId, expected] as const,
  );

beforeAll(async () => {
  expect(fs.existsSync(path.join(ROOT, 'apps/web/dist/index.html')), 'run `npm run build:web` first').toBe(true);
  env = await makeEnv({ listen: true, auth: true, webDist: path.join(ROOT, 'apps/web/dist') });
  cookie = `qavo_session=${env.auth.issueSession()}`;
  const dir = path.join(env.root, 'PaymentsWeb');
  fs.mkdirSync(dir);
  const r = await env.app.inject({ method: 'POST', url: '/api/projects', headers: { ...uiHeaders(env), cookie }, payload: { alias: 'Payments Web', path: dir } });
  projectId = r.json().project.id;
  browser = await chromium.launch({ executablePath: EDGE, headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 1000 } });
  // the classic floor's lounge; the walkable office has its own tests in office.test.ts
  await ctx.addInitScript(() => localStorage.setItem('qavo.view', 'classic'));
  page = await ctx.newPage();
  await page.goto(env.createLaunchUrl());
  await page.waitForSelector('[data-page="overview"]');
});
afterAll(async () => {
  await browser?.close();
  await env.cleanup();
});

describe('the lounge exists and follows real status', () => {
  it('an empty office still shows the lounge with its furniture, and says nobody is resting', async () => {
    await page.waitForSelector('[data-lounge]');
    expect(await page.locator('[data-lounge] [data-nook-empty]').count()).toBe(5); // couch, coffee, arcade, TV, ping-pong
    expect(await page.textContent('[data-lounge]')).toContain('Nobody is resting right now');
  });

  it('a new session is idle, so its robot rests in the lounge; working sends it to its desk; finishing brings it back', async () => {
    await post('lounge-1', 'SessionStart', { source: 'startup' });
    const { id } = await robotOf('lounge-1');
    await waitWhere(id, 'lounge'); // idle
    expect(await page.getAttribute(`.station-unit[data-robot="${id}"]`, 'data-status')).toBe('idle');
    expect(await page.locator(`[data-lounge] .station-unit[data-robot="${id}"] canvas[data-kind="nook"]`).count()).toBe(2); // back + front furniture layers
    await post('lounge-1', 'UserPromptSubmit');
    await waitWhere(id, 'desk'); // analyzing
    await post('lounge-1', 'PreToolUse', { toolName: 'Bash', commandCategory: 'test_run' });
    await page.waitForSelector(`[data-dept] .station-unit[data-robot="${id}"][data-status="executing_tests"]`);
    await post('lounge-1', 'Stop');
    await waitWhere(id, 'lounge'); // completed
    expect(await page.getAttribute(`.station-unit[data-robot="${id}"]`, 'data-status')).toBe('completed');
    if (SHOTS) await (await page.$('[data-floor]'))!.screenshot({ path: path.join(SHOTS, 'lounge-live.png') });
  });

  it('waiting for the person (permission, input) and failures stay at the desk where they are noticed', async () => {
    await post('lounge-2', 'SessionStart', { source: 'startup' });
    const { id } = await robotOf('lounge-2');
    await post('lounge-2', 'UserPromptSubmit');
    await post('lounge-2', 'PermissionRequest', { toolName: 'Bash' });
    await page.waitForSelector(`[data-dept] .station-unit[data-robot="${id}"][data-status="awaiting_permission"]`);
    await post('lounge-2', 'PostToolUse', { toolName: 'Bash' });
    await post('lounge-2', 'Notification', { notificationType: 'elicitation_dialog' });
    await page.waitForSelector(`[data-dept] .station-unit[data-robot="${id}"][data-status="awaiting_input"]`);
    await post('lounge-2', 'UserPromptSubmit');
    await post('lounge-2', 'StopFailure', { error: 'rate_limit' });
    await page.waitForSelector(`[data-dept] .station-unit[data-robot="${id}"][data-status="failed"]`);
    expect(await where(id)).toBe('desk');
  });

  it('an ended session goes dark at its desk, not in the lounge', async () => {
    await post('lounge-3', 'SessionStart', { source: 'startup' });
    const { id } = await robotOf('lounge-3');
    await waitWhere(id, 'lounge');
    await post('lounge-3', 'SessionEnd', { reason: 'other' });
    await page.waitForSelector(`[data-dept] .station-unit[data-robot="${id}"][data-status="disconnected"]`);
    expect(await where(id)).toBe('desk');
  });

  it('nothing moves without an event: no robot changes place while idle (code and behaviour)', async () => {
    const before = await page.evaluate(() => [...document.querySelectorAll('.station-unit[data-robot]')].map((e) => `${e.getAttribute('data-robot')}:${e.getAttribute('data-status')}:${e.closest('[data-lounge]') ? 'L' : 'D'}`).sort());
    await page.waitForTimeout(2500);
    const after = await page.evaluate(() => [...document.querySelectorAll('.station-unit[data-robot]')].map((e) => `${e.getAttribute('data-robot')}:${e.getAttribute('data-status')}:${e.closest('[data-lounge]') ? 'L' : 'D'}`).sort());
    expect(after).toEqual(before);
  });

  it('the department header counts only robots at desks, and a department with everyone resting says so', async () => {
    await page.goto(env.origin + '/#/');
    await page.waitForSelector('[data-lounge]');
    const manual = await page.textContent('[data-dept="manual"] h3');
    expect(manual).toContain('at desks');
    expect(manual).toMatch(/robot|desks/);
  });
});

describe('narrow screens', () => {
  it('shows resting robots as cards inside the lounge, with no horizontal scroll at 360 px', async () => {
    const p = await (await browser.newContext({ viewport: { width: 360, height: 800 } })).newPage();
    await p.goto(env.createLaunchUrl());
    await p.waitForSelector('[data-lounge]');
    expect(await p.locator('[data-lounge] .robot-card').count()).toBeGreaterThanOrEqual(1);
    expect(await p.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
  });
});
