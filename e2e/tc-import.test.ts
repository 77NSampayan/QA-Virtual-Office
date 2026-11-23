/**
 * Test-case import in a real browser (headless Edge): paste a Markdown table and a spreadsheet paste, load a file,
 * preview, import as DRAFTS, re-import safely. Results columns are never imported; nothing is approved or executed.
 * All data is created in an isolated database for the test.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { chromium, type Browser, type Page } from 'playwright-core';
import { makeEnv, uiHeaders, type TestEnv } from '../apps/server/test/helpers.ts';

const ROOT = path.resolve(__dirname, '..');
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';

let env: TestEnv;
let browser: Browser;
let page: Page;
let pid: string;
let cookie: string;

const api = async (method: string, url: string, payload?: unknown) => {
  const r = await env.app.inject({ method: method as 'GET', url, headers: { ...uiHeaders(env), cookie }, payload: payload as object });
  return r.body ? r.json() : null;
};

const MD = [
  '| Module | Sub Module | Test Case ID | Test Case Description | Test Case Type | Pre-Condition | Steps | Expected Result | Actual Result | Status | Test Execution Status | Defect ID |',
  '|---|---|---|---|---|---|---|---|---|---|---|---|',
  '| Auth | Login | TC_001 | Sign in with valid credentials | Positive | Account exists | 1. Open login<br>2. Submit | Dashboard is shown | Dashboard shown | Passed | Passed | DEF-9 |',
  '| Auth | Login | TC_002 | Wrong password is refused | Negative | | | Error is shown | | | | |',
].join('\n');
const TSV = ['Module\tTest Case ID\tTest Case Description\tExpected Result\tStatus', 'Cart\tC_10\tAdd a product to the cart\t"Cart shows 1 item,\nsubtotal is updated"\tPassed'].join('\n');

beforeAll(async () => {
  expect(fs.existsSync(path.join(ROOT, 'apps/web/dist/index.html')), 'run `npm run build:web` first').toBe(true);
  env = await makeEnv({ listen: true, auth: true, webDist: path.join(ROOT, 'apps/web/dist') });
  cookie = `qavo_session=${env.auth.issueSession()}`;
  const dir = path.join(env.root, 'ShopWeb');
  fs.mkdirSync(dir);
  pid = (await api('POST', '/api/projects', { alias: 'Shop Web', path: dir })).project.id;
  browser = await chromium.launch({ executablePath: EDGE, headless: true });
  page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
  await page.goto(env.createLaunchUrl());
  await page.waitForSelector('[data-page="overview"]');
  await page.goto(env.origin + '/#/manual');
  await page.waitForSelector('[data-page="manual-qa"] [data-project-select]');
  await page.selectOption('[data-project-select]', { label: 'Shop Web' });
  await page.click('button[data-tab="test-cases"]');
  await page.waitForSelector('[data-panel="test-cases"]');
});
afterAll(async () => {
  await browser?.close();
  await env.cleanup();
});

const openImport = async () => {
  if (!(await page.$('[data-tc-import]'))) await page.click('[data-tc-import-toggle]');
  await page.waitForSelector('[data-tc-import]');
};

describe('test-case import (browser)', () => {
  it('previews a Markdown table, writes nothing, then imports drafts', async () => {
    await openImport();
    await page.fill('[data-tc-import-text]', MD);
    await page.click('[data-tc-import-preview-btn]');
    await page.waitForSelector('[data-tc-import-result]');
    expect(await page.textContent('[data-tc-import-summary]')).toMatch(/2 to import/);
    const cols = (await page.textContent('[data-tc-import-columns]')) ?? '';
    expect(cols).toMatch(/Not imported \(results\/automation\): .*Actual Result/);
    expect((await api('GET', `/api/projects/${pid}/test-cases`)).length).toBe(0); // preview wrote nothing

    await page.click('[data-tc-import-run]');
    await page.waitForSelector('[data-tc="TC-0001"]');
    expect(await page.textContent('[data-tc="TC-0001"] [data-tc-external]')).toBe('TC_001');
    const list = await api('GET', `/api/projects/${pid}/test-cases`);
    expect(list.map((t: { externalId: string }) => t.externalId)).toEqual(['TC_001', 'TC_002']);
    for (const t of list) expect(t).toMatchObject({ status: 'draft', authoredBy: 'human', approvedBy: null, executionStatus: 'NOT RUN' });
    expect(list[0].steps).toEqual(['Open login', 'Submit']);
    expect(await page.textContent('[data-tc="TC-0001"] [data-tc-status]')).toMatch(/Draft/i);
    expect(JSON.stringify(list)).not.toMatch(/DEF-9|Dashboard shown/); // result columns were never stored
  });

  it('importing the same table again changes nothing', async () => {
    await openImport();
    await page.fill('[data-tc-import-text]', MD);
    await page.click('[data-tc-import-preview-btn]');
    await page.waitForSelector('[data-tc-import-result]');
    expect(await page.textContent('[data-tc-import-summary]')).toMatch(/0<\/?strong>|0 to import/);
    expect(await page.textContent('[data-tc-import-summary]')).toMatch(/2 already exist/);
    expect(await page.isDisabled('[data-tc-import-run]')).toBe(true);
    expect((await api('GET', `/api/projects/${pid}/test-cases`)).length).toBe(2);
  });

  it('imports cells pasted from a spreadsheet and loads a file', async () => {
    await openImport();
    await page.fill('[data-tc-import-text]', TSV);
    await page.click('[data-tc-import-preview-btn]');
    await page.waitForSelector('[data-tc-import-result]');
    await page.click('[data-tc-import-run]');
    await page.waitForSelector('[data-tc="TC-0003"]');
    const list = await api('GET', `/api/projects/${pid}/test-cases`);
    expect(list[2]).toMatchObject({ externalId: 'C_10', scenario: 'Cart', expectedResult: 'Cart shows 1 item,\nsubtotal is updated' });

    const file = path.join(env.root, 'cases.md');
    fs.writeFileSync(file, '| Test Case ID | Test Case Description |\n|---|---|\n| F_1 | From a file |\n');
    await openImport();
    await page.setInputFiles('[data-tc-import-file]', file);
    await page.waitForFunction(() => (document.querySelector('[data-tc-import-text]') as HTMLTextAreaElement).value.includes('F_1'));
    await page.click('[data-tc-import-preview-btn]');
    await page.waitForSelector('[data-tc-import-result]');
    await page.click('[data-tc-import-run]');
    await page.waitForSelector('[data-tc="TC-0004"]');
  });

  it('shows problems instead of hiding them, and search finds the sheet id', async () => {
    await openImport();
    await page.fill('[data-tc-import-text]', '| Test Case ID | Test Case Description | Test Case Type |\n|---|---|---|\n| W_1 | A case | Smoke |\n| W_2 | | Positive |');
    await page.click('[data-tc-import-preview-btn]');
    await page.waitForSelector('[data-tc-import-problems]');
    const problems = (await page.textContent('[data-tc-import-problems]')) ?? '';
    expect(problems).toMatch(/Row 2: The test case description is empty/);
    expect(problems).toMatch(/Smoke/);
    await page.fill('input[placeholder="Search…"]', 'c_10');
    await page.waitForFunction(() => document.querySelectorAll('tr[data-tc]').length === 1);
    expect(await page.textContent('tr[data-tc] [data-tc-external]')).toBe('C_10');
  });

  it('keeps the layout at phone width without horizontal page scroll', async () => {
    await page.setViewportSize({ width: 360, height: 800 });
    await openImport();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);
    await page.setViewportSize({ width: 1280, height: 900 });
  });
});
