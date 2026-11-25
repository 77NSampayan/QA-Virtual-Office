/** Pass 3 D1 (headless Edge): test data profiles (fake data only, secret references) and the masking helper. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { chromium, type Browser, type Page } from 'playwright-core';
import { makeEnv, uiHeaders, type TestEnv } from '../apps/server/test/helpers.ts';
import { readAgentToken } from '../apps/server/src/dataDir.ts';

const ROOT = path.resolve(__dirname, '..');
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';

let env: TestEnv;
let browser: Browser;
let page: Page;
let pid: string;
let cookie: string;

const addField = async (i: number, key: string, kind: string, value: string) => {
  if ((await page.locator('[data-td-field]').count()) <= i) await page.click('[data-td-add]');
  const row = page.locator(`[data-td-field="${i}"]`);
  await row.locator('[data-td-key]').fill(key);
  await row.locator('[data-td-kind]').selectOption(kind);
  await row.locator('[data-td-value]').fill(value);
};

beforeAll(async () => {
  expect(fs.existsSync(path.join(ROOT, 'apps/web/dist/index.html')), 'run `npm run build:web` first').toBe(true);
  env = await makeEnv({ listen: true, auth: true, webDist: path.join(ROOT, 'apps/web/dist') });
  cookie = `qavo_session=${env.auth.issueSession()}`;
  const dir = path.join(env.root, 'Shop');
  fs.mkdirSync(dir);
  pid = (await env.app.inject({ method: 'POST', url: '/api/projects', headers: { ...uiHeaders(env), cookie }, payload: { alias: 'Shop', path: dir } })).json().project.id as string;
  browser = await chromium.launch({ executablePath: EDGE, headless: true });
  page = await (await browser.newContext({ viewport: { width: 1366, height: 768 } })).newPage();
  await page.goto(env.createLaunchUrl());
  await page.waitForSelector('.shell');
  await page.evaluate(() => (location.hash = '#/test-data'));
  await page.waitForSelector('[data-page="test-data"] [data-td-new]');
});
afterAll(async () => {
  await browser?.close();
  await env.cleanup();
});

describe('Test Data Management', () => {
  it('refuses real-looking data and a secret value with a reason per field, and saves nothing', async () => {
    await page.click('[data-td-new]');
    await page.waitForSelector('[data-drawer] [data-td-editor="new"]');
    await page.fill('[data-td-name]', 'Checkout user');
    await page.fill('[data-td-env]', 'staging');
    await addField(0, 'email', 'fixed', 'maria.santos@gmail.com');
    await addField(1, 'password', 'fixed', 'Hunter2!');
    await page.click('[data-td-save]');
    await page.waitForSelector('[data-drawer] .error');
    const err = (await page.textContent('[data-drawer] .error')) ?? '';
    expect(err).toMatch(/email: looks like real data/);
    expect(err).toMatch(/password: a field named like a secret/);
    expect(await page.locator('[data-td-row]').count()).toBe(0);
  });

  it('saves fake values, a placeholder and a secret reference, lists the profile, and keeps no secret', async () => {
    await addField(0, 'email', 'fixed', 'jane.tester@example.test');
    await addField(1, 'password', 'secret_ref', 'SHOP_TEST_PASSWORD');
    await addField(2, 'runId', 'placeholder', '${RUN_ID}');
    await page.click('[data-td-save]');
    await page.waitForSelector('[data-td-row="TD-001"]');
    expect(await page.textContent('[data-td-row="TD-001"]')).toMatch(/Checkout user.*staging.*3/s);
    const saved = (await env.app.inject({ method: 'GET', url: `/api/projects/${pid}/test-data`, headers: { ...uiHeaders(env), cookie } })).json() as Array<{ id: string }>;
    const detail = (await env.app.inject({ method: 'GET', url: `/api/test-data/${saved[0]!.id}`, headers: { ...uiHeaders(env), cookie } })).json();
    expect(detail.fields).toEqual([
      { key: 'email', kind: 'fixed', value: 'jane.tester@example.test' },
      { key: 'password', kind: 'secret_ref', value: 'SHOP_TEST_PASSWORD' },
      { key: 'runId', kind: 'placeholder', value: '${RUN_ID}' },
    ]);
    if (process.env.QAVO_E2E_SHOTS) await page.screenshot({ path: path.join(process.env.QAVO_E2E_SHOTS, 'test-data.png') });
  });

  it('the masking helper shows what was masked and stores nothing', async () => {
    await page.click('[data-drawer-close]');
    await page.fill('[data-td-mask-text]', 'Customer maria.santos@gmail.com paid with token=abcdefghijklmnopqrstuvwxyz123456');
    await page.click('[data-td-mask-btn]');
    await page.waitForSelector('[data-td-mask-result]');
    expect(await page.textContent('[data-td-mask-summary]')).toMatch(/Masked:.*email/);
    const out = (await page.textContent('[data-td-mask-output]')) ?? '';
    expect(out).not.toMatch(/maria\.santos|abcdefghijklmnop/);
    expect(out).toMatch(/\[REDACTED:/);
  });

  it('edits keep the same rules; the person can delete a profile', async () => {
    await page.click('[data-td-row="TD-001"]');
    await page.waitForSelector('[data-td-editor]');
    await page.waitForFunction(() => (document.querySelector('[data-td-name]') as HTMLInputElement | null)?.value === 'Checkout user');
    await addField(0, 'email', 'fixed', 'someone.real@yahoo.com');
    await page.click('[data-td-save]');
    await page.waitForSelector('[data-drawer] .error');
    await addField(0, 'email', 'fixed', 'jane.tester@example.test');
    await page.click('[data-td-save]');
    await page.waitForSelector('[data-drawer] .ok');
    page.once('dialog', (d) => void d.accept());
    await page.click('[data-td-delete]');
    await page.waitForSelector('[data-td-row]', { state: 'detached' });
  });

  it('only the signed-in person can use it: not the agent token, hook token or a request without the cookie', async () => {
    const attempt = (headers: Record<string, string>) =>
      env.app.inject({ method: 'POST', url: `/api/projects/${pid}/test-data`, headers: { ...headers, 'content-type': 'application/json' }, payload: { name: 'x', environment: '', description: '', fields: [] } });
    expect((await attempt({ host: env.host, 'x-qavo-agent-token': readAgentToken(env.paths) })).statusCode).toBeGreaterThanOrEqual(400);
    expect((await attempt({ host: env.host, 'x-qavo-token': env.token })).statusCode).toBeGreaterThanOrEqual(400);
    expect((await attempt({ ...uiHeaders(env) })).statusCode).toBe(401);
  });

  it('has no horizontal scroll at phone width', async () => {
    await page.setViewportSize({ width: 360, height: 800 });
    await page.reload();
    await page.waitForSelector('[data-page="test-data"] [data-td-new]');
    await page.click('[data-td-new]');
    await page.waitForSelector('[data-drawer]');
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
    await page.setViewportSize({ width: 1366, height: 768 });
  });
});
