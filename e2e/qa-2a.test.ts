/**
 * Pass 2A acceptance in a real browser (headless Edge): requirements, test cases, the human-only
 * approval workflow, traceability coverage with denominators, and responsive layout.
 * All data is created in an isolated database for the test.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { chromium, type Browser, type Page } from 'playwright-core';
import * as qa from '../apps/server/src/qa.ts';
import { makeEnv, uiHeaders, type TestEnv } from '../apps/server/test/helpers.ts';

const ROOT = path.resolve(__dirname, '..');
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const SHOTS = process.env.QAVO_E2E_SHOTS;

let env: TestEnv;
let browser: Browser;
let page: Page;
let pid: string;
let cookie: string;

const shot = async (name: string, p: Page = page) => {
  if (SHOTS) await p.screenshot({ path: path.join(SHOTS, name), fullPage: true });
};

beforeAll(async () => {
  expect(fs.existsSync(path.join(ROOT, 'apps/web/dist/index.html')), 'run `npm run build:web` first').toBe(true);
  env = await makeEnv({ listen: true, auth: true, webDist: path.join(ROOT, 'apps/web/dist') });
  cookie = `qavo_session=${env.auth.issueSession()}`;
  const mk = async (alias: string) => {
    const dir = path.join(env.root, alias.replace(/\W/g, ''));
    fs.mkdirSync(dir);
    const r = await env.app.inject({ method: 'POST', url: '/api/projects', headers: { ...uiHeaders(env), cookie }, payload: { alias, path: dir } });
    return r.json().project.id as string;
  };
  pid = await mk('Payments Web');
  await mk('Empty Project');
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

const openManual = async (tab: 'requirements' | 'test-cases' | 'traceability', p: Page = page, project = 'Payments Web') => {
  await p.goto(env.origin + '/#/manual');
  await p.waitForSelector('[data-page="manual-qa"] [data-project-select]');
  await p.selectOption('[data-project-select]', { label: project });
  await p.click(`button[data-tab="${tab}"]`);
  await p.waitForSelector(`[data-panel="${tab}"]`);
};

describe('Requirements', () => {
  it('add a requirement through the form', async () => {
    await openManual('requirements');
    await page.click('button.tab:has-text("Add requirement")');
    const form = page.locator('form.project-form');
    await form.locator('input[placeholder="REQ-12"]').fill('REQ-1');
    await form.locator('label:has-text("Title") input').fill('Account lockout');
    await form.locator('label:has-text("Requirement text") textarea').fill('The system shall lock an account after 5 failed sign-ins within 10 minutes.');
    await form.locator('button:has-text("Add requirement")').click();
    await page.waitForSelector('tr[data-req="REQ-1"]');
    expect(await page.textContent('tr[data-req="REQ-1"]')).toContain('Account lockout');
  });

  it('import from pasted text: preview first, then import; existing references are never overwritten', async () => {
    await page.click('button.tab:has-text("Import from text")');
    const imp = page.locator('[data-import]');
    const text = ['REQ-1: This text must NOT overwrite the existing REQ-1.', 'REQ-2: The page should load quickly and be user-friendly. The limit is TBD.', 'US-3 - As a user I want to reset my password so that I can regain access.'].join('\n');
    await imp.locator('textarea').fill(text);
    await imp.locator('button:has-text("Preview")').click();
    await page.waitForSelector('[data-import-preview]');
    const preview = await page.textContent('[data-import-preview]');
    expect(preview).toContain('REQ-2, US-3');
    expect(preview).toContain('Already exist (unchanged): REQ-1');
    expect(await page.$$('tr[data-req="REQ-2"]')).toHaveLength(0); // preview wrote nothing
    await imp.locator('button:has-text("Import 2 requirement(s)")').click();
    await page.waitForSelector('tr[data-req="REQ-2"]');
    await page.waitForSelector('tr[data-req="US-3"]');
    expect(await page.textContent('tr[data-req="REQ-1"]')).toContain('Account lockout');
    await page.click('button.tab:has-text("Import from text")'); // close
  });

  it('ambiguity checks raise flags for HUMAN review on vague wording only; a human resolves them', async () => {
    await page.click('button:has-text("Run ambiguity checks")');
    await page.waitForSelector('text=new flag(s) raised for your review');
    const flagsOf = async (ref: string) => Number(((await page.textContent(`tr[data-req="${ref}"] td:nth-child(5)`)) ?? '').match(/\d+/)?.[0] ?? 0);
    expect(await flagsOf('REQ-1')).toBe(0); // precise requirement: nothing flagged
    expect(await flagsOf('REQ-2')).toBeGreaterThanOrEqual(3);
    await page.click('tr[data-req="REQ-2"]');
    const detail = page.locator('[data-req-detail="REQ-2"]');
    await detail.waitFor();
    expect(await detail.textContent()).toContain('TBD');
    expect(await detail.textContent()).toContain('raised by system');
    const before = await detail.locator('[data-flag="open"]').count();
    await detail.locator('[data-flag="open"]').first().locator('input').fill('Confirmed with the BA');
    await detail.locator('[data-flag="open"]').first().locator('button:has-text("Resolve")').click();
    await page.waitForFunction((n) => document.querySelectorAll('[data-req-detail="REQ-2"] [data-flag="open"]').length === n, before - 1);
    expect(await detail.textContent()).toContain('Resolution: Confirmed with the BA');
    // raise a manual conflict flag against another requirement
    await detail.locator('form.row select').first().selectOption('conflict');
    await detail.locator('form.row select').nth(1).selectOption({ label: 'REQ-1' });
    await detail.locator('form.row input').fill('Contradicts the lockout rule');
    await detail.locator('button:has-text("Raise flag")').click();
    await page.waitForSelector('text=Contradicts the lockout rule');
    expect(await detail.textContent()).toContain('Related: REQ-1');
    await shot('qa-requirements.png');
    await page.click('tr[data-req="REQ-2"]');
  });

  it('requirements start as unreviewed and a human sets the review status', async () => {
    await page.click('tr[data-req="US-3"]');
    const detail = page.locator('[data-req-detail="US-3"]');
    await detail.waitFor();
    expect(await page.textContent('tr[data-req="US-3"]')).toContain('Unreviewed');
    await detail.locator('select').first().selectOption('needs_clarification');
    await page.waitForFunction(() => document.querySelector('tr[data-req="US-3"]')?.textContent?.includes('Needs clarification'));
    expect(await detail.textContent()).toContain('Uncovered'.slice(0, 0) + 'None yet: this requirement has no test case');
    await page.click('tr[data-req="US-3"]');
  });
});

describe('Test cases and the approval workflow', () => {
  it('creates a draft with every specified field and a requirement link', async () => {
    await openManual('test-cases');
    await page.click('button.tab:has-text("New test case")');
    const form = page.locator('[data-tc-form]');
    await form.locator('[data-field="title"]').fill('Account locks after five wrong passwords');
    await form.locator('label:has-text("Test scenario") input').fill('Authentication');
    await form.locator('label:has-text("Test type") select').selectOption('boundary_value');
    await form.locator('label:has-text("Priority") select').selectOption('high');
    await form.locator('label:has-text("Assigned tester") input').fill('Tess');
    await form.locator('label:has-text("Description") textarea').fill('Verifies the lockout threshold');
    await form.locator('label:has-text("Preconditions") textarea').fill('An active user exists');
    await form.locator('[data-field="steps"]').fill('Enter a wrong password 4 times\nEnter a wrong password a 5th time\nEnter the correct password');
    await form.locator('label:has-text("Test data") textarea').fill('user=qa.user (fake data)');
    await form.locator('[data-field="expectedResult"]').fill('After the 5th failure the account is locked and the correct password is refused');
    await form.locator('label.check:has-text("REQ-1")').locator('input').check();
    await form.locator('button:has-text("Create draft")').click();
    await page.waitForSelector('[data-tc-detail="TC-0001"]');
    const d = await page.textContent('[data-tc-detail="TC-0001"]');
    for (const t of ['Authentication', 'Boundary value analysis', 'high', 'Tess', 'Verifies the lockout threshold', 'An active user exists', 'Enter a wrong password a 5th time', 'user=qa.user', 'locked and the correct password is refused', 'REQ-1', 'execution status: NOT RUN']) {
      expect(d, t).toContain(t);
    }
    expect(d).toContain('Draft');
  });

  it('a draft cannot be approved directly: only "Submit for review" is offered; then Approve', async () => {
    const detail = page.locator('[data-tc-detail="TC-0001"]');
    expect(await detail.locator('button[data-transition="approved"]').count()).toBe(0);
    expect(await detail.locator('button[data-transition="in_review"]').count()).toBe(1);
    await detail.locator('button[data-transition="in_review"]').click();
    await page.waitForSelector('[data-tc-detail="TC-0001"] [data-tc-status="in_review"]');
    await detail.locator('button[data-transition="approved"]').click();
    await page.waitForSelector('[data-tc-detail="TC-0001"] [data-tc-status="approved"]');
    expect(await detail.textContent()).toContain('approved by you');
    const history = await page.textContent('[data-history]');
    expect(history).toContain('created');
    expect(history).toContain('(draft → in_review)');
    expect(history).toContain('(in_review → approved)');
    await shot('qa-test-case-approved.png');
  });

  it('approval is refused, with the missing items named, for an incomplete test case', async () => {
    await page.click('button.tab:has-text("New test case")');
    await page.locator('[data-tc-form] [data-field="title"]').fill('Bare draft');
    await page.locator('[data-tc-form] button:has-text("Create draft")').click();
    const detail = page.locator('[data-tc-detail="TC-0002"]');
    await detail.waitFor();
    await detail.locator('button[data-transition="in_review"]').click();
    await detail.locator('[data-tc-status="in_review"]').waitFor();
    await detail.locator('button[data-transition="approved"]').click();
    await page.waitForSelector('text=Before this can be approved it needs at least one step, an expected result');
    expect(await detail.locator('[data-tc-status]').first().getAttribute('data-tc-status')).toBe('in_review');
    // rejecting needs a reason
    await detail.locator('button[data-transition="rejected"]').click();
    await page.waitForSelector('text=Say why you are rejecting it');
    await detail.locator('input[placeholder^="Note"]').fill('Steps and expected result are missing');
    await detail.locator('button[data-transition="rejected"]').click();
    await page.waitForSelector('[data-tc-detail="TC-0002"] [data-tc-status="rejected"]');
    expect(await detail.textContent()).toContain('Rejected: Steps and expected result are missing');
    await detail.locator('button[data-transition="draft"]').click();
    await detail.locator('[data-tc-status="draft"]').waitFor();
  });

  it('editing an approved test case returns it to Draft and says so', async () => {
    await page.click('tr[data-tc="TC-0001"]'); // collapse the open row, then reopen TC-0001
    await page.waitForTimeout(100);
    if (!(await page.$('[data-tc-detail="TC-0001"]'))) await page.click('tr[data-tc="TC-0001"]');
    const detail = page.locator('[data-tc-detail="TC-0001"]');
    await detail.waitFor();
    await detail.locator('button:has-text("Edit")').click();
    expect(await page.textContent('[data-tc-form]')).toContain('returns this test case to Draft');
    await page.locator('[data-tc-form] [data-field="expectedResult"]').fill('The account is locked after the 5th failure');
    await page.locator('[data-tc-form] button:has-text("Save changes")').click();
    await page.waitForSelector('[data-tc-detail="TC-0001"] [data-tc-status="draft"]');
    expect(await page.textContent('[data-tc-detail="TC-0001"]')).toContain('v2');
    expect(await page.textContent('[data-history]')).toContain('changed: expectedResult');
  });

  it('filters narrow the list (status, type, search, author)', async () => {
    const rows = async () => (await page.$$('tr[data-tc]')).length;
    expect(await rows()).toBe(2);
    await page.selectOption('select[aria-label="Type filter"]', 'boundary_value');
    await page.waitForFunction(() => document.querySelectorAll('tr[data-tc]').length === 1);
    await page.selectOption('select[aria-label="Type filter"]', '');
    await page.fill('input[placeholder="Search…"]', 'bare');
    await page.waitForFunction(() => document.querySelectorAll('tr[data-tc]').length === 1);
    expect(await page.textContent('tr[data-tc]')).toContain('Bare draft');
    await page.fill('input[placeholder="Search…"]', '');
    await page.selectOption('select[aria-label="Status filter"]', 'approved');
    await page.waitForFunction(() => document.querySelectorAll('tr[data-tc]').length === 0);
    await page.selectOption('select[aria-label="Status filter"]', '');
    await page.waitForFunction(() => document.querySelectorAll('tr[data-tc]').length === 2);
  });

  it('an agent-written draft is clearly marked and only a human can move it forward', async () => {
    const agentCase = qa.createTestCase(env.db, pid, { title: 'Agent proposal: password reset', steps: ['Request a reset link', 'Open the link'], expectedResult: 'A new password can be set', requirementIds: [] }, 'agent');
    // an agent cannot approve it, whatever it tries
    expect(() => qa.transitionTestCase(env.db, agentCase.id, 'in_review', '', 'agent')).toThrow();
    await page.reload();
    await page.waitForSelector('[data-page="manual-qa"]');
    await page.click('button[data-tab="test-cases"]');
    await page.waitForSelector('tr[data-tc="TC-0003"]');
    expect(await page.textContent('tr[data-tc="TC-0003"]')).toContain('agent');
    await page.click('tr[data-tc="TC-0003"]');
    const detail = page.locator('[data-tc-detail="TC-0003"]');
    await detail.waitFor();
    expect(await detail.textContent()).toContain('Agent draft: needs your review');
    await shot('qa-agent-draft.png');
  });
});

describe('Traceability and coverage', () => {
  it('shows numerators, denominators and formulas; uncovered requirements are visible', async () => {
    await openManual('traceability');
    // requirements: REQ-1 (approved case was edited back to draft), REQ-2, US-3
    const approved = page.locator('[data-coverage="approved"]');
    const any = page.locator('[data-coverage="any"]');
    expect(await approved.textContent()).toContain('0 of 3 requirements');
    expect(await any.textContent()).toContain('1 of 3 requirements');
    expect(await approved.textContent()).toContain('divided by all requirements');
    expect(await page.getAttribute('tr[data-trace="REQ-1"]', 'data-covered')).toBe('unapproved');
    expect(await page.getAttribute('tr[data-trace="REQ-2"]', 'data-covered')).toBe('none');
    expect(await page.textContent('[data-untraced] .kpi-value')).toBe('2'); // TC-0002 and the agent draft are not linked to a requirement
    // approve it again: coverage follows the real records
    await page.goto(env.origin + '/#/manual');
    await page.click('button[data-tab="test-cases"]');
    await page.click('tr[data-tc="TC-0001"]');
    const d = page.locator('[data-tc-detail="TC-0001"]');
    await d.locator('button[data-transition="in_review"]').click();
    await d.locator('[data-tc-status="in_review"]').waitFor();
    await d.locator('button[data-transition="approved"]').click();
    await d.locator('[data-tc-status="approved"]').waitFor();
    await page.click('button[data-tab="traceability"]');
    await page.waitForFunction(() => document.querySelector('[data-coverage="approved"]')?.textContent?.includes('1 of 3 requirements'));
    expect(await page.textContent('[data-coverage="approved"]')).toContain('33.3%');
    await shot('qa-traceability.png');
  });

  it('a project with no requirements shows "—", never a percentage', async () => {
    await openManual('traceability', page, 'Empty Project');
    expect(await page.textContent('[data-coverage="approved"] .kpi-value')).toBe('—');
    expect(await page.textContent('[data-coverage="approved"]')).toContain('No requirements yet');
    expect(await page.textContent('[data-coverage="any"] .kpi-value')).toBe('—');
  });
});

describe('Overview and project safety', () => {
  it('the Overview shows the real count of test cases awaiting review', async () => {
    const tc = qa.createTestCase(env.db, pid, { title: 'Needs review', steps: ['a'], expectedResult: 'b' }, 'human');
    qa.transitionTestCase(env.db, tc.id, 'in_review', '', 'human');
    await page.goto(env.origin + '/#/');
    await page.waitForSelector('[data-kpi="review"]');
    await page.waitForFunction(() => Number(document.querySelector('[data-kpi="review"] .kpi-value')?.textContent) >= 1);
    expect(await page.getAttribute('[data-kpi="review"]', 'data-nodata')).toBe('false');
  });

  it('removing a project that has QA records is refused with an explanation', async () => {
    await page.goto(env.origin + `/#/projects/${pid}`);
    await page.waitForSelector('[data-page="room"]');
    page.once('dialog', (d) => void d.accept());
    await page.click('button:has-text("Remove project")');
    await page.waitForSelector('text=Not removed');
    expect(await page.textContent('[data-page="room"]')).toMatch(/archive it instead/i);
  });
});

describe('responsive: Manual QA at 360 px', () => {
  it('no horizontal page scroll on any tab, with a test case open', async () => {
    const ctx = await browser.newContext({ viewport: { width: 360, height: 740 }, deviceScaleFactor: 2 });
    const mp = await ctx.newPage();
    await mp.goto(env.createLaunchUrl());
    await mp.waitForSelector('[data-page="overview"]');
    for (const tab of ['requirements', 'test-cases', 'traceability'] as const) {
      await openManual(tab, mp);
      if (tab === 'test-cases') {
        await mp.click('tr[data-tc="TC-0001"]');
        await mp.waitForSelector('[data-tc-detail="TC-0001"]');
      }
      if (tab === 'requirements') {
        await mp.click('tr[data-req="REQ-2"]');
        await mp.waitForSelector('[data-req-detail="REQ-2"]');
      }
      await mp.waitForTimeout(250);
      const m = await mp.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: window.innerWidth }));
      expect(m.sw, `${tab} scrollWidth ${m.sw} > ${m.iw}`).toBeLessThanOrEqual(m.iw);
      await shot(`qa-mobile-${tab}.png`, mp);
    }
    await ctx.close();
  });
});
