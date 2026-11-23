/**
 * Agents page (P1) in a real browser (headless Edge): the roster, renaming with unique names, house rules, reset,
 * and that neither the hook token nor the agent token can change an agent. Isolated database.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { ingest } from '../apps/server/src/collector.ts';
import { chromium, type Browser, type Page } from 'playwright-core';
import { readAgentToken } from '../apps/server/src/dataDir.ts';
import { hookHeaders, makeEnv, uiHeaders, type TestEnv } from '../apps/server/test/helpers.ts';

const ROOT = path.resolve(__dirname, '..');
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';

let env: TestEnv;
let browser: Browser;
let page: Page;
let cookie: string;
let launches: Array<{ run?: { configPath: string; runId: string } }>;

const api = async (method: string, url: string, payload?: unknown) => {
  const r = await env.app.inject({ method: method as 'GET', url, headers: { ...uiHeaders(env), cookie }, payload: payload as object });
  return { status: r.statusCode, body: r.body ? r.json() : null };
};
const card = (id: string) => `[data-playbook="${id}"]`;

beforeAll(async () => {
  expect(fs.existsSync(path.join(ROOT, 'apps/web/dist/index.html')), 'run `npm run build:web` first').toBe(true);
  launches = [];
  env = await makeEnv({ listen: true, auth: true, webDist: path.join(ROOT, 'apps/web/dist'), launchClaude: (_cwd, run) => launches.push({ run }) });
  cookie = `qavo_session=${env.auth.issueSession()}`;
  browser = await chromium.launch({ executablePath: EDGE, headless: true });
  page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
  await page.goto(env.createLaunchUrl());
  await page.waitForSelector('[data-page="overview"]');
  await page.goto(env.origin + '/#/team');
  await page.waitForSelector('[data-page="team"] [data-playbook]');
});
afterAll(async () => {
  await browser?.close();
  await env.cleanup();
});

describe('Agents page', () => {
  it('shows the roster in the sidebar and page, with writer/reviewer pairs and no way to widen tools', async () => {
    expect(await page.locator('[data-playbook]').count()).toBe(9);
    expect(await page.locator('nav a', { hasText: 'Team' }).count()).toBe(1);
    expect(await page.textContent(`${card('case_writer')} [data-pb-title]`)).toBe('Quinn');
    expect(await page.textContent(`${card('case_writer')} [data-pb-reviewer]`)).toMatch(/Rhea \(Test Case Reviewer\)/);
    expect(await page.textContent(`${card('case_reviewer')} [data-pb-tools]`)).not.toMatch(/qa_create_test_case_draft/);
    expect(await page.textContent(`${card('case_writer')} [data-pb-tools]`)).toMatch(/qa_create_test_case_draft/);
    expect(await page.textContent(`${card('automation_writer')}`)).toMatch(/Arrives in Pass 3/);
    expect(await page.locator('[data-playbook] [data-pb-tools-edit], [data-playbook] input[name="tools"]').count()).toBe(0);
  });

  it('renames an agent, refuses a duplicate name, and resets', async () => {
    const q = card('case_writer');
    await page.fill(`${q} [data-pb-name]`, 'Nova');
    await page.fill(`${q} [data-pb-rules]`, 'Always add a negative case.');
    await page.click(`${q} [data-pb-save]`);
    await page.waitForSelector(`${q}[data-agent-name="Nova"]`);
    expect((await api('GET', '/api/playbooks')).body.find((p: { id: string }) => p.id === 'case_writer')).toMatchObject({ agentName: 'Nova', houseRules: 'Always add a negative case.' });

    await page.fill(`${q} [data-pb-name]`, 'rhea');
    await page.click(`${q} [data-pb-save]`);
    await page.waitForSelector(`${q} .error`);
    expect(await page.textContent(`${q} .error`)).toMatch(/name_taken/);
    expect((await api('GET', '/api/playbooks')).body.find((p: { id: string }) => p.id === 'case_writer').agentName).toBe('Nova');

    await page.click(`${q} [data-pb-reset]`);
    await page.waitForSelector(`${q}[data-agent-name="Quinn"]`);
  });

  it('only the signed-in person can change an agent (not the hook token, the agent token, or a request without the cookie)', async () => {
    const nameNow = async () => (await api('GET', '/api/playbooks')).body.find((p: { id: string }) => p.id === 'case_writer').agentName as string;
    const attempt = (headers: Record<string, string>) =>
      env.app.inject({ method: 'PATCH', url: '/api/playbooks/case_writer', headers: { ...headers, 'content-type': 'application/json' }, payload: { agentName: 'Evil' } });
    expect((await attempt(hookHeaders(env))).statusCode).toBeGreaterThanOrEqual(400);
    expect((await attempt({ host: env.host, 'x-qavo-agent-token': readAgentToken(env.paths) })).statusCode).toBeGreaterThanOrEqual(400);
    expect((await attempt({ ...uiHeaders(env) })).statusCode).toBe(401); // no session cookie
    expect(await nameNow()).toBe('Quinn'); // none of the refused attempts changed anything
    expect((await api('PATCH', '/api/playbooks/case_writer', { agentName: 'Nova2', tools: ['qa_approve'] })).status).toBe(400); // tools can never be edited
    expect(await nameNow()).toBe('Quinn');
    expect((await api('PATCH', '/api/playbooks/case_writer', { agentName: 'Nova2' })).status).toBe(200); // the signed-in person can
    expect(await nameNow()).toBe('Nova2');
    await api('POST', '/api/playbooks/case_writer/reset');
  });

  it('has no horizontal scroll at phone width', async () => {
    await page.setViewportSize({ width: 360, height: 800 });
    await page.reload();
    await page.waitForSelector('[data-playbook]');
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
    await page.setViewportSize({ width: 1280, height: 900 });
  });
});

describe('Run this playbook, runs, attribution and the office robot', () => {
  let pid: string;
  it('launches Quinn for a project from the page, lists the run, and stops it', async () => {
    const dir = path.join(env.root, 'ShopWeb');
    fs.mkdirSync(dir);
    pid = (await api('POST', '/api/projects', { alias: 'Shop Web', path: dir })).body.project.id;
    await api('PUT', '/api/settings/agent', { enabled: true, confirm: true });
    await page.goto(env.origin + '/#/team');
    await page.reload();
    await page.waitForSelector('[data-playbook]');
    expect(await page.locator(`${card('automation_writer')} [data-pb-run]`).count()).toBe(0); // not available yet: no Run button
    const q = card('case_writer');
    expect(await page.isDisabled(`${q} [data-pb-run]`)).toBe(true); // choose a project first
    await page.selectOption(`${q} [data-pb-project]`, { label: 'Shop Web' });
    page.once('dialog', (d) => void d.accept());
    await page.click(`${q} [data-pb-run]`);
    await page.waitForSelector(`${q} .ok`);
    expect(launches).toHaveLength(1);
    await page.waitForSelector('[data-run][data-run-status="active"]');
    expect(await page.textContent('[data-runs]')).toMatch(/Quinn.*Test Case Writer.*Shop Web/s);
    await page.click('[data-run-stop]');
    await page.waitForSelector('[data-run][data-run-status="revoked"]');
    expect(fs.existsSync(launches[0]!.run!.configPath)).toBe(false);
  });

  it('shows who drafted a case, and the agent’s own named robot in the office', async () => {
    await api('POST', `/api/projects/${pid}/launch-claude`, { confirm: true, playbookId: 'case_writer' });
    const run = launches[launches.length - 1]!.run!;
    const token = (JSON.parse(fs.readFileSync(run.configPath, 'utf8')) as { mcpServers: { 'qa-office': { env: { QAVO_RUN_TOKEN: string } } } }).mcpServers['qa-office'].env.QAVO_RUN_TOKEN;
    const r = await env.app.inject({ method: 'POST', url: '/api/agent/tools/qa_create_test_case_draft', headers: { host: env.host, 'content-type': 'application/json', 'x-qavo-run-token': token }, payload: { project: 'Shop Web', title: 'Guest registers', steps: ['Open', 'Submit'], expectedResult: 'Account created' } });
    expect(r.statusCode).toBe(200);
    ingest(env.db, { v: 1, eventId: crypto.randomUUID(), ts: new Date().toISOString(), sessionId: 's-quinn', event: 'SessionStart', source: 'startup', projectId: pid, folderKeys: [], runId: run.runId }, env.broadcast);

    await page.goto(env.origin + '/#/manual');
    await page.waitForSelector('[data-page="manual-qa"] [data-project-select]');
    await page.selectOption('[data-project-select]', { label: 'Shop Web' });
    await page.click('button[data-tab="test-cases"]');
    await page.waitForSelector('[data-tc-drafted-by="Quinn"]');
    expect(await page.textContent('[data-tc-drafted-by="Quinn"]')).toMatch(/drafted by Quinn/);

    await page.goto(env.origin + '/#/team');
    await page.waitForFunction(() => Array.from(document.querySelectorAll('[data-robot-editor] input')).some((i) => (i as HTMLInputElement).value === 'Quinn'));
    expect((await api('GET', '/api/robots')).body.find((x: { name: string }) => x.name === 'Quinn')).toMatchObject({ robotType: 'manual_tester' });
  });
});

describe('Team page: agents and robots in one place', () => {
  const robotsApi = async () => (await api('GET', '/api/robots')).body as Array<{ id: string; name: string; playbookId: string | null; robotType: string }>;
  const shopId = () => (env.db.prepare("SELECT id FROM projects WHERE alias = 'Shop Web'").get() as { id: string }).id;
  const sendEvent = (sessionId: string, event: string, extra: Record<string, unknown> = {}) =>
    ingest(env.db, { v: 1, eventId: crypto.randomUUID(), ts: new Date().toISOString(), sessionId, event, projectId: shopId(), folderKeys: [], ...extra }, env.broadcast);

  it('shows Team in the sidebar instead of Robots and Agents, and the old addresses lead to it', async () => {
    await page.goto(env.origin + '/#/team');
    await page.waitForSelector('[data-page="team"] [data-playbook]');
    const labels = await page.locator('nav a').allTextContents();
    expect(labels.map((l) => l.trim())).toContain('Team');
    expect(labels.map((l) => l.trim())).not.toContain('Robots');
    expect(labels.map((l) => l.trim())).not.toContain('Agents');
    for (const old of ['#/robots', '#/agents']) {
      await page.goto(env.origin + '/#/manual');
      await page.evaluate((h) => (location.hash = h), old);
      await page.waitForSelector('[data-page="team"] [data-playbook]');
      expect(await page.evaluate(() => location.hash)).toBe('#/team');
    }
  });

  it('shows an agent’s live state from its real session, and "not running" once it ends', async () => {
    await page.goto(env.origin + '/#/team');
    await page.waitForSelector(`${card('case_writer')}`);
    await page.waitForSelector(`${card('case_writer')} [data-pb-live="running"]`);
    expect(await page.textContent(`${card('case_writer')} [data-pb-session]`)).toMatch(/Working in Shop Web/);
    expect(await page.locator(`${card('case_reviewer')} [data-pb-live="idle"]`).count()).toBe(1); // Rhea never ran
    expect(await page.textContent(`${card('case_reviewer')} [data-pb-live]`)).toMatch(/Not running/);
    sendEvent('s-quinn', 'SessionEnd', { reason: 'other', runId: launches[launches.length - 1]!.run!.runId });
    await page.waitForSelector(`${card('case_writer')} [data-pb-live="idle"]`);
    expect(await page.textContent(`${card('case_writer')} [data-pb-live]`)).toMatch(/Not running/);
  });

  it('keeps an agent’s robot name tied to the agent, but lets its look be customised', async () => {
    const quinnBot = (await robotsApi()).find((r) => r.name === 'Quinn')!;
    expect(quinnBot.playbookId).toBe('case_writer');
    await page.goto(env.origin + '/#/team');
    await page.waitForSelector(`${card('case_writer')} [data-pb-look] [data-robot-name]`, { state: 'attached' });
    expect(await page.isDisabled(`${card('case_writer')} [data-pb-look] [data-robot-name]`)).toBe(true);
    const rename = await api('PATCH', `/api/robots/${quinnBot.id}`, { name: 'Impostor' });
    expect(rename.status).toBe(409);
    expect(rename.body.error).toBe('name_follows_agent');
    const look = await api('PATCH', `/api/robots/${quinnBot.id}`, { palette: { primary: '#112233', accent: '#445566' } });
    expect(look.status).toBe(200);
    expect(look.body).toMatchObject({ name: 'Quinn', palette: { primary: '#112233' } });
    // renaming the agent renames its robot the next time it runs (covered by the server tests); here the card follows live
    expect((await robotsApi()).find((r) => r.id === quinnBot.id)!.name).toBe('Quinn');
  });

  it('lists the robots of ordinary sessions separately, where their name stays editable', async () => {
    sendEvent('s-plain', 'SessionStart', { source: 'startup' });
    await page.goto(env.origin + '/#/team');
    await page.waitForSelector('[data-others]');
    const plain = (await robotsApi()).find((r) => r.name.startsWith('Unit-'))!;
    expect(plain.playbookId).toBeNull();
    await page.waitForSelector(`[data-robot-editor="${plain.id}"]`);
    expect(await page.locator(`[data-playbook] [data-robot-editor="${plain.id}"]`).count()).toBe(0); // not inside an agent card
    expect(await page.isDisabled(`[data-robot-editor="${plain.id}"] [data-robot-name]`)).toBe(false);
    expect((await api('PATCH', `/api/robots/${plain.id}`, { name: 'Scout' })).status).toBe(200);
  });

  it('has no horizontal scroll at phone width', async () => {
    await page.setViewportSize({ width: 360, height: 800 });
    await page.goto(env.origin + '/#/team');
    await page.reload();
    await page.waitForSelector('[data-playbook]');
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
    await page.setViewportSize({ width: 1280, height: 900 });
  });
});
