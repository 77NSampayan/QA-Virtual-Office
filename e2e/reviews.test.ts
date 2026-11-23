/**
 * Reviewer-agent recommendations (P3) in a real browser (headless Edge): the label in the list, the full review in the
 * detail, the Review filter, "outdated" after an edit, and that only the person can approve. Isolated database.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { chromium, type Browser, type Page } from 'playwright-core';
import { readAgentToken } from '../apps/server/src/dataDir.ts';
import { makeEnv, uiHeaders, type TestEnv } from '../apps/server/test/helpers.ts';

const ROOT = path.resolve(__dirname, '..');
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';

let env: TestEnv;
let browser: Browser;
let page: Page;
let cookie: string;
let pid: string;
let quinn: string;
let rhea: string;
const launches: Array<{ run?: { configPath: string; runId: string } }> = [];

const api = async (method: string, url: string, payload?: unknown) => {
  const r = await env.app.inject({ method: method as 'GET', url, headers: { ...uiHeaders(env), cookie }, payload: payload as object });
  return { status: r.statusCode, body: r.body ? r.json() : null };
};
const agent = async (token: string, name: string, args: unknown) => {
  const r = await env.app.inject({ method: 'POST', url: `/api/agent/tools/${name}`, headers: { host: env.host, 'content-type': 'application/json', 'x-qavo-run-token': token }, payload: args as object });
  return { status: r.statusCode, body: r.body ? r.json() : null };
};
async function launch(playbookId: string) {
  await api('POST', `/api/projects/${pid}/launch-claude`, { confirm: true, playbookId });
  const run = launches[launches.length - 1]!.run!;
  return (JSON.parse(fs.readFileSync(run.configPath, 'utf8')) as { mcpServers: { 'qa-office': { env: { QAVO_RUN_TOKEN: string } } } }).mcpServers['qa-office'].env.QAVO_RUN_TOKEN;
}

beforeAll(async () => {
  expect(fs.existsSync(path.join(ROOT, 'apps/web/dist/index.html')), 'run `npm run build:web` first').toBe(true);
  env = await makeEnv({ listen: true, auth: true, webDist: path.join(ROOT, 'apps/web/dist'), launchClaude: (_c, run) => launches.push({ run }) });
  cookie = `qavo_session=${env.auth.issueSession()}`;
  const dir = path.join(env.root, 'ShopWeb');
  fs.mkdirSync(dir);
  pid = (await api('POST', '/api/projects', { alias: 'Shop Web', path: dir })).body.project.id;
  await api('PUT', '/api/settings/agent', { enabled: true, confirm: true });
  quinn = await launch('case_writer');
  rhea = await launch('case_reviewer');
  for (const title of ['Guest registers', 'Guest logs in', 'Guest logs out']) {
    await agent(quinn, 'qa_create_test_case_draft', { project: 'Shop Web', title, steps: ['Open', 'Submit'], expectedResult: 'It works' });
  }
  await agent(rhea, 'qa_review_test_case', { project: 'Shop Web', code: 'TC-0001', verdict: 'recommend_approve', notes: 'Clear steps and a checkable result.' });
  await agent(rhea, 'qa_review_test_case', { project: 'Shop Web', code: 'TC-0002', verdict: 'changes_requested', notes: 'Add the wrong-password case.' });
  browser = await chromium.launch({ executablePath: EDGE, headless: true });
  page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
  await page.goto(env.createLaunchUrl());
  await page.waitForSelector('[data-page="overview"]');
  await page.goto(env.origin + '/#/manual');
  await page.waitForSelector('[data-page="manual-qa"] [data-project-select]');
  await page.selectOption('[data-project-select]', { label: 'Shop Web' });
  await page.click('button[data-tab="test-cases"]');
  await page.waitForSelector('[data-panel="test-cases"] tr[data-tc]');
});
afterAll(async () => {
  await browser?.close();
  await env.cleanup();
});

describe('reviewer recommendations in the test-case list', () => {
  it('shows who reviewed and what they recommend, in the list and in full in the detail', async () => {
    expect(await page.textContent('tr[data-tc="TC-0001"] [data-tc-review]')).toMatch(/Rhea recommends approval/);
    expect(await page.textContent('tr[data-tc="TC-0002"] [data-tc-review]')).toMatch(/Rhea requests changes/);
    expect(await page.locator('tr[data-tc="TC-0003"] [data-tc-review]').count()).toBe(0); // not reviewed
    expect(await page.textContent('tr[data-tc="TC-0001"] [data-tc-drafted-by]')).toMatch(/drafted by Quinn/);
    await page.click('tr[data-tc="TC-0002"]');
    await page.waitForSelector('[data-tc-detail="TC-0002"] [data-tc-review-detail="changes_requested"]');
    const box = (await page.textContent('[data-tc-review-detail]')) ?? '';
    expect(box).toMatch(/Rhea.*reviewer agent.*requests changes/s);
    expect(box).toContain('Add the wrong-password case.');
    expect(box).toMatch(/recommendation only/i);
  });

  it('filters by the latest review', async () => {
    const codes = async () => (await page.locator('tr[data-tc]').evaluateAll((rows) => rows.map((r) => r.getAttribute('data-tc')))).sort();
    await page.selectOption('select[aria-label="Review filter"]', 'recommend_approve');
    await page.waitForFunction(() => document.querySelectorAll('tr[data-tc]').length === 1);
    expect(await codes()).toEqual(['TC-0001']);
    await page.selectOption('select[aria-label="Review filter"]', 'unreviewed');
    await page.waitForFunction(() => document.querySelectorAll('tr[data-tc]').length === 1);
    expect(await codes()).toEqual(['TC-0003']);
    await page.selectOption('select[aria-label="Review filter"]', '');
    await page.waitForFunction(() => document.querySelectorAll('tr[data-tc]').length === 3);
  });

  it('an edit makes the review outdated, and it is shown as such', async () => {
    await agent(quinn, 'qa_update_test_case_draft', { project: 'Shop Web', code: 'TC-0001', steps: ['Open', 'Submit', 'Delete the account'] });
    await page.waitForSelector('tr[data-tc="TC-0001"] [data-tc-review="outdated"]');
    expect(await page.textContent('tr[data-tc="TC-0001"] [data-tc-review]')).toMatch(/outdated/);
    await page.selectOption('select[aria-label="Review filter"]', 'outdated');
    await page.waitForFunction(() => document.querySelectorAll('tr[data-tc]').length === 1);
    await page.selectOption('select[aria-label="Review filter"]', '');
  });

  it('shows the writer agent’s reply under the review', async () => {
    const note = 'Added the cleanup step; negatives live in TC-0002.';
    const r = await agent(quinn, 'qa_update_test_case_draft', { project: 'Shop Web', code: 'TC-0001', replyToReviewer: note });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    if (!(await page.$('[data-tc-detail="TC-0001"]'))) await page.click('tr[data-tc="TC-0001"]');
    await page.waitForSelector('[data-tc-detail="TC-0001"] [data-tc-reply]');
    const text = (await page.textContent('[data-tc-detail="TC-0001"] [data-tc-reply]')) ?? '';
    expect(text).toMatch(/Quinn.*writer agent.*replied/s);
    expect(text).toContain(note);
    await page.click('tr[data-tc="TC-0001"]'); // close it again
  });

  it('only the person approves: the reviewer’s recommendation changes no status, and the person can approve regardless', async () => {
    const statusOf = async (code: string) => ((await api('GET', `/api/projects/${pid}/test-cases`)).body as Array<{ code: string; status: string }>).find((t) => t.code === code)!.status;
    expect(await statusOf('TC-0002')).toBe('draft'); // "requests changes" did not reject it, nothing was approved
    if (!(await page.$('[data-tc-detail="TC-0002"]'))) await page.click('tr[data-tc="TC-0002"]'); // a second click would close it
    await page.waitForSelector('[data-tc-detail="TC-0002"] [data-transition="in_review"]');
    await page.click('[data-tc-detail="TC-0002"] [data-transition="in_review"]');
    await page.waitForSelector('[data-tc-detail="TC-0002"] [data-transition="approved"]');
    await page.click('[data-tc-detail="TC-0002"] [data-transition="approved"]');
    await page.waitForFunction(() => document.querySelector('tr[data-tc="TC-0002"] [data-tc-status="approved"]'));
    expect(await statusOf('TC-0002')).toBe('approved');
  });

  it('lets the person hand an old, unnamed agent draft to Quinn, after which she may fix it', async () => {
    const shared = await env.app.inject({ method: 'POST', url: '/api/agent/tools/qa_create_test_case_draft', headers: { host: env.host, 'content-type': 'application/json', 'x-qavo-agent-token': readAgentToken(env.paths) }, payload: { project: 'Shop Web', title: 'Old unnamed draft', steps: ['Open', 'Submit'], expectedResult: 'Works' } });
    expect(shared.statusCode).toBe(200);
    await agent(rhea, 'qa_review_test_case', { project: 'Shop Web', code: 'TC-0004', verdict: 'changes_requested', notes: 'Add the wrong-password case.' });
    const blocked = await agent(quinn, 'qa_update_test_case_draft', { project: 'Shop Web', code: 'TC-0004', title: 'Quinn edit' });
    expect(blocked.body.error).toBe('not_your_draft');
    await page.waitForSelector('tr[data-tc="TC-0004"]');
    await page.click('tr[data-tc="TC-0004"]');
    await page.waitForSelector('[data-tc-detail="TC-0004"] [data-tc-handover]');
    expect(await page.textContent('[data-tc-handover]')).toMatch(/before agents had names/);
    await page.click('[data-handover="case_writer"]');
    await page.waitForSelector('tr[data-tc="TC-0004"] [data-tc-drafted-by="Quinn"]');
    expect(await page.locator('[data-tc-handover]').count()).toBe(0); // the button is gone once handed over
    const ok = await agent(quinn, 'qa_update_test_case_draft', { project: 'Shop Web', code: 'TC-0004', steps: ['Open', 'Enter a wrong password', 'Submit'], replyToReviewer: 'Added the wrong-password step.' });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    await page.click('tr[data-tc="TC-0004"]'); // close it again
  });

  it('has no horizontal scroll at phone width', async () => {
    await page.setViewportSize({ width: 360, height: 800 });
    await page.reload();
    await page.waitForSelector('[data-page="manual-qa"] [data-project-select]');
    await page.selectOption('[data-project-select]', { label: 'Shop Web' });
    await page.click('button[data-tab="test-cases"]');
    await page.waitForSelector('tr[data-tc]');
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
    await page.setViewportSize({ width: 1280, height: 900 });
  });
});
