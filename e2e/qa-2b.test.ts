/**
 * Pass 2B acceptance in a real browser (headless Edge): test runs, manual execution with notes,
 * evidence (note + screenshot), human-only PASSED, real Overview KPIs, responsive layout.
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
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('screenshot-bytes')]);

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
  for (const title of ['Sign in works', 'Lockout after 5 failures', 'Reset password']) {
    const t = await api('POST', `/api/projects/${pid}/test-cases`, { title, steps: ['Open the page', 'Do it'], expectedResult: 'It works' });
    await api('POST', `/api/test-cases/${t.id}/transition`, { to: 'in_review' });
    await api('POST', `/api/test-cases/${t.id}/transition`, { to: 'approved', note: 'ok' });
  }
  await api('POST', `/api/projects/${pid}/test-cases`, { title: 'Still a draft', steps: ['a'], expectedResult: 'b' });
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

const openExecution = async (p: Page = page) => {
  await p.goto(env.origin + '/#/manual');
  await p.waitForSelector('[data-page="manual-qa"] [data-project-select]');
  await p.selectOption('[data-project-select]', { label: 'Payments Web' });
  await p.click('button[data-tab="execution"]');
  await p.waitForSelector('[data-panel="execution"]');
};
const kpi = async (id: string) => ({
  value: (await page.textContent(`[data-kpi="${id}"] .kpi-value`))?.trim(),
  nodata: await page.getAttribute(`[data-kpi="${id}"]`, 'data-nodata'),
});

describe('before any execution', () => {
  it('result KPIs say "No data yet" and pending is the approved count', async () => {
    await page.goto(env.origin + '/#/');
    await page.waitForSelector('[data-kpi="passed"]');
    expect(await kpi('passed')).toMatchObject({ nodata: 'true', value: 'No data yet' });
    expect(await kpi('failed')).toMatchObject({ nodata: 'true' });
    expect(await kpi('pending')).toMatchObject({ nodata: 'false', value: '3' });
  });
});

describe('manual execution', () => {
  it('creates a run holding only the approved test cases', async () => {
    await openExecution();
    await page.fill('[data-run-name]', 'Sprint 1 regression');
    await page.click('[data-create-run]');
    await page.waitForSelector('[data-run="RUN-001"]');
    expect(await page.locator('tr[data-exec]').count()).toBe(3);
    expect(await page.textContent('[data-run="RUN-001"]')).not.toContain('Still a draft');
    await shot('2b-run.png');
  });

  it('Failed needs a note; with a note it is recorded and the history shows it', async () => {
    await page.click('tr[data-exec="TC-0002"]');
    await page.waitForSelector('[data-execution-detail="TC-0002"]');
    expect(await page.isDisabled('[data-set-result="failed"]')).toBe(true);
    await page.fill('[data-result-note]', 'Account was not locked after the 5th attempt');
    await page.click('[data-set-result="failed"]');
    await page.waitForSelector('tr[data-exec="TC-0002"] [data-exec-status="failed"]');
    expect(await page.textContent('[data-execution-detail="TC-0002"]')).toContain('Account was not locked');
  });

  it('adds a note and a screenshot as evidence; the file is downloadable and personal data in the note is redacted', async () => {
    await page.fill('[data-evidence-body]', 'Saw banner for jane.doe@example.com');
    await page.click('[data-add-evidence-note]');
    await page.waitForSelector('[data-evidence="note"]');
    expect(await page.textContent('[data-evidence="note"]')).not.toContain('jane.doe@example.com');
    await page.setInputFiles('[data-evidence-file]', { name: 'lockout.png', mimeType: 'image/png', buffer: PNG });
    await page.waitForSelector('[data-evidence="file"]');
    const href = await page.getAttribute('[data-evidence="file"] a', 'href');
    const res = await page.evaluate(async (u) => {
      const r = await fetch(u!, { credentials: 'same-origin' });
      return { status: r.status, disposition: r.headers.get('content-disposition'), len: (await r.arrayBuffer()).byteLength };
    }, href);
    expect(res).toMatchObject({ status: 200, len: PNG.length });
    expect(res.disposition).toMatch(/^attachment/);
    await shot('2b-evidence.png');
  });

  it('a person can mark tests Passed; the run board and counts update', async () => {
    await page.click('tr[data-exec="TC-0001"]');
    await page.waitForSelector('[data-execution-detail="TC-0001"]');
    await page.click('[data-execution-detail="TC-0001"] [data-set-result="passed"]');
    await page.waitForSelector('tr[data-exec="TC-0001"] [data-exec-status="passed"]');
    expect(await page.textContent('[data-run="RUN-001"]')).toContain('1 passed, 1 failed');
  });

  it('the Test cases tab now shows the latest result', async () => {
    await page.click('button[data-tab="test-cases"]');
    await page.waitForSelector('[data-panel="test-cases"]');
    const row = page.locator('tr', { hasText: 'Sign in works' }).first();
    expect(await row.textContent()).toContain('PASSED');
  });

  it('closing the run locks it', async () => {
    await openExecution();
    await page.click('[data-run-open="RUN-001"]');
    await page.click('[data-close-run]');
    await page.waitForSelector('[data-run="RUN-001"] .pill:has-text("closed")');
    await page.click('tr[data-exec="TC-0003"]');
    await page.waitForSelector('[data-execution-detail="TC-0003"]');
    expect(await page.locator('[data-set-result]').count()).toBe(0);
    expect(await page.textContent('[data-execution-detail="TC-0003"]')).toContain('closed');
  });
});

describe('Overview KPIs become real, with formulas', () => {
  it('shows passed, failed, pending from the recorded results only', async () => {
    await page.goto(env.origin + '/#/');
    await page.waitForSelector('[data-kpi="passed"]');
    await page.waitForFunction(() => document.querySelector('[data-kpi="passed"]')?.getAttribute('data-nodata') === 'false');
    expect(await kpi('passed')).toMatchObject({ nodata: 'false', value: '1' });
    expect(await kpi('failed')).toMatchObject({ nodata: 'false', value: '1' });
    expect(await kpi('blocked')).toMatchObject({ nodata: 'false', value: '0' });
    expect(await kpi('pending')).toMatchObject({ nodata: 'false', value: '1' });
    const how = await page.getAttribute('[data-kpi="passed"]', 'title');
    expect(how).toContain('of 3 approved');
    expect(how).toContain('passed / (passed + failed + blocked)');
    await shot('2b-overview.png');
  });
});

describe('requirement picker layout (regression)', () => {
  it('each checkbox sits on the same line as its requirement text', async () => {
    await api('POST', `/api/projects/${pid}/requirements`, { ref: 'AC-01', title: 'Given a guest on /login, when they sign up with a long list of details, then an account is created and a welcome message is shown' });
    await page.goto(env.origin + '/#/manual');
    await page.waitForSelector('[data-page="manual-qa"] [data-project-select]');
    await page.selectOption('[data-project-select]', { label: 'Payments Web' });
    await page.click('button[data-tab="test-cases"]');
    await page.click('button.tab:has-text("New test case")');
    const row = page.locator('.req-picker label.check').first();
    await row.waitFor();
    const box = await row.locator('input[type="checkbox"]').boundingBox();
    const text = await row.locator('strong').boundingBox();
    expect(Math.abs(box!.y - text!.y)).toBeLessThan(12);
    expect(box!.x).toBeLessThan(text!.x);
    await shot('2b-picker.png');
  });
});

describe('spacing between cards in every Manual QA tab (regression)', () => {
  it('sibling cards and tiles inside a tab are separated, never touching', async () => {
    for (const tab of ['requirements', 'test-cases', 'execution', 'traceability']) {
      await page.goto(env.origin + '/#/manual');
      await page.waitForSelector('[data-page="manual-qa"] [data-project-select]');
      await page.selectOption('[data-project-select]', { label: 'Payments Web' });
      await page.click(`button[data-tab="${tab}"]`);
      await page.waitForSelector(`[data-panel="${tab}"]`);
      const gaps = await page.evaluate((t) => {
        const kids = [...document.querySelector(`[data-panel="${t}"]`)!.children] as HTMLElement[];
        return kids.slice(1).map((k, i) => k.getBoundingClientRect().top - kids[i]!.getBoundingClientRect().bottom);
      }, tab);
      for (const g of gaps) expect(g, `${tab}: gap between sections`).toBeGreaterThanOrEqual(10);
    }
  });
});

describe('responsive', () => {
  it('the execution board has no horizontal scroll at 360 px', async () => {
    const ctx = await browser.newContext({ viewport: { width: 360, height: 800 } });
    const p = await ctx.newPage();
    await p.goto(env.createLaunchUrl());
    await p.waitForSelector('[data-page="overview"]');
    await openExecution(p);
    await p.click('[data-run-open="RUN-001"]');
    await p.waitForSelector('[data-run="RUN-001"]');
    const overflow = await p.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);
    await shot('2b-mobile.png', p);
    await ctx.close();
  });
});
