/**
 * Demo mode: a disposable, clearly fictional data set so the office can be previewed without running Claude Code.
 *  - lives ONLY in its own data directory ("QA Virtual Office Demo") and database; the real one is never touched
 *  - robot statuses come from the real status machine (synthetic hook events through the normal pipeline)
 *  - QA records are created through the real services, so every rule (human-only approval etc.) is exercised
 *  - the UI shows a permanent DEMO DATA banner and the server refuses to change the real Claude settings
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { APP_DIR_NAME } from './dataDir.ts';
import type { Broadcast } from './collector.ts';
import { ingest } from './collector.ts';
import type { DB } from './db/index.ts';
import * as qa from './qa.ts';
import * as df from './qaDefects.ts';
import * as ex from './qaExec.ts';
import * as wk from './qaWork.ts';
import { createProject, setSetting, updateRobot } from './store.ts';

export const DEMO_DIR_NAME = `${APP_DIR_NAME} Demo`;
export const DEMO_DEFAULT_PORT = 47822;
export const DEMO_BANNER = 'DEMO DATA: made-up, not your real work. Nothing here comes from Claude Code, and your Claude settings are never touched.';

export function defaultDemoDir(): string {
  if (process.env.QAVO_DATA_DIR) return process.env.QAVO_DATA_DIR;
  const base = process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local');
  return path.join(base, DEMO_DIR_NAME);
}

/** The demo directory must never be the real data directory. */
export function assertNotRealDataDir(dir: string, realDir: string) {
  const norm = (p: string) => path.resolve(p).toLowerCase();
  if (norm(dir) === norm(realDir)) throw new Error('Refusing to run demo mode in the real data directory');
}

/** Delete the previous demo database (the demo is rebuilt fresh on every start). Only demo files are touched. */
export function resetDemoFiles(dir: string) {
  for (const f of ['data.db', 'data.db-wal', 'data.db-shm', 'spool.jsonl']) fs.rmSync(path.join(dir, f), { force: true });
  fs.rmSync(path.join(dir, 'evidence'), { recursive: true, force: true });
  fs.rmSync(path.join(dir, 'demo-projects'), { recursive: true, force: true });
}

const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();

interface SessionPlan {
  id: string;
  project: 'shop' | 'api';
  name: string;
  type: string;
  startedMinAgo: number;
  steps: Array<[string, Record<string, unknown>?]>;
}

