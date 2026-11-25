import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { COOKIE_NAME } from '../src/auth.ts';
import { readAgentToken } from '../src/dataDir.ts';
import * as qa from '../src/qa.ts';
import * as sc from '../src/qaScripts.ts';
import { makeEnv, uiHeaders, type TestEnv } from './helpers.ts';

let env: TestEnv;
let cookie: string;
let pid: string;
let launches: Array<{ run?: { configPath: string; runId: string } }>;

beforeEach(async () => {
  launches = [];
  env = await makeEnv({ listen: true, auth: true, launchClaude: (_c, run) => launches.push({ run }) });
  cookie = `${COOKIE_NAME}=${env.auth.issueSession()}`;
  const dir = path.join(env.root, 'DemoShop');
  fs.mkdirSync(dir);
  pid = (await ui('POST', '/api/projects', { alias: 'Demo Shop', path: dir })).body.project.id as string;
  await ui('PUT', '/api/settings/agent', { enabled: true, confirm: true });
});
afterEach(async () => env.cleanup());

async function ui(method: string, url: string, payload?: unknown) {
  const r = await env.app.inject({ method: method as 'GET', url, headers: { ...uiHeaders(env), cookie }, payload: payload as object });
  return { status: r.statusCode, body: r.body ? r.json() : null };
}
async function tool(token: string | null, name: string, args: unknown) {
  const headers = token ? { 'x-qavo-run-token': token } : { 'x-qavo-agent-token': readAgentToken(env.paths) };
  const r = await env.app.inject({ method: 'POST', url: `/api/agent/tools/${name}`, headers: { host: env.host, 'content-type': 'application/json', ...headers }, payload: args as object });
  return { status: r.statusCode, body: r.body ? r.json() : null };
}
async function launch(playbookId: string) {
  const r = await ui('POST', `/api/projects/${pid}/launch-claude`, { confirm: true, playbookId });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  const run = launches[launches.length - 1]!.run!;
  const cfg = JSON.parse(fs.readFileSync(run.configPath, 'utf8')) as { mcpServers: { 'qa-office': { env: { QAVO_RUN_TOKEN: string } } } };
  return { runId: run.runId, token: cfg.mcpServers['qa-office'].env.QAVO_RUN_TOKEN };
}
/** An APPROVED test case (a person approved it) and a draft one. */
function testCases() {
  const approved = qa.createTestCase(env.db, pid, { title: 'Add to cart', steps: ['a'], expectedResult: 'b' }, 'human');
  env.db.prepare("UPDATE test_cases SET status = 'approved', approved_by = 'human', approved_at = ? WHERE id = ?").run(new Date().toISOString(), approved.id);
  const draft = qa.createTestCase(env.db, pid, { title: 'Remove from cart', steps: ['a'], expectedResult: 'b' }, 'human');
  return { approved, draft };
}
const script = (extra: object = {}) => ({ project: 'Demo Shop', title: 'Add to cart (UI)', framework: 'playwright', testCaseCode: 'TC-0001', content: "test('adds', async ({ page }) => { await page.goto(process.env.BASE_URL!); });", notes: 'Run with npx playwright test', ...extra });
const scriptsUi = async () => (await ui('GET', `/api/projects/${pid}/automation/scripts`)).body as Array<{ id: string; code: string; status: string; draftedBy: string; review: null | { verdict: string; by: string; current: boolean } }>;

