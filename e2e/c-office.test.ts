/**
 * Pass 1C acceptance in a real browser (headless Edge). All events are SYNTHETIC and go to an
 * isolated database created for the test (ADR-012); nothing here touches the real data folder.
 *   C1 every status renders its specified animation and colour (checked on real canvas pixels)
 *   C2 robots reflect real events only
 *   C3 robot customizations persist
 *   C4 layout works at 360 px with no horizontal scroll
 *   C5 no KPI renders without a real data source
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core';
import { ALL_STATUSES, STATUS_COLOR, type RobotStatus } from '@qavo/shared';
import { makeEnv, uiHeaders, type TestEnv } from '../apps/server/test/helpers.ts';

const ROOT = path.resolve(__dirname, '..');
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const SHOTS = process.env.QAVO_E2E_SHOTS;

let env: TestEnv;
let browser: Browser;
let ctx: BrowserContext;
let page: Page;
let projectDir: string;
let projectId: string;
let cookie: string;
const authed = () => ({ ...uiHeaders(env), cookie });

beforeAll(async () => {
  expect(fs.existsSync(path.join(ROOT, 'apps/web/dist/index.html')), 'run `npm run build:web` first').toBe(true);
  env = await makeEnv({ listen: true, auth: true, webDist: path.join(ROOT, 'apps/web/dist') });
  cookie = `qavo_session=${env.auth.issueSession()}`; // server-side test calls act as a signed-in user
  projectDir = path.join(env.root, 'OfficeProject');
  fs.mkdirSync(projectDir);
  const r = await env.app.inject({ method: 'POST', url: '/api/projects', headers: authed(), payload: { alias: 'Payments Web', path: projectDir, type: 'web' } });
  projectId = r.json().project.id;
  browser = await chromium.launch({ executablePath: EDGE, headless: true });
  ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  page = await ctx.newPage();
  await page.goto(env.createLaunchUrl());
  await page.waitForSelector('[data-page="overview"]');
});
afterAll(async () => {
  await browser?.close();
  await env.cleanup();
});

const api = async (method: string, url: string, payload?: unknown) => {
  const r = await env.app.inject({ method: method as 'GET', url, headers: authed(), payload: payload as object });
  return r.body ? r.json() : null;
};

let seq = 0;
async function post(sessionId: string, event: string, extra: Record<string, unknown> = {}) {
  seq++;
  const r = await env.app.inject({
    method: 'POST',
    url: '/api/hooks',
    headers: { host: env.host, 'x-qavo-token': env.token, 'content-type': 'application/json' },
    payload: { v: 1, eventId: crypto.randomUUID(), ts: new Date().toISOString(), sessionId, event, projectId, folderKeys: [], ...extra },
  });
  expect(r.statusCode).toBe(204);
  void seq;
}

const robotSel = (robotId: string) => `.station-unit[data-robot="${robotId}"]`;
async function robotIdOf(sessionId: string): Promise<string> {
  return (await api('GET', `/api/sessions/${sessionId}`)).robot.id;
}
async function countColor(sel: string, hex: string): Promise<number> {
  return page.evaluate(
    ([s, h]) => {
      const c = document.querySelector(s as string) as HTMLCanvasElement | null;
      if (!c) return -1;
      const d = c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data;
      const [r, g, b] = [1, 3, 5].map((i) => parseInt((h as string).slice(i, i + 2), 16));
      let n = 0;
      for (let i = 0; i < d.length; i += 4) if (d[i] === r && d[i + 1] === g && d[i + 2] === b && d[i + 3] === 255) n++;
      return n;
    },
    [sel, hex],
  );
}
const shot = async (name: string, p: Page = page, full = true) => {
  if (SHOTS) await p.screenshot({ path: path.join(SHOTS, name), fullPage: full });
};

describe('C5: no KPI renders without a real data source (empty office)', () => {
  it('real KPIs show real zeros; every test/defect KPI says "No data yet" instead of a number', async () => {
    await page.goto(env.origin + '/#/');
    await page.waitForSelector('[data-kpi]');
    const kpis = await page.$$eval('[data-kpi]', (els) =>
      els.map((e) => ({ id: e.getAttribute('data-kpi')!, nodata: e.getAttribute('data-nodata') === 'true', value: e.querySelector('.kpi-value')?.textContent ?? '' })),
    );
    const byId = Object.fromEntries(kpis.map((k) => [k.id, k]));
    for (const id of ['passed', 'failed', 'blocked', 'pending', 'defects']) {
      expect(byId[id]!.nodata, id).toBe(true);
      expect(byId[id]!.value, id).toBe('No data yet');
      expect(byId[id]!.value).not.toMatch(/\d/);
    }
    for (const id of ['projects', 'active-agents', 'attention', 'manual-active', 'automation-active', 'writing', 'running', 'unread']) {
      expect(byId[id]!.nodata, id).toBe(false);
      expect(byId[id]!.value, id).toMatch(/^\d+$/);
    }
    expect(byId['projects']!.value).toBe('1'); // the one registered project is real
    expect(byId['active-agents']!.value).toBe('0');
    // every real KPI explains how it is calculated
    const titles = await page.$$eval('[data-kpi][data-nodata="false"]', (els) => els.map((e) => e.getAttribute('title') ?? ''));
    expect(titles.every((t) => t.length > 20)).toBe(true);
    expect(await page.$$('.station-unit')).toHaveLength(0); // no robots invented
    expect(await page.textContent('[data-dept="manual"]')).toContain('No robots here yet');
    await shot('office-empty.png');
  });

  it('project room and control room show "No data yet" panels for unbuilt modules', async () => {
    await page.goto(env.origin + `/#/projects/${projectId}`);
    await page.waitForSelector('[data-page="room"]');
    // Automation is still unbuilt (Pass 3); Manual QA figures are real since 2B/2C and say so when nothing is recorded
    expect((await page.$$('.nodata-panel')).length).toBeGreaterThanOrEqual(1);
    expect(await page.textContent('[data-room-qa]')).toContain('Nothing recorded yet');
    await page.goto(env.origin + '/#/control');
    await page.waitForSelector('[data-page="control"]');
    expect((await page.$$('.nodata-panel')).length).toBeGreaterThanOrEqual(4);
    expect(await page.textContent('[data-page="control"]')).toContain('Nothing is waiting for you');
  });
});

describe('C1 + C2: a robot follows real events through all 10 statuses', () => {
  const SID = 'c1-walkthrough';
  const steps: Array<{ status: RobotStatus; event: string; extra?: Record<string, unknown> }> = [
    { status: 'idle', event: 'SessionStart', extra: { source: 'startup' } },
    { status: 'analyzing', event: 'UserPromptSubmit' },
    { status: 'writing_tests', event: 'PreToolUse', extra: { toolName: 'Write', fileCategory: 'test' } },
    { status: 'executing_tests', event: 'PreToolUse', extra: { toolName: 'Bash', commandCategory: 'test_run' } },
    { status: 'debugging', event: 'PostToolUseFailure', extra: { toolName: 'Bash', error: 'Exit code 1' } },
    { status: 'awaiting_permission', event: 'PermissionRequest', extra: { toolName: 'Write' } },
    { status: 'awaiting_input', event: 'Notification', extra: { notificationType: 'elicitation_dialog' } },
    { status: 'completed', event: 'Stop' },
    { status: 'failed', event: 'StopFailure', extra: { error: 'rate_limit' } },
    { status: 'disconnected', event: 'SessionEnd', extra: { reason: 'other' } },
  ];

  it('each real event changes the on-screen robot to the matching status, with its specified colour on the canvas', async () => {
    await page.goto(env.origin + '/#/');
    await page.waitForSelector('[data-page="overview"]');
    await post(SID, 'SessionStart', { source: 'startup' });
    const robotId = await robotIdOf(SID);
    const unit = robotSel(robotId);
    await page.waitForSelector(`${unit}[data-status="idle"]`);
    for (const step of steps) {
      if (step.event !== 'SessionStart') await post(SID, step.event, step.extra);
      await page.waitForSelector(`${unit}[data-status="${step.status}"]`);
      await page.waitForSelector(`${unit} canvas[data-kind="robot"][data-status="${step.status}"]`);
      // the canvas really contains the status colour (disconnected: dim LEDs only)
      if (step.status !== 'disconnected') {
        await page.waitForFunction(() => true);
        expect(await countColor(`${unit} canvas[data-kind="robot"]`, STATUS_COLOR[step.status]), `robot ${step.status}`).toBeGreaterThan(0);
        expect(await countColor(`${unit} canvas[data-kind="station"]`, STATUS_COLOR[step.status]), `station ${step.status}`).toBeGreaterThan(0);
      } else {
        for (const other of ALL_STATUSES.filter((s) => s !== 'disconnected')) expect(await countColor(`${unit} canvas[data-kind="robot"]`, STATUS_COLOR[other]), `off vs ${other}`).toBe(0);
      }
      expect(await page.textContent(`${unit} .plate`)).toContain({ idle: 'Idle', analyzing: 'Analyzing', writing_tests: 'Writing test cases', executing_tests: 'Executing tests', debugging: 'Debugging', awaiting_permission: 'Awaiting permission', awaiting_input: 'Awaiting input', completed: 'Completed', failed: 'Failed', disconnected: 'Disconnected' }[step.status]);
      if (step.status === 'executing_tests') await shot('robot-executing.png', page, false);
    }
  });

  it('inferred statuses are marked "~" and event-stated ones are not', async () => {
    const robotId = await robotIdOf(SID);
    await post(SID, 'SessionStart', { source: 'resume' }); // event-stated idle
    await page.waitForSelector(`${robotSel(robotId)}[data-status="idle"]`);
    expect(await page.textContent(`${robotSel(robotId)} .plate .pill`)).not.toMatch(/^~/);
    await post(SID, 'UserPromptSubmit'); // inferred analyzing
    await page.waitForSelector(`${robotSel(robotId)}[data-status="analyzing"]`);
    expect(await page.textContent(`${robotSel(robotId)} .plate .pill`)).toMatch(/^~/);
  });

  it('C2: with no new events the status never changes, while the animation keeps running', async () => {
    const robotId = await robotIdOf(SID);
    const sel = `${robotSel(robotId)} canvas[data-kind="robot"]`;
    const samples: Array<{ status: string; frame: string }> = [];
    for (let i = 0; i < 12; i++) {
      samples.push(await page.$eval(sel, (c) => ({ status: c.getAttribute('data-status')!, frame: c.getAttribute('data-frame')! })));
      await page.waitForTimeout(150);
    }
    expect(new Set(samples.map((s) => s.status)).size).toBe(1); // status is driven only by events
    expect(new Set(samples.map((s) => s.frame)).size).toBeGreaterThan(1); // animation frames advance
  });

  it('C2: every robot on screen belongs to a real session (no invented robots)', async () => {
    const onScreen = await page.$$eval('.station-unit', (els) => els.map((e) => e.getAttribute('data-robot')!));
    const real = (await api('GET', '/api/robots')).map((r: { id: string }) => r.id);
    expect(onScreen.length).toBeGreaterThan(0);
    for (const id of onScreen) expect(real).toContain(id);
    const sessions = (await api('GET', '/api/sessions')) as Array<{ robot: { id: string } }>;
    for (const id of onScreen) expect(sessions.some((s) => s.robot.id === id)).toBe(true);
  });

  it('a subagent appears as a drone beside its parent, from the real SubagentStart event', async () => {
    const robotId = await robotIdOf(SID);
    expect(await page.$$(`${robotSel(robotId)} canvas[data-kind="drone"]`)).toHaveLength(0);
    await post(SID, 'SubagentStart', { agentId: 'agent-e2e', agentType: 'Explore' });
    await page.waitForSelector(`${robotSel(robotId)} canvas[data-kind="drone"]`);
    expect(await page.$$(`${robotSel(robotId)} canvas[data-kind="drone"]`)).toHaveLength(1);
  });
});

describe('the office with several departments', () => {
  it('robots sit in the department of their logical role, each at its own workstation', async () => {
    const sessions = ['d-analyst', 'd-manual', 'd-auto', 'd-api', 'd-regr', 'd-bug', 'd-lead'];
    const roles = ['qa_analyst', 'manual_tester', 'automation_engineer', 'api_tester', 'regression_tester', 'bug_investigator', 'qa_lead'];
    const statuses: Array<[string, Record<string, unknown>?]> = [
      ['UserPromptSubmit'],
      ['PreToolUse', { toolName: 'Write', fileCategory: 'test' }],
      ['PreToolUse', { toolName: 'Bash', commandCategory: 'test_run' }],
      ['PermissionRequest', { toolName: 'Bash' }],
      ['PostToolUseFailure', { toolName: 'Bash', error: 'Exit code 2' }],
      ['Notification', { notificationType: 'elicitation_dialog' }],
      ['Stop'],
    ];
    for (let i = 0; i < sessions.length; i++) {
      await post(sessions[i]!, 'SessionStart', { source: 'startup' });
      const rid = await robotIdOf(sessions[i]!);
      await api('PATCH', `/api/robots/${rid}`, { robotType: roles[i], role: roles[i], name: `Bot ${i}` });
      await post(sessions[i]!, statuses[i]![0], statuses[i]![1]);
    }
    await page.goto(env.origin + '/#/');
    await page.waitForSelector('[data-page="overview"]');
    const deptOf = async (name: string) => page.$eval(`.station-unit[data-name="${name}"]`, (e) => e.closest('[data-dept]')!.getAttribute('data-dept'));
    await page.waitForSelector('.station-unit[data-name="Bot 6"]');
    // roles in order: analyst, manual tester, automation engineer, API tester, regression tester, bug investigator, QA lead
    const expected = ['manual', 'manual', 'automation', 'automation', 'automation', 'manual', 'lead'];
    for (let i = 0; i < expected.length; i++) expect(await deptOf(`Bot ${i}`), `Bot ${i}`).toBe(expected[i]);
    // all seven robot types are drawn (distinct canvases)
    const types = await page.$$eval('.station-unit canvas[data-kind="robot"]', (els) => els.map((e) => e.getAttribute('data-type')));
    expect(new Set(types).size).toBeGreaterThanOrEqual(7);
    // KPIs now reflect the real sessions
    const val = async (id: string) => Number(await page.textContent(`[data-kpi="${id}"] .kpi-value`));
    expect(await val('active-agents')).toBeGreaterThanOrEqual(7);
    expect(await val('running')).toBeGreaterThanOrEqual(1);
    expect(await val('writing')).toBeGreaterThanOrEqual(1);
    expect(await val('attention')).toBeGreaterThanOrEqual(2);
    await page.waitForTimeout(600);
    await shot('office-populated.png');
  });

  it('Control Room lists what needs attention, with the tool awaiting permission', async () => {
    await page.goto(env.origin + '/#/control');
    await page.waitForSelector('[data-attention] li');
    const text = await page.textContent('[data-attention]');
    expect(text).toContain('Awaiting permission');
    expect(text).toContain('Bash');
    expect(text).toContain('Awaiting input');
    expect(await page.$$('[data-feed] li')).not.toHaveLength(0);
    await shot('control-room.png');
  });

  it('Project room shows only that project\'s robots and its real activity', async () => {
    await page.goto(env.origin + `/#/projects/${projectId}`);
    await page.waitForSelector('[data-page="room"] .station-unit');
    expect((await page.$$('[data-page="room"] .station-unit')).length).toBeGreaterThanOrEqual(7);
    expect(await page.textContent('[data-feed]')).toContain('Bot');
    await shot('project-room.png');
  });
});

describe('notifications center', () => {
  it('shows the permission notification, unread badge, and mark read / unread / all', async () => {
    await page.goto(env.origin + '/#/notifications');
    await page.waitForSelector('[data-notification]');
    const unreadBefore = Number(await page.textContent('a[data-nav="/notifications"] .badge'));
    expect(unreadBefore).toBeGreaterThan(0);
    expect(await page.textContent('[data-notifications]')).toContain('Permission required');
    const first = page.locator('[data-notification][data-read="false"]').first();
    await first.locator('text=Mark read').click();
    await page.waitForFunction((n) => Number(document.querySelector('a[data-nav="/notifications"] .badge')?.textContent ?? '0') === n, unreadBefore - 1);
    await page.click('button:has-text("Mark all read")');
    await page.waitForFunction(() => !document.querySelector('a[data-nav="/notifications"] .badge'));
    expect(await page.$$('[data-notification][data-read="false"]')).toHaveLength(0);
    await page.click('button:has-text("High priority")');
    expect(await page.$$('[data-notification]')).not.toHaveLength(0);
    await shot('notifications.png');
  });
});

describe('C3: robot customization', () => {
  it('rename, re-skin and recolour a robot from the Robots page; it shows on the floor and survives a reload', async () => {
    await page.goto(env.origin + '/#/robots');
    await page.waitForSelector('[data-robot-editor]');
    const editor = page.locator('[data-robot-editor]').first();
    const id = await editor.getAttribute('data-robot-editor');
    await editor.locator('input').first().fill('Ada');
    await editor.locator('select').nth(1).selectOption('bug_investigator');
    await editor.locator('input[type="color"]').first().fill('#12ab34');
    await editor.locator('button:has-text("Save")').click();
    await page.waitForSelector('text=Saved. This identity persists');
    // the server has it
    const saved = ((await api('GET', '/api/robots')) as Array<{ id: string; name: string; robotType: string; palette: { primary: string } }>).find((r) => r.id === id)!;
    expect(saved).toMatchObject({ name: 'Ada', robotType: 'bug_investigator', palette: { primary: '#12ab34' } });
    // the office floor draws the new look and name; reload keeps it
    await page.goto(env.origin + '/#/');
    await page.reload();
    await page.waitForSelector(`${robotSel(id!)}[data-name="Ada"]`);
    expect(await page.$eval(`${robotSel(id!)} canvas[data-kind="robot"]`, (c) => c.getAttribute('data-type'))).toBe('bug_investigator');
    expect(await countColor(`${robotSel(id!)} canvas[data-kind="robot"]`, '#12ab34')).toBeGreaterThan(0);
  });

  it('the animation preview is clearly labelled as preview, not real state', async () => {
    await page.goto(env.origin + '/#/robots');
    await page.waitForSelector('[data-robot-editor]');
    const editor = page.locator('[data-robot-editor]').first();
    await editor.locator('select').first().selectOption('failed');
    expect(await editor.textContent()).toContain('Preview only');
    expect(await editor.locator('canvas[data-kind="robot"]').getAttribute('data-status')).toBe('failed');
    await shot('robots.png');
  });
});

describe('C4: layout works at 360 px', () => {
  const routes = ['/', '/projects', `/projects/PID`, '/control', '/robots', '/notifications', '/sessions', '/settings', '/sprites', '/manual', '/automation', '/api-testing', '/test-data', '/tasks', '/metrics'];
  it('no horizontal page scroll on any screen, and the floor collapses to status cards', async () => {
    const mctx = await browser.newContext({ viewport: { width: 360, height: 740 }, deviceScaleFactor: 2 });
    const mp = await mctx.newPage();
    await mp.goto(env.createLaunchUrl());
    await mp.waitForSelector('[data-page="overview"]');
    for (const route of routes) {
      await mp.goto(env.origin + '/#' + route.replace('PID', projectId));
      await mp.reload(); // fresh render at this width
      await mp.waitForSelector('.content > *');
      await mp.waitForTimeout(250);
      const m = await mp.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: window.innerWidth, bw: document.body.scrollWidth }));
      expect(m.sw, `${route} scrollWidth ${m.sw} > ${m.iw}`).toBeLessThanOrEqual(m.iw);
      expect(m.bw, `${route} body ${m.bw}`).toBeLessThanOrEqual(m.iw);
    }
    await mp.goto(env.origin + '/#/');
    await mp.reload();
    await mp.waitForSelector('.robot-card');
    expect(await mp.$$eval('.floor', (els) => els.every((e) => getComputedStyle(e).display === 'none'))).toBe(true);
    expect(await mp.$$eval('.cards', (els) => els.some((e) => getComputedStyle(e).display !== 'none'))).toBe(true);
    // menu drawer
    expect(await mp.$eval('.sidenav', (e) => getComputedStyle(e).transform)).not.toBe('none');
    await mp.click('.menu-btn');
    await mp.waitForFunction(() => getComputedStyle(document.querySelector('.sidenav')!).transform === 'none');
    await mp.click('a[data-nav="/control"]');
    await mp.waitForSelector('[data-page="control"]');
    await shot('mobile-overview.png', mp, false);
    await mp.goto(env.origin + '/#/');
    await mp.reload();
    await mp.waitForSelector('.robot-card');
    await shot('mobile-overview-cards.png', mp, true);
    await mctx.close();
  });
});

describe('the sprite gallery and placeholders', () => {
  it('gallery renders all 10 statuses, 7 types and drones; unbuilt modules say which pass delivers them', async () => {
    await page.goto(env.origin + '/#/sprites');
    await page.waitForSelector('[data-page="sprites"]');
    expect(await page.$$('[data-gallery-status]')).toHaveLength(10);
    expect(await page.$$('[data-gallery-type]')).toHaveLength(7);
    await shot('sprite-gallery.png');
    // (Manual QA is a real screen since Pass 2A and the Task Board since 2C; their browser tests are in qa-2a/qa-2c; its own browser tests are in qa-2a.test.ts)
    for (const [route, pass] of [['/automation', 'Pass 3'], ['/metrics', 'Pass 4']] as const) {
      await page.goto(env.origin + '/#' + route);
      await page.waitForSelector('[data-coming]');
      expect(await page.textContent('[data-coming]')).toContain(`Arrives in ${pass}`);
    }
  });
});
