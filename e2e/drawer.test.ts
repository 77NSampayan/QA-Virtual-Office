/** Side drawer for row details (headless Edge, demo data). */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { chromium, type Browser } from 'playwright-core';
import * as qa from '../apps/server/src/qa.ts';
import * as qaDefects from '../apps/server/src/qaDefects.ts';
import { makeEnv, uiHeaders, type TestEnv } from '../apps/server/test/helpers.ts';

const ROOT = path.resolve(__dirname, '..');
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
let env: TestEnv;
let browser: Browser;
beforeAll(async () => {
  expect(fs.existsSync(path.join(ROOT, 'apps/web/dist/index.html')), 'run `npm run build:web` first').toBe(true);
  env = await makeEnv({ listen: true, auth: true, webDist: path.join(ROOT, 'apps/web/dist') });
  const cookie = `qavo_session=${env.auth.issueSession()}`;
  const dir = path.join(env.root, 'DrawerProject');
  fs.mkdirSync(dir);
  const r = await env.app.inject({ method: 'POST', url: '/api/projects', headers: { ...uiHeaders(env), cookie }, payload: { alias: 'Drawer Project', path: dir } });
  const pid = r.json().project.id as string;
  for (const t of ['Login works', 'Logout works']) qa.createTestCase(env.db, pid, { title: t, steps: ['a'], expectedResult: 'b' }, 'human');
  qaDefects.createDefect(env.db, pid, { title: 'Button misaligned', severity: 'minor', priority: 'low', description: 'fake' }, 'human');
  browser = await chromium.launch({ executablePath: EDGE, headless: true });
});
afterAll(async () => {
  await browser?.close();
  await env.cleanup();
});

const pickProject = async (page: import('playwright-core').Page) => {
  await page.waitForSelector('[data-project-select]');
  const v = await page.$$eval('[data-project-select] option', (o) => (o as HTMLOptionElement[]).map((x) => x.value).filter(Boolean));
  await page.selectOption('[data-project-select]', v[0]!);
};

describe('row details open in a side drawer', () => {
  it('opens beside the table on a wide screen, switches rows, closes with Close and Escape, keeps the table usable', async () => {
    const page = await (await browser.newContext({ viewport: { width: 1600, height: 900 } })).newPage();
    await page.goto(env.createLaunchUrl());
    await page.waitForSelector('.shell');
    await page.evaluate(() => (location.hash = '#/manual'));
    await pickProject(page);
    await page.click('[data-tab="test-cases"]');
    await page.waitForSelector('tr[data-tc]');
    const codes = await page.$$eval('tr[data-tc]', (r) => r.map((x) => x.getAttribute('data-tc')!));
    expect(codes.length).toBeGreaterThan(1);
    await page.click(`tr[data-tc="${codes[0]}"]`);
    await page.waitForSelector(`[data-drawer] [data-tc-detail="${codes[0]}"]`);
    expect(await page.getAttribute('[data-drawer]', 'aria-label')).toContain(codes[0]!);
    // the table is not covered: the second row is still clickable, and the drawer follows it
    await page.click(`tr[data-tc="${codes[1]}"]`);
    await page.waitForSelector(`[data-drawer] [data-tc-detail="${codes[1]}"]`);
    if (process.env.QAVO_E2E_SHOTS) await page.screenshot({ path: path.join(process.env.QAVO_E2E_SHOTS, 'drawer.png') });
    expect(await page.locator('[data-drawer]').count()).toBe(1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    await page.click('[data-drawer-close]');
    expect(await page.locator('[data-drawer]').count()).toBe(0);
    await page.click(`tr[data-tc="${codes[0]}"]`);
    await page.waitForSelector('[data-drawer]');
    await page.keyboard.press('Escape');
    await page.waitForSelector('[data-drawer]', { state: 'detached' });
    await page.context().close();
  });

  it('Escape does not close the drawer while typing in a field', async () => {
    const page = await (await browser.newContext({ viewport: { width: 1600, height: 900 } })).newPage();
    await page.goto(env.createLaunchUrl());
    await page.waitForSelector('.shell');
    await page.evaluate(() => (location.hash = '#/manual'));
    await pickProject(page);
    await page.click('[data-tab="defects"]');
    await page.waitForSelector('tr[data-defect]');
    await page.click('tr[data-defect]');
    await page.waitForSelector('[data-drawer] textarea, [data-drawer] input');
    await page.focus('[data-drawer] textarea, [data-drawer] input');
    await page.keyboard.press('Escape');
    expect(await page.locator('[data-drawer]').count()).toBe(1);
    await page.context().close();
  });
});