describe('the Automation Writer (Axel) writes script drafts', () => {
  it('creates a draft for an approved test case, attributed to Axel; it is only text and a draft', async () => {
    testCases();
    const axel = await launch('automation_writer');
    const r = await tool(axel.token, 'qa_create_automation_script', script());
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.result).toMatchObject({ code: 'AS-001', status: 'draft', version: 1, masked: false });
    const [s] = await scriptsUi();
    expect(s).toMatchObject({ code: 'AS-001', status: 'draft', draftedBy: 'Axel', review: null });
    const d = (await ui('GET', `/api/automation/scripts/${s!.id}`)).body;
    expect(d.content).toContain('page.goto');
    expect(d.testCaseCode).toBe('TC-0001');
  });

  it('refuses a test case that is not approved, an unknown one, and a missing identity (the shared agent token)', async () => {
    testCases();
    const axel = await launch('automation_writer');
    expect((await tool(axel.token, 'qa_create_automation_script', script({ testCaseCode: 'TC-0002' }))).body.error).toBe('test_case_not_approved');
    expect((await tool(axel.token, 'qa_create_automation_script', script({ testCaseCode: 'TC-0099' }))).body.error).toBe('test_case_not_found');
    expect((await tool(axel.token, 'qa_create_automation_script', script({ framework: 'cobol' }))).status).toBe(400);
    const shared = await tool(null, 'qa_create_automation_script', script());
    expect(shared.status).toBe(403);
    expect(shared.body.error).toBe('identity_required');
    expect(await scriptsUi()).toEqual([]);
  });

  it('masks secrets and personal data in the text, and says so', async () => {
    testCases();
    const axel = await launch('automation_writer');
    const r = await tool(axel.token, 'qa_create_automation_script', script({ content: "const token = 'Bearer abcdefghijklmnopqrstuvwxyz123456'; login('bob@example.com');" }));
    expect(r.body.result.masked).toBe(true);
    const [s] = await scriptsUi();
    const d = (await ui('GET', `/api/automation/scripts/${s!.id}`)).body;
    expect(d.content).not.toMatch(/abcdefghijklmnopqrstuvwxyz123456|bob@example\.com/);
  });

  it('only the roles that should have these tools can use them', async () => {
    testCases();
    const quinn = await launch('case_writer');
    const rhea = await launch('case_reviewer');
    const axel = await launch('automation_writer');
    const vera = await launch('automation_reviewer');
    expect((await tool(quinn.token, 'qa_create_automation_script', script())).body.error).toBe('tool_not_allowed');
    expect((await tool(rhea.token, 'qa_review_automation_script', { project: 'Demo Shop', code: 'AS-001', verdict: 'recommend_approve' })).body.error).toBe('tool_not_allowed');
    expect((await tool(vera.token, 'qa_create_automation_script', script())).body.error).toBe('tool_not_allowed');
    expect((await tool(axel.token, 'qa_review_automation_script', { project: 'Demo Shop', code: 'AS-001', verdict: 'recommend_approve' })).body.error).toBe('tool_not_allowed');
    // and Axel and Vera cannot touch manual test case drafts or reviews
    expect((await tool(axel.token, 'qa_create_test_case_draft', { project: 'Demo Shop', title: 'x', steps: ['a'], expectedResult: 'b' })).body.error).toBe('tool_not_allowed');
    expect((await tool(vera.token, 'qa_review_test_case', { project: 'Demo Shop', code: 'TC-0002', verdict: 'recommend_approve' })).body.error).toBe('tool_not_allowed');
  });

  it('cannot approve, reject or decide anything: no such tool exists, and the person-only route refuses agents', async () => {
    testCases();
    const axel = await launch('automation_writer');
    await tool(axel.token, 'qa_create_automation_script', script());
    const [s] = await scriptsUi();
    for (const name of ['qa_approve_automation_script', 'qa_decide_automation_script', 'qa_run_automation_script']) expect((await tool(axel.token, name, { project: 'Demo Shop', code: 'AS-001' })).status).toBe(404);
    const attempt = (headers: Record<string, string>) => env.app.inject({ method: 'POST', url: `/api/automation/scripts/${s!.id}/decision`, headers: { ...headers, 'content-type': 'application/json' }, payload: { to: 'approved' } });
    expect((await attempt({ host: env.host, 'x-qavo-run-token': axel.token })).statusCode).toBeGreaterThanOrEqual(400);
    expect((await attempt({ host: env.host, 'x-qavo-agent-token': readAgentToken(env.paths) })).statusCode).toBeGreaterThanOrEqual(400);
    expect((await attempt({ ...uiHeaders(env) })).statusCode).toBe(401);
    expect(() => sc.decideScript(env.db, s!.id, { to: 'approved' }, 'agent')).toThrow(/Only a person/);
    expect((await scriptsUi())[0]!.status).toBe('draft');
  });
});