export function seedDemo(db: DB, dir: string, broadcast: Broadcast = () => undefined): { projects: number; sessions: number } {
  setSetting(db, 'demo', true);
  const mk = (alias: string, folder: string, type: string) => {
    const p = path.join(dir, 'demo-projects', folder);
    fs.mkdirSync(p, { recursive: true });
    return createProject(db, { alias, path: p, type }).project.id;
  };
  const shop = mk('Demo Shop (web)', 'demo-shop', 'web');
  const api = mk('Demo Payments API', 'demo-payments-api', 'api');
  const pid = { shop, api };

  // ------------------------------------------------------------------ robots at work (synthetic hook events, real status machine)
  const sessions: SessionPlan[] = [
    { id: 'demo-s1', project: 'shop', name: 'Nova', type: 'manual_tester', startedMinAgo: 25, steps: [['UserPromptSubmit'], ['PreToolUse', { toolName: 'Read' }]] },
    { id: 'demo-s2', project: 'shop', name: 'Pixel', type: 'qa_analyst', startedMinAgo: 24, steps: [['UserPromptSubmit'], ['PreToolUse', { toolName: 'Write', fileCategory: 'test' }]] },
    { id: 'demo-s3', project: 'shop', name: 'Bolt', type: 'automation_engineer', startedMinAgo: 22, steps: [['UserPromptSubmit'], ['PreToolUse', { toolName: 'Bash', commandCategory: 'test_run' }]] },
    { id: 'demo-s4', project: 'api', name: 'Relay', type: 'api_tester', startedMinAgo: 20, steps: [['UserPromptSubmit'], ['PreToolUse', { toolName: 'Bash', commandCategory: 'test_run' }], ['PostToolUseFailure', { toolName: 'Bash', error: 'Exit code 1' }], ['PreToolUse', { toolName: 'Read' }]] },
    { id: 'demo-s5', project: 'api', name: 'Gatekeeper', type: 'regression_tester', startedMinAgo: 18, steps: [['UserPromptSubmit'], ['PermissionRequest', { toolName: 'Bash' }]] },
    { id: 'demo-s6', project: 'shop', name: 'Sherlock', type: 'bug_investigator', startedMinAgo: 15, steps: [['UserPromptSubmit'], ['Notification', { notificationType: 'elicitation_dialog' }]] },
    { id: 'demo-s7', project: 'api', name: 'Captain QA', type: 'qa_lead', startedMinAgo: 12, steps: [['UserPromptSubmit'], ['PreToolUse', { toolName: 'Read' }], ['Stop']] },
    { id: 'demo-s10', project: 'shop', name: 'Moss', type: 'manual_tester', startedMinAgo: 14, steps: [] },
    { id: 'demo-s11', project: 'api', name: 'Dash', type: 'api_tester', startedMinAgo: 11, steps: [['UserPromptSubmit'], ['PreToolUse', { toolName: 'Read' }], ['Stop']] },
    { id: 'demo-s9', project: 'api', name: 'Rusty', type: 'automation_engineer', startedMinAgo: 9, steps: [['UserPromptSubmit'], ['PreToolUse', { toolName: 'Bash', commandCategory: 'build' }], ['StopFailure', { error: 'rate_limit' }]] },
    { id: 'demo-s8', project: 'shop', name: 'Echo', type: 'manual_tester', startedMinAgo: 40, steps: [['UserPromptSubmit'], ['Stop'], ['SessionEnd', { reason: 'other' }]] },
  ];
  let step = 0;
  const post = (sessionId: string, projectId: string, event: string, extra: Record<string, unknown> | undefined, minAgo: number) => {
    step += 1;
    ingest(db, { v: 1, eventId: crypto.randomUUID(), ts: minutesAgo(minAgo - step * 0.01), sessionId, event, projectId, folderKeys: [], ...extra }, broadcast);
  };
  for (const s of sessions) {
    const projectId = pid[s.project];
    post(s.id, projectId, 'SessionStart', { source: 'startup', model: 'demo-model' }, s.startedMinAgo);
    const robotId = (db.prepare('SELECT robot_id FROM sessions WHERE session_id = ?').get(s.id) as { robot_id: string }).robot_id;
    updateRobot(db, robotId, { name: s.name, robotType: s.type, role: s.type });
    s.steps.forEach(([event, extra], i) => post(s.id, projectId, event!, extra, s.startedMinAgo - 1 - i * 0.5));
  }
  // a helper drone for Bolt
  post('demo-s3', pid.shop, 'SubagentStart', { agentId: 'demo-drone-1', agentType: 'Explore' }, 3);

  seedQa(db, pid.shop);
  return { projects: 2, sessions: sessions.length };
}

