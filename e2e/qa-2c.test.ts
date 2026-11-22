/**
 * Pass 2C acceptance in a real browser (headless Edge): defects (raised from a failed test, human-only
 * workflow), exploratory sessions (bug note -> defect), the task board, real Overview KPI, layout.
 * All data is created in an isolated database for the test.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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
let pid: string;
let cookie: string;

const api = async (method: string, url: string, payload?: unknown) => {
  const r = await env.app.inject({ method: method as 'GET', url, headers: { ...uiHeaders(env), cookie }, payload: payload as object });
  return r.body ? r.json() : null;
};
const shot = async (name: string, p: Page = page) => {
  if (SHOTS) await p.screenshot({ path: path.join(SHOTS, name), fullPage: true });
};

beforeAll(async () => {
  expect(fs.existsSync(path.join(ROOT, 'apps/web/dist/index.html')), 'run `npm run build:web` first').toBe(true);
  env = await makeEnv({ listen: true, auth: true, webDist: path.join(ROOT, 'apps/web/dist') });
  cookie = `qavo_session=${env.auth.issueSession()}`;
  const dir = path.join(env.root, 'PaymentsWeb');
  fs.mkdirSync(dir);
  pid = (await api('POST', '/api/projects', { alias: 'Payments Web', path: dir })).project.id;
  const t = await api('POST', `/api/projects/${pid}/test-cases`, { title: 'Lockout after 5 failures', steps: ['Open login', 'Fail 5 times'], expectedResult: 'Account locked' });
  await api('POST', `/api/test-cases/${t.id}/transition`, { to: 'in_review' });
  await api('POST', `/api/test-cases/${t.id}/transition`, { to: 'approved', note: 'ok' });
  browser = await chromium.launch({ executablePath: EDGE, headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  page = await ctx.newPage();
  await page.goto(env.createLaunchUrl());
  await page.waitForSelector('[data-page="overview"]');
});
afterAll(async () => {
  await browser?.close();
  await env.cleanup();
});

const openTab = async (tab: string, p: Page = page, hash = '#/manual') => {
  await p.goto(env.origin + '/' + hash);
  await p.waitForSelector('[data-page="manual-qa"] [data-project-select]');
  await p.selectOption('[data-project-select]', { label: 'Payments Web' });
  await p.click(`button[data-tab="${tab}"]`);
  await p.waitForSelector(`[data-panel="${tab}"]`);
};
const kpi = async (id: string) => ({
  value: (await page.textContent(`[data-kpi="${id}"] .kpi-value`))?.trim(),
  nodata: await page.getAttribute(`[data-kpi="${id}"]`, 'data-nodata'),
});

describe('before any defect', () => {
  it('"Open defects" says "No data yet"', async () => {
    await page.goto(env.origin + '/#/');
    await page.waitForSelector('[data-kpi="defects"]');
    expect(await kpi('defects')).toMatchObject({ nodata: 'true', value: 'No data yet' });
  });
});

describe('defect raised from a failed test', () => {
  it('fail a test, raise a defect from it, and see it pre-filled and linked', async () => {
    await openTab('execution');
    await page.fill('[data-run-name]', 'Sprint 1');
    await page.click('[data-create-run]');
    await page.waitForSelector('[data-run="RUN-001"]');
    await page.click('tr[data-exec="TC-0001"]');
    await page.fill('[data-result-note]', 'Account was not locked');
    await page.click('[data-set-result="failed"]');
    await page.waitForSelector('[data-defects-box]');
    await page.click('[data-defects-box] [data-raise-defect]');
    await page.waitForSelector('[data-linked-defect="DEF-001"]');
    await shot('2c-raised.png');
    await openTab('defects');
    await page.waitForSelector('tr[data-defect="DEF-001"]');
    const row = await page.textContent('tr[data-defect="DEF-001"]');
    expect(row).toContain('TC-0001: Lockout after 5 failures failed');
    expect(row).toContain('RUN-001');
  });
});

describe('defect workflow (human only)', () => {
  it('Rejected/Closed need a note; the defect walks to Closed and the history shows each step', async () => {
    await page.click('tr[data-defect="DEF-001"]');
    await page.waitForSelector('[data-defect-detail="DEF-001"]');
    expect(await page.isDisabled('[data-defect-to="rejected"]')).toBe(true);
    for (const to of ['open', 'in_progress', 'fixed', 'retest']) {
      await page.click(`[data-defect-to="${to}"]`);
      await page.waitForSelector(`[data-defect-to="${to === 'open' ? 'in_progress' : to === 'in_progress' ? 'fixed' : to === 'fixed' ? 'retest' : 'closed'}"]`);
    }
    expect(await page.isDisabled('[data-defect-to="closed"]')).toBe(true);
    await page.fill('[data-defect-note]', 'Verified in build 1.0.4');
    await page.click('[data-defect-to="closed"]');
    await page.waitForSelector('tr[data-defect="DEF-001"] [data-defect-status="closed"]');
    expect(await page.textContent('[data-defect-detail="DEF-001"]')).toContain('Verified in build 1.0.4');
    await shot('2c-defect.png');
  });
});

describe('exploratory session', () => {
  it('plan, start, add a bug note, raise a defect from it, complete', async () => {
    await openTab('exploratory');
    await page.fill('[data-charter]', 'Explore checkout with unusual quantities');
    await page.click('[data-create-session]');
    await page.waitForSelector('[data-session-detail="EXP-001"]');
    await page.click('[data-start-session]');
    await page.waitForSelector('[data-note-form]');
    await page.selectOption('[data-note-kind]', 'bug');
    await page.fill('[data-note-text]', 'Total shows NaN with quantity 0');
    await page.click('[data-add-note]');
    await page.waitForSelector('[data-note="bug"]');
    await page.click('[data-raise-defect]');
    await page.waitForSelector('[data-note="bug"] .pill.soon:has-text("DEF-002")');
    await page.fill('[data-session-summary]', 'One bug found in checkout');
    await page.click('[data-complete-session]');
    await page.waitForSelector('[data-session-detail="EXP-001"]:has-text("Summary: One bug found")');
    await shot('2c-exploratory.png');
  });
});

describe('task board', () => {
  it('adds a task, blocking needs a reason, and a person completes it', async () => {
    await page.goto(env.origin + '/#/tasks');
    await page.waitForSelector('[data-page="manual-qa"] [data-project-select]');
    await page.selectOption('[data-project-select]', { label: 'Payments Web' });
    await page.waitForSelector('[data-panel="tasks"]');
    await page.fill('[data-task-title]', 'Write checkout regression tests');
    await page.click('[data-create-task]');
    await page.waitForSelector('[data-stage="backlog"] [data-task="TSK-001"]');
    await page.waitForSelector('[data-task-detail="TSK-001"]');
    expect(await page.isDisabled('[data-move-to="blocked"]')).toBe(true);
    await page.fill('[data-task-note]', 'Waiting for test data');
    await page.click('[data-move-to="blocked"]');
    await page.waitForSelector('[data-stage="blocked"] [data-task="TSK-001"]');
    await page.fill('[data-task-note]', '');
    await page.click('[data-move-to="completed"]');
    await page.waitForSelector('[data-stage="completed"] [data-task="TSK-001"]');
    await shot('2c-board.png');
  });
});

describe('Overview KPI and layout', () => {
  it('"Open defects" counts the one still open (DEF-002) with its formula', async () => {
    await page.goto(env.origin + '/#/');
    await page.waitForFunction(() => document.querySelector('[data-kpi="defects"]')?.getAttribute('data-nodata') === 'false');
    expect(await kpi('defects')).toMatchObject({ nodata: 'false', value: '1' });
    expect(await page.getAttribute('[data-kpi="defects"]', 'title')).toContain('1 of 2 reported');
  });

  it('every new tab has spaced cards and no horizontal scroll at 360 px', async () => {
    for (const tab of ['defects', 'exploratory', 'tasks']) {
      await openTab(tab);
      const gaps = await page.evaluate((t) => {
        const kids = [...document.querySelector(`[data-panel="${t}"]`)!.children] as HTMLElement[];
        return kids.slice(1).map((k, i) => k.getBoundingClientRect().top - kids[i]!.getBoundingClientRect().bottom);
      }, tab);
      for (const g of gaps) expect(g, `${tab} gap`).toBeGreaterThanOrEqual(10);
    }
    const ctx = await browser.newContext({ viewport: { width: 360, height: 800 } });
    const p = await ctx.newPage();
    await p.goto(env.createLaunchUrl());
    await p.waitForSelector('[data-page="overview"]');
    for (const tab of ['defects', 'exploratory', 'tasks']) {
      await openTab(tab, p);
      expect(await p.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth), `${tab} overflow`).toBeLessThanOrEqual(0);
    }
    await shot('2c-mobile.png', p);
    await ctx.close();
  });
});