describe('the Automation Reviewer (Vera) reviews, and a different agent than the writer', () => {
  it('lists what it may review, records a recommendation, and the status stays a draft', async () => {
    testCases();
    const axel = await launch('automation_writer');
    const vera = await launch('automation_reviewer');
    await tool(axel.token, 'qa_create_automation_script', script());
    expect((await tool(vera.token, 'qa_list_scripts_to_review', { project: 'Demo Shop' })).body.result.items).toEqual([expect.objectContaining({ code: 'AS-001', draftedBy: 'Axel', reason: 'not_reviewed' })]);
    expect((await tool(vera.token, 'qa_get_automation_script', { project: 'Demo Shop', code: 'AS-001' })).body.result.content).toContain('page.goto');
    const r = await tool(vera.token, 'qa_review_automation_script', { project: 'Demo Shop', code: 'AS-001', verdict: 'recommend_approve', notes: 'Stable and repeatable.' });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.result).toMatchObject({ verdict: 'recommend_approve', reviewer: 'Vera', status: 'draft' });
    expect((await scriptsUi())[0]).toMatchObject({ status: 'draft', review: { verdict: 'recommend_approve', by: 'Vera', current: true } });
    expect((await tool(vera.token, 'qa_list_scripts_to_review', { project: 'Demo Shop' })).body.result.items).toEqual([]);
  });

  it('changes need notes; a revision makes the review outdated and returns it to the reviewer with the writer’s reply', async () => {
    testCases();
    const axel = await launch('automation_writer');
    const vera = await launch('automation_reviewer');
    await tool(axel.token, 'qa_create_automation_script', script({ content: 'await page.waitForTimeout(5000);' }));
    expect((await tool(vera.token, 'qa_review_automation_script', { project: 'Demo Shop', code: 'AS-001', verdict: 'changes_requested' })).body.error).toBe('notes_required');
    await tool(vera.token, 'qa_review_automation_script', { project: 'Demo Shop', code: 'AS-001', verdict: 'changes_requested', notes: 'Replace the fixed sleep with a wait for the cart badge.' });
    const mine = (await tool(axel.token, 'qa_list_my_script_changes', { project: 'Demo Shop' })).body.result.items;
    expect(mine).toEqual([expect.objectContaining({ code: 'AS-001', reviewer: 'Vera', notes: expect.stringContaining('fixed sleep') })]);
    const rev = await tool(axel.token, 'qa_revise_automation_script', { project: 'Demo Shop', code: 'AS-001', content: "await expect(page.getByTestId('cart-badge')).toHaveText('1');", replyToReviewer: 'Replaced the sleep with an assertion.' });
    expect(rev.body.result).toMatchObject({ version: 2, replied: true });
    expect((await scriptsUi())[0]!.review).toMatchObject({ current: false });
    expect((await tool(axel.token, 'qa_list_my_script_changes', { project: 'Demo Shop' })).body.result.items).toEqual([]);
    expect((await tool(vera.token, 'qa_list_scripts_to_review', { project: 'Demo Shop' })).body.result.items).toEqual([expect.objectContaining({ code: 'AS-001', reason: 'revised_since_review', writerReply: 'Replaced the sleep with an assertion.' })]);
  });

  it('a reviewer never reviews its own work: refused by the service and by the database, even for a renamed or second run', async () => {
    testCases();
    const axel = await launch('automation_writer');
    await tool(axel.token, 'qa_create_automation_script', script());
    // Axel has no review tool at all
    expect((await tool(axel.token, 'qa_review_automation_script', { project: 'Demo Shop', code: 'AS-001', verdict: 'recommend_approve' })).body.error).toBe('tool_not_allowed');
    // the service refuses a reviewer whose NAME is the writer's (the playbooks cannot share a name, so simulate by direct call)
    const s = (await scriptsUi())[0]!;
    const vera = await launch('automation_reviewer');
    env.db.prepare("UPDATE automation_scripts SET drafted_by_name = 'Vera' WHERE id = ?").run(s.id);
    expect((await tool(vera.token, 'qa_review_automation_script', { project: 'Demo Shop', code: 'AS-001', verdict: 'recommend_approve' })).body.error).toBe('own_work');
    // and the database trigger refuses it even if the service were bypassed
    expect(() =>
      env.db.prepare("INSERT INTO automation_script_reviews (id, script_id, run_id, reviewer_name, verdict, notes, script_hash, created_at) VALUES ('x', ?, ?, 'Vera', 'recommend_approve', '', ?, ?)").run(s.id, vera.runId, 'a'.repeat(64), new Date().toISOString()),
    ).toThrow(/cannot review its own work/);
    // identity trigger: a name that is not the launched agent's
    env.db.prepare("UPDATE automation_scripts SET drafted_by_name = 'Axel' WHERE id = ?").run(s.id);
    expect(() =>
      env.db.prepare("INSERT INTO automation_script_reviews (id, script_id, run_id, reviewer_name, verdict, notes, script_hash, created_at) VALUES ('y', ?, ?, 'Somebody', 'recommend_approve', '', ?, ?)").run(s.id, vera.runId, 'a'.repeat(64), new Date().toISOString()),
    ).toThrow(/launched agent/);
  });

  it('reviews are append-only', async () => {
    testCases();
    const axel = await launch('automation_writer');
    const vera = await launch('automation_reviewer');
    await tool(axel.token, 'qa_create_automation_script', script());
    await tool(vera.token, 'qa_review_automation_script', { project: 'Demo Shop', code: 'AS-001', verdict: 'recommend_approve' });
    expect(() => env.db.prepare("UPDATE automation_script_reviews SET verdict = 'changes_requested', notes = 'x'").run()).toThrow(/append-only/);
    expect(() => env.db.prepare('DELETE FROM automation_script_reviews').run()).toThrow(/append-only/);
  });
});

