/** Pass 3 A4 (headless Edge): script drafts from the Automation Writer, reviewed by another agent, decided by a person. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { chromium, type Browser, type Page } from 'playwright-core';
import * as qa from '../apps/server/src/qa.ts';
import { makeEnv, uiHeaders, type TestEnv } from '../apps/server/test/helpers.ts';

const ROOT = path.resolve(__dirname, '..');
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';

let env: TestEnv;
let browser: Browser;
let page: Page;
let pid: string;
let cookie: string;
let launches: Array<{ run?: { configPath: string; runId: string } }>;

const launch = async (playbookId: string) => {
  const r = await env.app.inject({ method: 'POST', url: `/api/projects/${pid}/launch-claude`, headers: { ...uiHeaders(env), cookie }, payload: { confirm: true, playbookId } });
  expect(r.statusCode, r.body).toBe(200);
  const run = launches[launches.length - 1]!.run!;
  return (JSON.parse(fs.readFileSync(run.configPath, 'utf8')) as { mcpServers: { 'qa-office': { env: { QAVO_RUN_TOKEN: string } } } }).mcpServers['qa-office'].env.QAVO_RUN_TOKEN;
};
const tool = async (token: string, name: string, args: unknown) => {
  const r = await env.app.inject({ method: 'POST', url: `/api/agent/tools/${name}`, headers: { host: env.host, 'content-type': 'application/json', 'x-qavo-run-token': token }, payload: args as object });
  expect(r.statusCode, r.body).toBe(200);
};

beforeAll(async () => {
  expect(fs.existsSync(path.join(ROOT, 'apps/web/dist/index.html')), 'run `npm run build:web` first').toBe(true);
  launches = [];
  env = await makeEnv({ listen: true, auth: true, webDist: path.join(ROOT, 'apps/web/dist'), launchClaude: (_c, run) => launches.push({ run }) });
  cookie = `qavo_session=${env.auth.issueSession()}`;
  const dir = path.join(env.root, 'Shop');
  fs.mkdirSync(dir);
  pid = (await env.app.inject({ method: 'POST', url: '/api/projects', headers: { ...uiHeaders(env), cookie }, payload: { alias: 'Shop', path: dir } })).json().project.id as string;
  await env.app.inject({ method: 'PUT', url: '/api/settings/agent', headers: { ...uiHeaders(env), cookie }, payload: { enabled: true, confirm: true } });
  const tc = qa.createTestCase(env.db, pid, { title: 'Add to cart', steps: ['a'], expectedResult: 'b' }, 'human');
  env.db.prepare("UPDATE test_cases SET status = 'approved', approved_by = 'human', approved_at = ? WHERE id = ?").run(new Date().toISOString(), tc.id);
  const axel = await launch('automation_writer');
  const vera = await launch('automation_reviewer');
  await tool(axel, 'qa_create_automation_script', { project: 'Shop', title: 'Add to cart (UI)', framework: 'playwright', testCaseCode: 'TC-0001', content: "test('adds', async ({ page }) => { await page.goto(process.env.BASE_URL!); });", notes: 'npx playwright test' });
  await tool(axel, 'qa_create_automation_script', { project: 'Shop', title: 'Second script', framework: 'playwright', testCaseCode: 'TC-0001', content: 'await page.click("#x");' });
  await tool(vera, 'qa_review_automation_script', { project: 'Shop', code: 'AS-001', verdict: 'recommend_approve', notes: 'Stable and repeatable.' });
  browser = await chromium.launch({ executablePath: EDGE, headless: true });
  page = await (await browser.newContext({ viewport: { width: 1366, height: 768 } })).newPage();
  await page.goto(env.createLaunchUrl());
  await page.waitForSelector('.shell');
});
afterAll(async () => {
  await browser?.close();
  await env.cleanup();
});

describe('script drafts on the Test Automation page', () => {
  it('lists the drafts with who wrote and reviewed them, and shows the text and the review in the drawer', async () => {
    await page.evaluate(() => (location.hash = '#/automation'));
    await page.waitForSelector('[data-script-row="AS-001"]');
    expect(await page.textContent('[data-script-row="AS-001"]')).toMatch(/Axel.*TC-0001.*Draft.*Vera recommends approval/s);
    expect(await page.textContent('[data-script-row="AS-002"]')).toMatch(/not reviewed/);
    await page.click('[data-script-row="AS-001"]');
    await page.waitForSelector('[data-drawer] [data-script-detail="AS-001"]');
    expect(await page.textContent('[data-script-text]')).toContain('page.goto');
    expect(await page.textContent('[data-script-review]')).toMatch(/Vera.*Stable and repeatable/s);
    expect(await page.textContent('[data-drawer]')).toMatch(/Only you can approve or reject/);
    expect(await page.textContent('[data-drawer]')).toMatch(/Nothing here is run and nothing is written into your project/);
    if (process.env.QAVO_E2E_SHOTS) await page.screenshot({ path: path.join(process.env.QAVO_E2E_SHOTS, 'automation-script.png') });
  });

  it('only the person approves: the reviewer’s recommendation does nothing by itself', async () => {
    expect(await page.locator('[data-script-decided]').count()).toBe(0);
    page.once('dialog', (d) => void d.accept());
    await page.click('[data-script-approve]');
    await page.waitForSelector('[data-script-decided]');
    expect(await page.textContent('[data-script-decided]')).toMatch(/Approved by you/);
    expect(await page.locator('[data-script-approve]').count()).toBe(0); // frozen
    await page.click('[data-drawer-close]');
    expect(await page.textContent('[data-script-row="AS-001"]')).toMatch(/Approved/);
  });

  it('rejecting needs a reason', async () => {
    await page.click('[data-script-row="AS-002"]');
    await page.waitForSelector('[data-script-detail="AS-002"]');
    expect(await page.isDisabled('[data-script-reject]')).toBe(true);
    await page.fill('[data-script-reason]', 'Uses a brittle selector');
    await page.click('[data-script-reject]');
    await page.waitForSelector('[data-script-decided]');
    expect(await page.textContent('[data-script-decided]')).toMatch(/Rejected by you.*brittle selector/);
  });

  it('the Team page shows Axel and Vera as runnable now, with their script tools', async () => {
    await page.evaluate(() => (location.hash = '#/team'));
    await page.waitForSelector('[data-roster="automation_writer"]');
    await page.click('[data-roster="automation_writer"]');
    await page.waitForSelector('[data-playbook="automation_writer"] [data-pb-run]');
    expect(await page.textContent('[data-playbook="automation_writer"] [data-pb-tools]')).toMatch(/qa_create_automation_script/);
    expect(await page.textContent('[data-playbook="automation_writer"]')).not.toMatch(/Arrives in Pass 3/);
    await page.click('[data-roster="automation_reviewer"]');
    await page.waitForSelector('[data-playbook="automation_reviewer"]');
    expect(await page.textContent('[data-playbook="automation_reviewer"] [data-pb-tools]')).not.toMatch(/qa_create_automation_script/);
    expect(await page.textContent('[data-playbook="automation_reviewer"] [data-pb-tools]')).toMatch(/qa_review_automation_script/);
  });

  it('has no horizontal scroll at phone width', async () => {
    await page.setViewportSize({ width: 360, height: 800 });
    await page.evaluate(() => (location.hash = '#/automation'));
    await page.reload();
    await page.waitForSelector('[data-script-row="AS-001"]');
    await page.click('[data-script-row="AS-001"]');
    await page.waitForSelector('[data-drawer]');
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
    await page.setViewportSize({ width: 1366, height: 768 });
  });
});