function seedQa(db: DB, projectId: string) {
  qa.importRequirements(
    db,
    projectId,
    {
      source: 'Demo Shop BRD v1',
      text: [
        '| ID | Business requirement | Priority |',
        '| --- | --- | --- |',
        '| BR-01 | Visitors can create an account with email and password | Must |',
        '| BR-02 | Customers can check out with a card and get a confirmation | Must |',
        '',
        '**FR-01 Registration** (Guest)',
        '',
        '1. Page /register shows Name, Email and Password.',
        '2. A duplicate email shows "An account with this email already exists."',
        '',
        '**FR-02 Checkout**',
        '',
        '1. A declined card shows "Your payment was declined."',
        '2. The page should load quickly and be user-friendly.',
        '',
        '| ID | Covers | Given | When | Then |',
        '| --- | --- | --- | --- | --- |',
        '| AC-01 | FR-01 | A guest is on /register | They submit valid details | An account is created |',
      ].join('\n'),
    },
    'human',
  );
  qa.runRequirementChecks(db, projectId, 'human');
  const reqId = (ref: string) => (db.prepare('SELECT id FROM requirements WHERE project_id = ? AND ref = ?').get(projectId, ref) as { id: string }).id;
  const mkCase = (title: string, requirementRefs: string[], approve: boolean, steps = ['Open the page', 'Do the action'], expectedResult = 'It works as specified') => {
    const t = qa.createTestCase(db, projectId, { title, steps, expectedResult, requirementIds: requirementRefs.map(reqId), testType: 'positive' }, 'human');
    if (approve) {
      qa.transitionTestCase(db, t.id, 'in_review', '', 'human');
      qa.transitionTestCase(db, t.id, 'approved', 'Looks good', 'human');
    }
    return t;
  };
  const c1 = mkCase('Register with valid details', ['FR-01', 'BR-01'], true, ['Open /register', 'Enter valid details', 'Submit'], 'Account created');
  const c2 = mkCase('Register with an existing email', ['FR-01'], true, ['Open /register', 'Use an existing email'], 'Duplicate message shown');
  const c3 = mkCase('Pay with a declined card', ['FR-02', 'BR-02'], true, ['Add an item', 'Pay with the declined test card'], 'Payment declined message, no order');
  mkCase('Pay with an approved card', ['FR-02'], true);
  qa.createTestCase(db, projectId, { title: 'Checkout page performance', steps: ['Measure load time'], expectedResult: 'Under 3 s', requirementIds: [reqId('FR-02')] }, 'agent');
  const c6 = mkCase('Guest cart survives login', ['BR-02'], false);
  qa.transitionTestCase(db, c6.id, 'in_review', '', 'human');

  const run = ex.createRun(db, projectId, { name: 'Sprint 12 regression', environment: 'staging', build: '1.4.2', addAllApproved: true }, 'human');
  const execs = ex.getRun(db, run.id).executions;
  const byCode = (code: string) => execs.find((e) => e.testCaseCode === code)!;
  ex.setResult(db, byCode(c1.code).id, { status: 'passed', actualResult: 'Account created' }, 'human');
  ex.setResult(db, byCode(c2.code).id, { status: 'passed' }, 'human');
  const failed = byCode(c3.code);
  ex.setResult(db, failed.id, { status: 'failed', note: 'Order was created even though the card was declined', actualResult: 'Order SE-20261122-00042 created' }, 'human');
  ex.addNoteEvidence(db, failed.id, { label: 'Observed', body: 'Banner said "Payment declined" but the cart was emptied.' }, 'human');
  const pending = ex.getRun(db, run.id).executions.find((e) => e.status === 'not_run');
  if (pending) ex.setResult(db, pending.id, { status: 'in_progress' }, 'human');

  const d1 = df.createDefectFromExecution(db, failed.id, { severity: 'critical', priority: 'high' }, 'human');
  df.transitionDefect(db, d1.id, { to: 'open', note: 'Confirmed' }, 'human');
  const d2 = df.createDefect(db, projectId, { title: 'Footer link to Terms returns 404', severity: 'minor', environment: 'staging', build: '1.4.2' }, 'human');
  const d3 = df.createDefect(db, projectId, { title: 'Search ignores upper-case terms (reported by an agent)', severity: 'major' }, 'agent');
  df.transitionDefect(db, d2.id, { to: 'open', note: '' }, 'human');
  df.transitionDefect(db, d2.id, { to: 'in_progress', note: '' }, 'human');
  df.transitionDefect(db, d2.id, { to: 'fixed', note: '' }, 'human');
  df.transitionDefect(db, d2.id, { to: 'retest', note: '' }, 'human');
  df.transitionDefect(db, d2.id, { to: 'closed', note: 'Verified in 1.4.3' }, 'human');
  void d3;

  const s = wk.createSession(db, projectId, { charter: 'Explore checkout with unusual quantities and coupons', area: 'Checkout', tester: 'Nova', timeboxMinutes: 45 }, 'human');
  wk.startSession(db, s.id, 'human');
  wk.addNote(db, s.id, { kind: 'idea', text: 'Try quantity 0, negative and 999' }, 'human');
  wk.addNote(db, s.id, { kind: 'bug', text: 'Total shows NaN when quantity is 0' }, 'human');
  wk.addNote(db, s.id, { kind: 'question', text: 'Should coupons stack with sale prices?' }, 'human');
  wk.createSession(db, projectId, { charter: 'Explore the registration form with long names', area: 'Account', timeboxMinutes: 30 }, 'human');

  const t1 = wk.createTask(db, projectId, { title: 'Write negative tests for registration', kind: 'test_design', priority: 'high', assignee: 'Pixel' }, 'human');
  wk.moveTask(db, t1.id, { to: 'in_progress' }, 'human');
  const t2 = wk.createTask(db, projectId, { title: 'Retest DEF-001 after the fix', kind: 'retest', priority: 'critical', defectId: d1.id }, 'human');
  wk.moveTask(db, t2.id, { to: 'blocked', note: 'Waiting for build 1.4.3' }, 'human');
  wk.createTask(db, projectId, { title: 'Review agent-drafted checkout test cases', kind: 'review', priority: 'medium' }, 'agent');
  const t4 = wk.createTask(db, projectId, { title: 'Set up the staging test accounts', kind: 'other', priority: 'low' }, 'human');
  wk.moveTask(db, t4.id, { to: 'completed' }, 'human');
}
