/** Pass 3 A1 (headless Edge): import JUnit results, pass rate with its denominator, classify failures, human-only. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { chromium, type Browser, type Page } from 'playwright-core';
import * as qa from '../apps/server/src/qa.ts';
import { makeEnv, uiHeaders, type TestEnv } from '../apps/server/test/helpers.ts';
import { readAgentToken } from '../apps/server/src/dataDir.ts';

const ROOT = path.resolve(__dirname, '..');
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const XML = `<?xml version="1.0"?><testsuites><testsuite name="checkout"><testcase classname="shop.Cart" name="TC-0001 adds an item" time="0.4"/>
<testcase classname="shop.Cart" name="removes an item" time="0.2"><failure message="expected 0 but was 1&#10;at Cart.js:10"><![CDATA[stack trace C:\\Users\\someone\\x.js]]></failure></testcase>
<testcase classname="shop.Cart" name="coupon" time="0"><skipped message="later"/></testcase></testsuite></testsuites>`;

let env: TestEnv;
let browser: Browser;
let page: Page;
let pid: string;
let cookie: string;

beforeAll(async () => {
  expect(fs.existsSync(path.join(ROOT, 'apps/web/dist/index.html')), 'run `npm run build:web` first').toBe(true);
  env = await makeEnv({ listen: true, auth: true, webDist: path.join(ROOT, 'apps/web/dist') });
  cookie = `qavo_session=${env.auth.issueSession()}`;
  const dir = path.join(env.root, 'Shop');
  fs.mkdirSync(dir);
  pid = (await env.app.inject({ method: 'POST', url: '/api/projects', headers: { ...uiHeaders(env), cookie }, payload: { alias: 'Shop', path: dir } })).json().project.id as string;
  qa.createTestCase(env.db, pid, { title: 'Add to cart', steps: ['a'], expectedResult: 'b' }, 'human');
  browser = await chromium.launch({ executablePath: EDGE, headless: true });
  page = await (await browser.newContext({ viewport: { width: 1366, height: 768 } })).newPage();
  await page.goto(env.createLaunchUrl());
  await page.waitForSelector('.shell');
});
afterAll(async () => {
  await browser?.close();
  await env.cleanup();
});

describe('Test Automation page', () => {
  it('scans the project folder for test frameworks: names and versions only, nothing stored', async () => {
    const dir = path.join(env.root, 'Shop');
    fs.writeFileSync(path.join(dir, 'playwright.config.ts'), 'export default { token: "do-not-read-me" }');
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ devDependencies: { '@playwright/test': '^1.48.0' } }));
    fs.writeFileSync(path.join(dir, 'pytest.ini'), '');
    await page.evaluate(() => (location.hash = '#/automation'));
    await page.waitForSelector('[data-auto-detect-btn]');
    expect(await page.locator('[data-auto-detect-result]').count()).toBe(0); // never scans on its own
    await page.click('[data-auto-detect-btn]');
    await page.waitForSelector('[data-framework="playwright"]');
    expect(await page.getAttribute('[data-framework="playwright"]', 'data-framework-confidence')).toBe('config');
    const text = (await page.textContent('[data-auto-detect-result]')) ?? '';
    expect(text).toMatch(/playwright\.config\.ts/);
    expect(text).toMatch(/\^1\.48\.0/);
    expect(text).toMatch(/junit reporter/i);
    expect(text).not.toContain('do-not-read-me');
    expect(text).not.toContain(path.basename(env.root));
    await page.waitForSelector('[data-framework="pytest"]');
    if (process.env.QAVO_E2E_SHOTS) await page.screenshot({ path: path.join(process.env.QAVO_E2E_SHOTS, 'automation-detect.png') });
    // a person only: agent token, hook token and no cookie are refused
    const attempt = (headers: Record<string, string>) => env.app.inject({ method: 'POST', url: `/api/projects/${pid}/automation/detect`, headers: { ...headers, 'content-type': 'application/json' }, payload: '{}' });
    expect((await attempt({ host: env.host, 'x-qavo-agent-token': readAgentToken(env.paths) })).statusCode).toBeGreaterThanOrEqual(400);
    expect((await attempt({ host: env.host, 'x-qavo-token': env.token })).statusCode).toBeGreaterThanOrEqual(400);
    expect((await attempt({ ...uiHeaders(env) })).statusCode).toBe(401);
  });

  it('previews a JUnit file with the pass-rate formula, imports it, and shows the run', async () => {
    await page.evaluate(() => (location.hash = '#/automation'));
    await page.waitForSelector('[data-page="automation"] [data-auto-import]');
    await page.setInputFiles('[data-auto-file]', { name: 'results.xml', mimeType: 'text/xml', buffer: Buffer.from(XML) });
    await page.fill('[data-auto-name]', 'Nightly');
    await page.fill('[data-auto-env]', 'staging');
    await page.click('[data-auto-preview-btn]');
    await page.waitForSelector('[data-auto-preview]');
    const summary = (await page.textContent('[data-auto-summary]')) ?? '';
    expect(summary).toMatch(/3.*test result/);
    expect(summary).toMatch(/50% \(1 of 2\)/); // skipped is not in the denominator
    expect(summary).toMatch(/passed ÷ \(passed \+ failed \+ errored\)/);
    await page.click('[data-auto-run]');
    await page.waitForSelector('[data-auto-run-row="AR-001"]');
    expect(await page.textContent('[data-auto-run-row="AR-001"] [data-auto-rate]')).toMatch(/50% \(1 of 2\)/);
    expect(await page.textContent('[data-auto-run-row="AR-001"]')).toMatch(/Nightly.*staging/);
  });

  it('the same file cannot be imported twice', async () => {
    await page.setInputFiles('[data-auto-file]', { name: 'results.xml', mimeType: 'text/xml', buffer: Buffer.from(XML) });
    await page.click('[data-auto-preview-btn]');
    await page.waitForSelector('[data-auto-duplicate]');
    expect(await page.textContent('[data-auto-duplicate]')).toMatch(/AR-001/);
    expect(await page.isDisabled('[data-auto-run]')).toBe(true);
  });

  it('opens the run in the drawer: failures first, "unknown" until a person classifies, no stack trace stored', async () => {
    await page.click('[data-auto-run-row="AR-001"]');
    await page.waitForSelector('[data-drawer] [data-auto-detail="AR-001"]');
    expect(await page.locator('[data-auto-result]').count()).toBe(1); // default filter: failures
    expect(await page.textContent('[data-auto-results]')).toMatch(/removes an item/);
    expect(await page.textContent('[data-auto-results]')).toMatch(/expected 0 but was 1/);
    expect(await page.textContent('[data-drawer]')).not.toMatch(/Cart\.js|stack trace|someone/);
    expect(await page.inputValue('[data-auto-classify]')).toBe('unknown');
    await page.selectOption('[data-auto-filter]', 'all');
    expect(await page.locator('[data-auto-result]').count()).toBe(3);
    expect(await page.textContent('[data-auto-results]')).toMatch(/mentions\s*TC-0001/);
    await page.selectOption('[data-auto-filter]', 'failures');
    await page.selectOption('[data-auto-classify]', 'environment');
    await page.waitForFunction(() => document.querySelector<HTMLSelectElement>('[data-auto-classify]')?.value === 'environment');
    if (process.env.QAVO_E2E_SHOTS) await page.screenshot({ path: path.join(process.env.QAVO_E2E_SHOTS, 'automation.png') });
    await page.click('[data-drawer-close]');
    await page.waitForFunction(() => !/\d/.test(document.querySelector('[data-auto-run-row="AR-001"] td:last-child')?.textContent ?? '0')); // unclassified count gone
  });

  it('the manual test case is untouched by the import, and the run can be deleted by the person', async () => {
    const cases = (await env.app.inject({ method: 'GET', url: `/api/projects/${pid}/test-cases`, headers: { ...uiHeaders(env), cookie } })).json() as Array<{ code: string; status: string; executionStatus: string }>;
    expect(cases).toHaveLength(1);
    expect(cases[0]!.status).toBe('draft');
    expect(cases[0]!.executionStatus).toMatch(/not.?run/i);
    await page.click('[data-auto-run-row="AR-001"]');
    await page.waitForSelector('[data-auto-delete]');
    page.once('dialog', (d) => void d.accept());
    await page.click('[data-auto-delete]');
    await page.waitForSelector('[data-auto-run-row]', { state: 'detached' });
  });

  it('only the signed-in person can import or classify: not the agent token, the hook token or a request without the cookie', async () => {
    const body = JSON.stringify({ text: XML });
    const attempt = (headers: Record<string, string>) =>
      env.app.inject({ method: 'POST', url: `/api/projects/${pid}/automation/import`, headers: { ...headers, 'content-type': 'application/json' }, payload: body });
    expect((await attempt({ host: env.host, 'x-qavo-agent-token': readAgentToken(env.paths) })).statusCode).toBeGreaterThanOrEqual(400);
    expect((await attempt({ host: env.host, 'x-qavo-token': env.token })).statusCode).toBeGreaterThanOrEqual(400);
    expect((await attempt({ ...uiHeaders(env) })).statusCode).toBe(401);
    expect((await attempt({ ...uiHeaders(env), cookie })).statusCode).toBe(201);
  });

  it('has no horizontal scroll at phone width', async () => {
    await page.setViewportSize({ width: 360, height: 800 });
    await page.evaluate(() => (location.hash = '#/automation'));
    await page.reload();
    await page.waitForSelector('[data-page="automation"]');
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
    await page.setViewportSize({ width: 1366, height: 768 });
  });
});