describe('a person decides', () => {
  it('approves or rejects (reject needs a reason); a decided script is frozen; the database also refuses a non-human decision', async () => {
    testCases();
    const axel = await launch('automation_writer');
    await tool(axel.token, 'qa_create_automation_script', script());
    await tool(axel.token, 'qa_create_automation_script', script({ title: 'Second' }));
    const [second, first] = await scriptsUi();
    expect((await ui('POST', `/api/automation/scripts/${first!.id}/decision`, { to: 'rejected' })).body.error).toBe('note_required');
    const ok = await ui('POST', `/api/automation/scripts/${first!.id}/decision`, { to: 'approved' });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ status: 'approved', decidedAt: expect.any(String) });
    expect((await ui('POST', `/api/automation/scripts/${first!.id}/decision`, { to: 'rejected', note: 'x' })).body.error).toBe('already_decided');
    expect((await tool(axel.token, 'qa_revise_automation_script', { project: 'Demo Shop', code: 'AS-001', content: 'changed' })).body.error).toBe('not_a_draft');
    expect(() => env.db.prepare("UPDATE automation_scripts SET content = 'sneaky' WHERE id = ?").run(first!.id)).toThrow(/can no longer change/);
    expect((await ui('POST', `/api/automation/scripts/${second!.id}/decision`, { to: 'rejected', note: 'Does not match the framework' })).body).toMatchObject({ status: 'rejected', decisionNote: 'Does not match the framework' });
    // the database itself refuses a decision that is not a person's
    expect(() => env.db.prepare("UPDATE automation_scripts SET status = 'approved', decided_by = 'agent', decided_at = ? WHERE id = ?").run(new Date().toISOString(), second!.id)).toThrow();
    const fresh = await launch('automation_writer');
    await tool(fresh.token, 'qa_create_automation_script', script({ title: 'Third' }));
    const third = (await scriptsUi())[0]!;
    expect(() => env.db.prepare("UPDATE automation_scripts SET status = 'approved' WHERE id = ?").run(third.id)).toThrow(); // no decided_by / decided_at
  });

  it('an agent can revise only its own script', async () => {
    testCases();
    const axel = await launch('automation_writer');
    await tool(axel.token, 'qa_create_automation_script', script());
    const s = (await scriptsUi())[0]!;
    env.db.prepare("UPDATE automation_scripts SET drafted_by_name = 'Someone else' WHERE id = ?").run(s.id);
    expect((await tool(axel.token, 'qa_revise_automation_script', { project: 'Demo Shop', code: 'AS-001', title: 'mine now' })).body.error).toBe('not_your_draft');
  });

  it('a project with scripts cannot be removed (archive instead)', async () => {
    testCases();
    const axel = await launch('automation_writer');
    await tool(axel.token, 'qa_create_automation_script', script());
    const r = await ui('DELETE', `/api/projects/${pid}`);
    expect(r.status).toBe(409);
  });
});
