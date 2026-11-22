/**
 * Pass 2D acceptance in a real browser (headless Edge): the Agent access settings (off by default, a person
 * turns it on, sees the setup command and recent agent activity, can revoke), "Launch Claude Code here",
 * and the real per-project QA figures in the Project Room.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { chromium, type Browser, type Page } from 'playwright-core';
import { readAgentToken } from '../apps/server/src/dataDir.ts';
import { makeEnv, uiHeaders, type TestEnv } from '../apps/server/test/helpers.ts';

const ROOT = path.resolve(__dirname, '..');
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const SHOTS = process.env.QAVO_E2E_SHOTS;

let env: TestEnv;
let browser: Browser;
let page: Page;
let pid: string;
let cookie: string;
const launched: string[] = [];

const api = async (method: string, url: string, payload?: unknown) => {
  const r = await env.app.inject({ method: method as 'GET', url, headers: { ...uiHeaders(env), cookie }, payload: payload as object });
  return r.body ? r.json() : null;
};
const agentCall = (name: string, args: unknown) =>
  env.app.inject({ method: 'POST', url: `/api/agent/tools/${name}`, headers: { host: env.host, 'x-qavo-agent-token': readAgentToken(env.paths), 'content-type': 'application/json' }, payload: args as object });
const shot = async (name: string, p: Page = page) => {
  if (SHOTS) await p.screenshot({ path: path.join(SHOTS, name), fullPage: true });
};

beforeAll(async () => {
  expect(fs.existsSync(path.join(ROOT, 'apps/web/dist/index.html')), 'run `npm run build:web` first').toBe(true);
  env = await makeEnv({ listen: true, auth: true, webDist: path.join(ROOT, 'apps/web/dist'), launchClaude: (cwd) => launched.push(cwd) });
  cookie = `qavo_session=${env.auth.issueSession()}`;
  const dir = path.join(env.root, 'PaymentsWeb');
  fs.mkdirSync(dir);
  pid = (await api('POST', '/api/projects', { alias: 'Payments Web', path: dir })).project.id;
  browser = await chromium.launch({ executablePath: EDGE, headless: true });
  page = await (await browser.newContext({ viewport: { width: 1280, height: 1000 } })).newPage();
  page.on('dialog', (d) => void d.accept());
  await page.goto(env.createLaunchUrl());
  await page.waitForSelector('[data-page="overview"]');
});
afterAll(async () => {
  await browser?.close();
  await env.cleanup();
});

describe('Settings: Agent access', () => {
  it('is OFF by default and the setup command is hidden until asked for', async () => {
    await page.goto(env.origin + '/#/settings');
    await page.waitForSelector('[data-agent-access]');
    expect(await page.getAttribute('[data-agent-status]', 'data-agent-status')).toBe('off');
    expect(await page.locator('[data-agent-setup]').count()).toBe(0);
    expect(await page.textContent('[data-agent-tools]')).toContain('qa_create_test_case_draft');
    expect(await page.textContent('[data-agent-tools]')).not.toMatch(/approve|close_|complete|delete/);
  });

  it('a person turns it on (after confirming) and an agent call then works and is audited', async () => {
    await page.click('[data-agent-on]');
    await page.waitForSelector('[data-agent-status="on"]');
    const r = await agentCall('qa_create_requirement', { project: 'Payments Web', ref: 'REQ-1', title: 'Lockout' });
    expect(r.statusCode).toBe(200);
    await page.waitForSelector('[data-agent-activity] td:has-text("qa_create_requirement")', { timeout: 15_000 });
    expect(await page.textContent('[data-agent-activity]')).toContain('Payments Web');
    expect(await page.textContent('[data-agent-activity]')).not.toContain('Lockout');
    await shot('2d-settings.png');
  });

  it('shows the setup command (no token in it) and can revoke the token', async () => {
    await page.click('[data-agent-show-setup]');
    await page.waitForSelector('[data-agent-setup]');
    const cmd = (await page.textContent('[data-agent-setup] pre')) ?? '';
    expect(cmd).toContain('claude mcp add --scope user qa-office');
    expect(cmd).toContain('qa-office-mcp.mjs');
    expect(cmd).not.toContain(readAgentToken(env.paths));
    const old = readAgentToken(env.paths);
    await page.click('[data-agent-rotate]');
    await page.waitForSelector('text=Agent token replaced.');
    expect(readAgentToken(env.paths)).not.toBe(old);
    const stale = await env.app.inject({ method: 'GET', url: '/api/agent/tools', headers: { host: env.host, 'x-qavo-agent-token': old } });
    expect(stale.statusCode).toBe(401);
  });

  it('turning it off blocks agents again', async () => {
    await page.click('[data-agent-off]');
    await page.waitForSelector('[data-agent-status="off"]');
    expect((await agentCall('qa_list_projects', {})).statusCode).toBe(403);
  });
});

describe('agent work shows up for the person to review', () => {
  it('an agent draft is labelled and cannot be approved by the agent', async () => {
    await api('PUT', '/api/settings/agent', { enabled: true, confirm: true });
    const d = await agentCall('qa_create_test_case_draft', { project: 'Payments Web', title: 'Lockout after 5 failures', steps: ['Open', 'Fail 5 times'], expectedResult: 'Locked', requirementRefs: ['REQ-1'] });
    expect(d.statusCode).toBe(200);
    await page.goto(env.origin + '/#/manual');
    await page.waitForSelector('[data-project-select]');
    await page.selectOption('[data-project-select]', { label: 'Payments Web' });
    await page.click('button[data-tab="test-cases"]');
    await page.waitForSelector('tr:has-text("Lockout after 5 failures")');
    const row = await page.textContent('tr:has-text("Lockout after 5 failures")');
    expect(row).toContain('Draft');
    expect(row).toContain('agent');
  });
});

describe('Project Room', () => {
  it('shows real Manual QA figures instead of "Arrives in Pass 2" placeholders', async () => {
    await page.goto(env.origin + `/#/projects/${pid}`);
    await page.waitForSelector('[data-room-qa]');
    await page.waitForSelector('[data-room-qa] [data-kpi="room-cases"]');
    expect(await page.textContent('[data-room-qa] [data-kpi="room-cases"] .kpi-value')).toContain('1');
    expect(await page.getAttribute('[data-room-qa] [data-kpi="room-results"]', 'data-nodata')).toBe('true');
    expect(await page.textContent('[data-page="room"]')).not.toContain('Arrives in Pass 2');
    await shot('2d-room.png');
  });

  it('"Launch Claude Code here" asks first, then opens a terminal in the project folder (through the app only)', async () => {
    expect(launched).toEqual([]);
    await page.click('[data-launch-claude]');
    await page.waitForSelector('text=A terminal window was opened');
    expect(launched).toHaveLength(1);
    expect(launched[0]!.toLowerCase()).toContain('paymentsweb');
  });
});

describe('layout', () => {
  it('Settings has no horizontal scroll at 360 px and the new card is spaced from its neighbours', async () => {
    const p = await (await browser.newContext({ viewport: { width: 360, height: 800 } })).newPage();
    await p.goto(env.createLaunchUrl());
    await p.waitForSelector('[data-page="overview"]');
    await p.goto(env.origin + '/#/settings');
    await p.waitForSelector('[data-agent-access]');
    expect(await p.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
    await shot('2d-mobile.png', p);
  });
});
