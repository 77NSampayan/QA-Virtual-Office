/**
 * The agents in the office (headless Edge): the QA Team room has one desk per role with a name plate; an agent's robot
 * appears only while it has a real session and sits at its own desk; empty desks stay empty; a rename follows live;
 * and a person can retire an old robot. Isolated database.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { chromium, type Browser, type Page } from 'playwright-core';
import { makeEnv, uiHeaders, type TestEnv } from '../apps/server/test/helpers.ts';
import { roomKeyForType } from '../apps/web/src/office/map.ts';

const ROOT = path.resolve(__dirname, '..');
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const SHOTS = process.env.QAVO_E2E_SHOTS;

let env: TestEnv;
let browser: Browser;
let page: Page;
let projectId: string;
let cookie: string;
const launches: Array<{ run?: { configPath: string; runId: string } }> = [];

const api = async (method: string, url: string, payload?: unknown) => {
  const r = await env.app.inject({ method: method as 'GET', url, headers: { ...uiHeaders(env), cookie }, payload: payload as object });
  return { status: r.statusCode, body: r.body ? r.json() : null };
};
async function post(sessionId: string, event: string, extra: Record<string, unknown> = {}) {
  const r = await env.app.inject({
    method: 'POST',
    url: '/api/hooks',
    headers: { host: env.host, 'x-qavo-token': env.token, 'content-type': 'application/json' },
    payload: { v: 1, eventId: crypto.randomUUID(), ts: new Date().toISOString(), sessionId, event, projectId, folderKeys: [], ...extra },
  });
  expect(r.statusCode).toBe(204);
}
const desk = (i: number) => `[data-office-team] li[data-desk-index="${i}"]`;
const state = (i: number) => page.getAttribute(desk(i), 'data-state');
const waitState = (i: number, s: string) => page.waitForSelector(`${desk(i)}[data-state="${s}"]`, { state: 'attached', timeout: 40_000 });

beforeAll(async () => {
  expect(fs.existsSync(path.join(ROOT, 'apps/web/dist/index.html')), 'run `npm run build:web` first').toBe(true);
  env = await makeEnv({ listen: true, auth: true, webDist: path.join(ROOT, 'apps/web/dist'), launchClaude: (_c, run) => launches.push({ run }) });
  cookie = `qavo_session=${env.auth.issueSession()}`;
  const dir = path.join(env.root, 'PaymentsWeb');
  fs.mkdirSync(dir);
  projectId = (await api('POST', '/api/projects', { alias: 'Payments Web', path: dir })).body.project.id;
  await api('PUT', '/api/settings/agent', { enabled: true, confirm: true });
  browser = await chromium.launch({ executablePath: EDGE, headless: true });
  page = await (await browser.newContext({ viewport: { width: 1280, height: 1000 } })).newPage();
  await page.goto(env.createLaunchUrl());
  await page.waitForSelector('[data-office]');
  await page.waitForSelector('[data-office-team] li');
});
afterAll(async () => {
  await browser?.close();
  await env.cleanup();
});

describe('the QA Team room', () => {
  it('has a desk with a name plate for every role, all empty before anything runs, the later ones marked', async () => {
    expect(await page.locator('[data-office-team] li').count()).toBe(9);
    expect(await page.getAttribute(desk(1), 'data-agent')).toBe('Quinn');
    expect(await page.getAttribute(desk(2), 'data-agent')).toBe('Rhea');
    expect(await state(1)).toBe('empty');
    expect(await state(2)).toBe('empty');
    expect(await state(3)).toBe('later'); // Axel arrives in Pass 3
    expect(await page.locator('[data-office-robots] li').count()).toBe(0); // no robot is invented for a desk
    // the canvas really draws a building with the team room in it
    const colours = await page.evaluate(() => {
      const c = document.querySelector('.office-canvas') as HTMLCanvasElement;
      const d = c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data;
      const seen = new Set<number>();
      for (let i = 0; i < d.length; i += 4 * 97) seen.add((d[i]! << 16) | (d[i + 1]! << 8) | d[i + 2]!);
      return seen.size;
    });
    expect(colours).toBeGreaterThan(8);
    if (SHOTS) await (await page.$('[data-office]'))!.screenshot({ path: path.join(SHOTS, 'team-room-empty.png') });
  });

  it('an agent that runs gets its robot at its own desk (in the team room, whichever project it works on), and rests in the lounge', async () => {
    await page.waitForTimeout(2700); // robots present right at page load are placed in place; wait so this one arrives live
    await api('POST', `/api/projects/${projectId}/launch-claude`, { confirm: true, playbookId: 'case_writer' });
    const runId = launches[launches.length - 1]!.run!.runId;
    await post('s-quinn', 'SessionStart', { source: 'startup', runId });
    await post('s-quinn', 'UserPromptSubmit', { runId });
    const bot = (await api('GET', '/api/robots')).body.find((r: { name: string }) => r.name === 'Quinn').id as string;
    await page.waitForSelector(`[data-office-robots] li[data-robot="${bot}"]`, { state: 'attached' });
    expect(await page.getAttribute(`[data-office-robots] li[data-robot="${bot}"]`, 'data-room')).toBe('qa');
    await waitState(1, 'at-desk');
    expect(await page.getAttribute(desk(1), 'data-robot')).toBe(bot);
    expect(await state(2)).toBe('empty'); // Rhea's desk is still empty
    if (SHOTS) await (await page.$('[data-office]'))!.screenshot({ path: path.join(SHOTS, 'team-room-quinn.png') });

    await post('s-quinn', 'Stop', { runId }); // finished -> completed -> the lounge, the desk stays hers
    await waitState(1, 'away');
    expect(await page.getAttribute(desk(1), 'data-robot')).toBe(bot);
    await post('s-quinn', 'UserPromptSubmit', { runId });
    await waitState(1, 'at-desk');
    expect(await page.getAttribute(desk(1), 'data-robot')).toBe(bot); // the same desk again
  });

  it('a second agent sits at its own desk, and a plain session goes to the room of its robot type, and never takes an agent desk', async () => {
    await api('POST', `/api/projects/${projectId}/launch-claude`, { confirm: true, playbookId: 'case_reviewer' });
    const runId = launches[launches.length - 1]!.run!.runId;
    await post('s-rhea', 'SessionStart', { source: 'startup', runId });
    await post('s-rhea', 'UserPromptSubmit', { runId });
    await waitState(2, 'at-desk');
    await post('s-plain', 'SessionStart', { source: 'startup' });
    await post('s-plain', 'UserPromptSubmit');
    const plainRobot = (await api('GET', '/api/robots')).body.find((r: { name: string }) => r.name.startsWith('Unit-')) as { id: string; robotType: string };
    const plain = plainRobot.id;
    await page.waitForSelector(`[data-office-robots] li[data-robot="${plain}"]`, { state: 'attached' });
    expect(await page.getAttribute(`[data-office-robots] li[data-robot="${plain}"]`, 'data-room')).toBe(roomKeyForType(plainRobot.robotType)); // by the type its owner chose, never by project
    if (roomKeyForType(plainRobot.robotType) === 'qa') expect([1, 2]).not.toContain(Number(await page.evaluate((id) => document.querySelector(`[data-office-team] li[data-robot="${id}"]`)?.getAttribute('data-desk-index'), plain))); // an agent's desk stays the agent's
  });

  it('a rename of the agent follows into the office name plate live', async () => {
    await api('PATCH', '/api/playbooks/case_writer', { agentName: 'Nova' });
    await page.waitForSelector(`${desk(1)}[data-agent="Nova"]`, { state: 'attached' });
    await api('POST', '/api/playbooks/case_writer/reset');
    await page.waitForSelector(`${desk(1)}[data-agent="Quinn"]`, { state: 'attached' });
  });

  it('a disconnected agent stays at its desk (dim), exactly like every other robot; nothing is removed', async () => {
    const rhea = (await page.getAttribute(desk(2), 'data-robot')) as string;
    await post('s-rhea', 'SessionEnd', { reason: 'other', runId: launches[1]!.run!.runId });
    await page.waitForSelector(`[data-office-robots] li[data-robot="${rhea}"][data-status="disconnected"]`, { state: 'attached', timeout: 40_000 });
    await waitState(2, 'at-desk');
    expect(await page.getAttribute(desk(2), 'data-robot')).toBe(rhea);
  });
});

describe('retiring an old robot (Team page)', () => {
  it('shows a Retire button for plain robots, refuses a recently active one with a clear message, and hides an old one', async () => {
    await page.goto(env.origin + '/#/team');
    await page.waitForSelector('[data-others]');
    const plainRow = (await api('GET', '/api/robots')).body.find((r: { name: string }) => r.name.startsWith('Unit-')) as { id: string; name: string };
    const editor = `[data-robot-editor="${plainRow.id}"]`;
    await page.waitForSelector(`${editor} [data-robot-retire]`);
    expect(await page.locator(`[data-playbook] [data-robot-retire]`).count()).toBe(0); // agents' robots cannot be retired
    await page.click(`${editor} [data-robot-retire]`);
    await page.waitForSelector('.error');
    expect(await page.textContent('.error')).toMatch(/robot_recently_active/);
    env.db.prepare('UPDATE sessions SET last_event_at = ? WHERE robot_id = ?').run(Date.now() - 3_600_000, plainRow.id);
    await page.click(`${editor} [data-robot-retire]`);
    await page.waitForFunction((sel) => !document.querySelector(sel), editor);
    expect((await api('GET', '/api/robots')).body.some((r: { id: string }) => r.id === plainRow.id)).toBe(false);
  });
});

describe('an outdated installed hook is called out where it hurts', () => {
  it('shows a warning on the Team page only when the installed hook script is out of date, and it goes away after a reinstall', async () => {
    await page.goto(env.origin + '/#/team');
    await page.waitForSelector('[data-page="team"] [data-playbook]');
    expect(await page.locator('[data-hook-outdated]').count()).toBe(0); // hooks not installed in this test setup: nothing to warn about
    const install = await api('POST', '/api/integration/hooks/install', { acknowledge: true });
    expect(install.status, JSON.stringify(install.body)).toBe(200);
    await page.reload();
    await page.waitForSelector('[data-page="team"] [data-playbook]');
    await page.waitForTimeout(500);
    expect(await page.locator('[data-hook-outdated]').count()).toBe(0); // freshly installed: up to date
    fs.appendFileSync(env.paths.forwarder, ' // an older version'); // now the installed script differs from the build
    await page.reload();
    await page.waitForSelector('[data-hook-outdated]');
    expect(await page.textContent('[data-hook-outdated]')).toMatch(/out of date.*Reinstall hooks/s);
    expect((await api('POST', '/api/integration/hooks/install', { acknowledge: true })).status).toBe(200);
    await page.reload();
    await page.waitForSelector('[data-page="team"] [data-playbook]');
    await page.waitForTimeout(500);
    expect(await page.locator('[data-hook-outdated]').count()).toBe(0);
  });
});
