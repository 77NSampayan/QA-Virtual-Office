import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { COOKIE_NAME } from '../src/auth.ts';
import { readAgentToken } from '../src/dataDir.ts';
import { resolveRunToken } from '../src/runs.ts';
import * as qa from '../src/qa.ts';
import { listReviewable, reviewTestCase } from '../src/qaReview.ts';
import { HttpError } from '../src/store.ts';
import { makeEnv, uiHeaders, type TestEnv } from './helpers.ts';

let env: TestEnv;
let cookie: string;
let pid: string;
let otherPid: string;
let launches: Array<{ run?: { configPath: string; runId: string } }>;

beforeEach(async () => {
  launches = [];
  env = await makeEnv({ listen: true, auth: true, launchClaude: (_c, run) => launches.push({ run }) });
  cookie = `${COOKIE_NAME}=${env.auth.issueSession()}`;
  const mk = async (alias: string) => {
    const dir = path.join(env.root, alias.replace(/\s/g, ''));
    fs.mkdirSync(dir);
    return (await ui('POST', '/api/projects', { alias, path: dir })).body.project.id as string;
  };
  pid = await mk('Demo Shop');
  otherPid = await mk('Other Shop');
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
async function launch(playbookId: string, projectId = pid) {
  const r = await ui('POST', `/api/projects/${projectId}/launch-claude`, { confirm: true, playbookId });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  const run = launches[launches.length - 1]!.run!;
  const cfg = JSON.parse(fs.readFileSync(run.configPath, 'utf8')) as { mcpServers: { 'qa-office': { env: { QAVO_RUN_TOKEN: string } } } };
  return { runId: run.runId, token: cfg.mcpServers['qa-office'].env.QAVO_RUN_TOKEN };
}
const draft = (extra: object = {}) => ({ project: 'Demo Shop', title: 'Guest registers', steps: ['Open', 'Submit'], expectedResult: 'Account created', ...extra });
const cases = async () => (await ui('GET', `/api/projects/${pid}/test-cases`)).body as Array<{ id: string; code: string; status: string; approvedBy: string | null; review: null | { verdict: string; by: string; current: boolean; notes: string } }>;
const sql = (q: string, ...a: unknown[]) => env.db.prepare(q).run(...a);

describe('a reviewer agent reviews someone else’s draft', () => {
  it('lists what it may review, records a recommendation, and changes nothing about the test case’s status', async () => {
    const quinn = await launch('case_writer');
    const rhea = await launch('case_reviewer');
    await tool(quinn.token, 'qa_create_test_case_draft', draft());
    const list = (await tool(rhea.token, 'qa_list_my_reviewable', { project: 'Demo Shop' })).body.result.items;
    expect(list).toEqual([expect.objectContaining({ code: 'TC-0001', draftedBy: 'Quinn', reason: 'not_reviewed' })]);

    const r = await tool(rhea.token, 'qa_review_test_case', { project: 'Demo Shop', code: 'TC-0001', verdict: 'recommend_approve', notes: 'Clear steps and a checkable result.' });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.result).toMatchObject({ code: 'TC-0001', verdict: 'recommend_approve', reviewer: 'Rhea', status: 'draft' });
    const [tc] = await cases();
    expect(tc).toMatchObject({ status: 'draft', approvedBy: null, review: { verdict: 'recommend_approve', by: 'Rhea', current: true, notes: 'Clear steps and a checkable result.' } });
    expect((await tool(rhea.token, 'qa_list_my_reviewable', { project: 'Demo Shop' })).body.result.items).toEqual([]); // nothing left to review
    const audit = (await ui('GET', '/api/settings/agent')).body.activity as Array<{ tool: string; agent: string | null }>;
    expect(audit.find((a) => a.tool === 'qa_review_test_case')!.agent).toBe('Rhea (Test Case Reviewer)');
  });

  it('a person can still approve, reject or ignore it: the review is advice, not a gate', async () => {
    const quinn = await launch('case_writer');
    const rhea = await launch('case_reviewer');
    await tool(quinn.token, 'qa_create_test_case_draft', draft());
    await tool(rhea.token, 'qa_review_test_case', { project: 'Demo Shop', code: 'TC-0001', verdict: 'changes_requested', notes: 'Add a cleanup step.' });
    const id = (await cases())[0]!.id;
    expect((await ui('POST', `/api/test-cases/${id}/transition`, { to: 'in_review' })).status).toBe(200);
    expect((await ui('POST', `/api/test-cases/${id}/transition`, { to: 'approved', note: 'fine' })).body).toMatchObject({ status: 'approved', approvedBy: 'human' });
    // an approved case needs no more reviews
    const late = await tool(rhea.token, 'qa_review_test_case', { project: 'Demo Shop', code: 'TC-0001', verdict: 'recommend_approve' });
    expect(late.body.error).toBe('not_reviewable');
  });

  it('shows the writer the notes, an edit makes the review outdated, and it goes back to the reviewer', async () => {
    const quinn = await launch('case_writer');
    const rhea = await launch('case_reviewer');
    await tool(quinn.token, 'qa_create_test_case_draft', draft());
    await tool(rhea.token, 'qa_review_test_case', { project: 'Demo Shop', code: 'TC-0001', verdict: 'changes_requested', notes: 'Add a cleanup step.' });
    const seen = (await tool(quinn.token, 'qa_get_test_case', { project: 'Demo Shop', code: 'TC-0001' })).body.result;
    expect(seen.review).toMatchObject({ verdict: 'changes_requested', by: 'Rhea', notes: 'Add a cleanup step.', current: true });
    expect((await tool(quinn.token, 'qa_list_test_cases', { project: 'Demo Shop' })).body.result.items[0].review).toMatchObject({ verdict: 'changes_requested', current: true });

    await tool(quinn.token, 'qa_update_test_case_draft', { project: 'Demo Shop', code: 'TC-0001', steps: ['Open', 'Submit', 'Delete the account'] });
    expect((await cases())[0]!.review).toMatchObject({ verdict: 'changes_requested', current: false }); // outdated
    expect((await tool(rhea.token, 'qa_list_my_reviewable', { project: 'Demo Shop' })).body.result.items).toEqual([expect.objectContaining({ code: 'TC-0001', reason: 'edited_since_review' })]);
    await tool(rhea.token, 'qa_review_test_case', { project: 'Demo Shop', code: 'TC-0001', verdict: 'recommend_approve' });
    expect((await cases())[0]!.review).toMatchObject({ verdict: 'recommend_approve', current: true }); // the latest review counts
    expect(env.db.prepare('SELECT COUNT(*) AS n FROM agent_reviews').get()).toEqual({ n: 2 }); // both are kept
  });

  it('filters the list by the latest review', async () => {
    const quinn = await launch('case_writer');
    const rhea = await launch('case_reviewer');
    for (const t of ['A', 'B', 'C', 'D']) await tool(quinn.token, 'qa_create_test_case_draft', draft({ title: t }));
    await tool(rhea.token, 'qa_review_test_case', { project: 'Demo Shop', code: 'TC-0001', verdict: 'recommend_approve' });
    await tool(rhea.token, 'qa_review_test_case', { project: 'Demo Shop', code: 'TC-0002', verdict: 'changes_requested', notes: 'x' });
    await tool(rhea.token, 'qa_review_test_case', { project: 'Demo Shop', code: 'TC-0003', verdict: 'recommend_approve' });
    await tool(quinn.token, 'qa_update_test_case_draft', { project: 'Demo Shop', code: 'TC-0003', title: 'C edited' });
    const by = async (review: string) => ((await ui('GET', `/api/projects/${pid}/test-cases?review=${review}`)).body as Array<{ code: string }>).map((t) => t.code);
    expect(await by('recommend_approve')).toEqual(['TC-0001']);
    expect(await by('changes_requested')).toEqual(['TC-0002']);
    expect(await by('outdated')).toEqual(['TC-0003']);
    expect(await by('unreviewed')).toEqual(['TC-0004']);
    expect(await by('nonsense')).toHaveLength(4); // an unknown filter value filters nothing
  });
});

describe('a reviewer is never the writer (service and database)', () => {
  it('refuses a review from the shared token, from a writer, an analyst or a lead, and from another project', async () => {
    const quinn = await launch('case_writer');
    await tool(quinn.token, 'qa_create_test_case_draft', draft());
    const args = { project: 'Demo Shop', code: 'TC-0001', verdict: 'recommend_approve' };
    expect((await tool(null, 'qa_review_test_case', args)).body.error).toBe('identity_required'); // unattributed
    expect((await tool(null, 'qa_list_my_reviewable', { project: 'Demo Shop' })).body.error).toBe('identity_required');
    for (const role of ['case_writer', 'analyst', 'qa_lead', 'bug_investigator']) expect((await tool((await launch(role)).token, 'qa_review_test_case', args)).body.error, role).toBe('tool_not_allowed');
    const rheaOther = await launch('case_reviewer', otherPid);
    expect((await tool(rheaOther.token, 'qa_review_test_case', args)).body.error).toBe('wrong_project');
    expect(env.db.prepare('SELECT COUNT(*) AS n FROM agent_reviews').get()).toEqual({ n: 0 });
  });

  it('refuses a reviewer reviewing its own draft, by run and by name, even through the service directly', async () => {
    const rhea = await launch('case_reviewer');
    const who = resolveRunToken(env.db, rhea.token)!;
    // a draft attributed to Rhea's own run (impossible through the tools, but the service must still refuse)
    const own = qa.createTestCase(env.db, pid, { title: 'Own', steps: ['a'], expectedResult: 'b' }, 'agent', { name: 'Rhea', runId: rhea.runId });
    expect(() => reviewTestCase(env.db, own.id, { verdict: 'recommend_approve' }, who)).toThrow(expect.objectContaining({ code: 'own_work', status: 403 }));
    // a draft by an older run of the same agent name
    const older = qa.createTestCase(env.db, pid, { title: 'Older', steps: ['a'], expectedResult: 'b' }, 'agent', { name: 'rhea', runId: 'run_aaaaaaaaaaaaaaaa' });
    expect(() => reviewTestCase(env.db, older.id, { verdict: 'recommend_approve' }, who)).toThrow(expect.objectContaining({ code: 'own_work' }));
    expect(listReviewable(env.db, who).map((i) => i.code)).toEqual([]);
    expect(env.db.prepare('SELECT COUNT(*) AS n FROM agent_reviews').get()).toEqual({ n: 0 });
  });

  it('names are history: renaming agents cannot make a reviewer the writer of an old draft', async () => {
    const quinn = await launch('case_writer');
    await tool(quinn.token, 'qa_create_test_case_draft', draft()); // drafted by "Quinn"
    await ui('PATCH', '/api/playbooks/case_writer', { agentName: 'Mira' });
    await ui('PATCH', '/api/playbooks/case_reviewer', { agentName: 'Quinn' }); // the reviewer now carries the writer's old name
    const reviewer = await launch('case_reviewer');
    const r = await tool(reviewer.token, 'qa_review_test_case', { project: 'Demo Shop', code: 'TC-0001', verdict: 'recommend_approve' });
    expect(r.status).toBe(403);
    expect(r.body.error).toBe('own_work');
  });

  it('the database itself refuses what the service would have refused (direct inserts)', async () => {
    const quinn = await launch('case_writer');
    const rhea = await launch('case_reviewer');
    await tool(quinn.token, 'qa_create_test_case_draft', draft());
    const tc = (await cases())[0]!.id;
    const insert = (over: Record<string, unknown> = {}) => {
      const v = { id: 'rev_' + crypto.randomBytes(4).toString('hex'), kind: 'test_case', subject: tc, run: rhea.runId, name: 'Rhea', verdict: 'recommend_approve', notes: '', hash: 'a'.repeat(64), at: new Date().toISOString(), ...over };
      return sql('INSERT INTO agent_reviews (id, subject_kind, subject_id, run_id, reviewer_name, verdict, notes, subject_hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', v.id, v.kind, v.subject, v.run, v.name, v.verdict, v.notes, v.hash, v.at);
    };
    expect(() => insert({ run: quinn.runId, name: 'Quinn' })).toThrow(/cannot review its own work/); // the writer's own run
    expect(() => insert({ name: 'quinn' })).toThrow(/identity|own work/); // a name that is not the run's agent
    expect(() => insert({ name: 'Somebody Else' })).toThrow(/launched agent/);
    expect(() => insert({ run: 'run_missing' })).toThrow(/FOREIGN KEY|launched agent/);
    expect(() => insert({ verdict: 'approved' })).toThrow(/CHECK/); // a review cannot claim to approve
    expect(() => insert({ verdict: 'changes_requested', notes: '  ' })).toThrow(/CHECK/);
    expect(() => insert({ hash: 'short' })).toThrow(/CHECK/);
    expect(() => insert({ kind: 'defect' })).toThrow(/CHECK/);
    expect(() => insert({ notes: 'x'.repeat(2001) })).toThrow(/CHECK/);
    // a reviewer run for another project cannot review this project's case
    const rheaOther = await launch('case_reviewer', otherPid);
    expect(() => insert({ run: rheaOther.runId })).toThrow(/own project/);
    expect(() => insert()).not.toThrow(); // the legitimate one is accepted
    expect(env.db.prepare('SELECT COUNT(*) AS n FROM agent_reviews').get()).toEqual({ n: 1 });
    // and it can never be edited or removed
    expect(() => sql("UPDATE agent_reviews SET verdict = 'changes_requested', notes = 'x'")).toThrow(/append-only/);
    expect(() => sql('DELETE FROM agent_reviews')).toThrow(/append-only/);
    // approving is still not something a review can do
    expect(((await cases())[0] as { status: string }).status).toBe('draft');
  });
});

describe('review notes and inputs', () => {
  it('redacts notes, caps them, and refuses missing notes for requested changes and invalid verdicts', async () => {
    const quinn = await launch('case_writer');
    const rhea = await launch('case_reviewer');
    await tool(quinn.token, 'qa_create_test_case_draft', draft());
    const base = { project: 'Demo Shop', code: 'TC-0001' };
    expect((await tool(rhea.token, 'qa_review_test_case', { ...base, verdict: 'changes_requested' })).body.error).toBe('notes_required');
    expect((await tool(rhea.token, 'qa_review_test_case', { ...base, verdict: 'changes_requested', notes: '   ' })).body.error).toBe('notes_required');
    for (const v of ['approved', 'passed', '', 'recommend_approval']) expect((await tool(rhea.token, 'qa_review_test_case', { ...base, verdict: v })).body.error, v).toBe('invalid_input');
    expect((await tool(rhea.token, 'qa_review_test_case', { ...base, verdict: 'recommend_approve', status: 'approved' })).body.error).toBe('invalid_input'); // no extra fields
    expect((await tool(rhea.token, 'qa_review_test_case', { ...base, code: 'TC-9999', verdict: 'recommend_approve' })).body.error).toBe('test_case_not_found');
    expect(env.db.prepare('SELECT COUNT(*) AS n FROM agent_reviews').get()).toEqual({ n: 0 });

    const secret = 'sk-' + 'ant-api03-REVIEWCANARY0123456789abcdef';
    expect((await tool(rhea.token, 'qa_review_test_case', { ...base, verdict: 'changes_requested', notes: 'y'.repeat(2001) })).body.error).toBe('invalid_input'); // over the cap
    const ok = await tool(rhea.token, 'qa_review_test_case', { ...base, verdict: 'changes_requested', notes: `Do not use ${secret} or mail jane.doe@example.com. ` + 'y'.repeat(1800) });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    const stored = env.db.prepare('SELECT notes FROM agent_reviews').get() as { notes: string };
    expect(stored.notes).not.toContain('REVIEWCANARY');
    expect(stored.notes).not.toContain('jane.doe@example.com');
    expect(stored.notes.length).toBeLessThanOrEqual(2000);
    // the same limit is kept by the service itself (a caller that skips the tool schema)
    const who = resolveRunToken(env.db, rhea.token)!;
    const id = (await cases())[0]!.id;
    expect(() => reviewTestCase(env.db, id, { verdict: 'changes_requested', notes: 'z'.repeat(5000) }, who)).toThrow(expect.objectContaining({ code: 'invalid_input' }));
  });

  it('never reviews an archived case, and a revoked reviewer cannot review any more', async () => {
    const quinn = await launch('case_writer');
    const rhea = await launch('case_reviewer');
    await tool(quinn.token, 'qa_create_test_case_draft', draft());
    const id = (await cases())[0]!.id;
    await ui('POST', `/api/test-cases/${id}/archive`, { archived: true });
    expect((await tool(rhea.token, 'qa_review_test_case', { project: 'Demo Shop', code: 'TC-0001', verdict: 'recommend_approve' })).body.error).toBe('archived');
    await ui('POST', `/api/test-cases/${id}/archive`, { archived: false });
    await ui('POST', `/api/runs/${rhea.runId}/revoke`);
    expect((await tool(rhea.token, 'qa_review_test_case', { project: 'Demo Shop', code: 'TC-0001', verdict: 'recommend_approve' })).status).toBe(401);
    expect(env.db.prepare('SELECT COUNT(*) AS n FROM agent_reviews').get()).toEqual({ n: 0 });
  });

  it('a review is not available to people through the API (they approve directly)', async () => {
    expect((await ui('POST', '/api/test-cases/x/review', { verdict: 'recommend_approve' })).status).toBe(404);
    expect(() => reviewTestCase(env.db, 'x', { verdict: 'recommend_approve' }, undefined)).toThrow(HttpError);
  });
});

describe('the writer answers the reviewer (P3b)', () => {
  const rv = (code: string, verdict: string, notes = '') => ({ project: 'Demo Shop', code, verdict, notes });
  const detail = async (code: string) => {
    const id = (await cases()).find((t) => t.code === code)!.id;
    return (await ui('GET', `/api/test-cases/${id}`)).body as { replies: Array<{ by: string; note: string }>; history: Array<{ action: string; actor: string; note: string; changes: Record<string, unknown> }> };
  };

  it('Quinn lists only her own drafts that were sent back, with the notes; fixing one removes it from the list', async () => {
    const quinn = await launch('case_writer');
    const rhea = await launch('case_reviewer');
    for (const title of ['A', 'B', 'C']) await tool(quinn.token, 'qa_create_test_case_draft', draft({ title }));
    await tool(null, 'qa_create_test_case_draft', draft({ title: 'Shared-token draft' })); // not Quinn's
    await tool(rhea.token, 'qa_review_test_case', rv('TC-0001', 'changes_requested', 'Add a cleanup step.'));
    await tool(rhea.token, 'qa_review_test_case', rv('TC-0002', 'recommend_approve'));
    await tool(rhea.token, 'qa_review_test_case', rv('TC-0004', 'changes_requested', 'Not for Quinn.'));
    const mine = async () => (await tool(quinn.token, 'qa_list_my_changes_requested', { project: 'Demo Shop' })).body.result.items as Array<{ code: string; reviewer: string; notes: string }>;
    expect(await mine()).toEqual([expect.objectContaining({ code: 'TC-0001', reviewer: 'Rhea', notes: 'Add a cleanup step.' })]);
    await tool(quinn.token, 'qa_update_test_case_draft', { project: 'Demo Shop', code: 'TC-0001', steps: ['Open', 'Submit', 'Delete the account'] });
    expect(await mine()).toEqual([]); // the review is outdated now: it is Rhea's turn again
  });

  it('only a launched writer may use it', async () => {
    const quinn = await launch('case_writer');
    expect((await tool(null, 'qa_list_my_changes_requested', { project: 'Demo Shop' })).body.error).toBe('identity_required');
    for (const role of ['case_reviewer', 'analyst', 'qa_lead']) expect((await tool((await launch(role)).token, 'qa_list_my_changes_requested', { project: 'Demo Shop' })).body.error, role).toBe('tool_not_allowed');
    expect((await tool(quinn.token, 'qa_list_my_changes_requested', { project: 'Other Shop' })).body.error).toBe('wrong_project');
  });

  it('an edit with a reply saves it with the agent name; the reviewer sees it; a new review closes the conversation', async () => {
    const quinn = await launch('case_writer');
    const rhea = await launch('case_reviewer');
    await tool(quinn.token, 'qa_create_test_case_draft', draft());
    await tool(rhea.token, 'qa_review_test_case', rv('TC-0001', 'changes_requested', 'Add a cleanup step and a negative case.'));
    const note = 'Added the cleanup. I kept negatives in TC-0002, so this one stays positive.';
    const r = await tool(quinn.token, 'qa_update_test_case_draft', { project: 'Demo Shop', code: 'TC-0001', steps: ['Open', 'Submit', 'Delete the account'], replyToReviewer: note });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.result).toMatchObject({ code: 'TC-0001', replied: true });
    const d = await detail('TC-0001');
    expect(d.replies).toEqual([expect.objectContaining({ by: 'Quinn', note })]);
    expect(d.history.find((h) => h.action === 'reply_to_review')).toMatchObject({ actor: 'agent', changes: { by: 'Quinn', reviewBy: 'Rhea' } });
    const items = (await tool(rhea.token, 'qa_list_my_reviewable', { project: 'Demo Shop' })).body.result.items;
    expect(items).toEqual([expect.objectContaining({ code: 'TC-0001', reason: 'edited_since_review', writerReply: expect.stringContaining('kept negatives in TC-0002') })]);
    expect((await tool(rhea.token, 'qa_get_test_case', { project: 'Demo Shop', code: 'TC-0001' })).body.result.replies[0].by).toBe('Quinn');
    await tool(rhea.token, 'qa_review_test_case', rv('TC-0001', 'recommend_approve', 'Fair point on TC-0002.'));
    expect((await detail('TC-0001')).replies).toEqual([]); // earlier replies belong to the earlier review
    expect(((await cases())[0]!.review as { current: boolean }).current).toBe(true);
  });

  it('a reply alone is allowed and does not outdate the review; an empty call, or a reply with no review, is refused', async () => {
    const quinn = await launch('case_writer');
    const rhea = await launch('case_reviewer');
    await tool(quinn.token, 'qa_create_test_case_draft', draft());
    expect((await tool(quinn.token, 'qa_update_test_case_draft', { project: 'Demo Shop', code: 'TC-0001', replyToReviewer: 'Hello?' })).body.error).toBe('no_review_to_reply_to');
    expect((await detail('TC-0001')).history.some((h) => h.action === 'reply_to_review')).toBe(false);
    await tool(rhea.token, 'qa_review_test_case', rv('TC-0001', 'changes_requested', 'Name the account you register.'));
    expect((await tool(quinn.token, 'qa_update_test_case_draft', { project: 'Demo Shop', code: 'TC-0001' })).body.error).toBe('invalid_input');
    const only = await tool(quinn.token, 'qa_update_test_case_draft', { project: 'Demo Shop', code: 'TC-0001', replyToReviewer: 'The account name is in Test data.' });
    expect(only.status).toBe(200);
    expect((await detail('TC-0001')).replies).toHaveLength(1);
    expect(((await cases())[0]!.review as { current: boolean }).current).toBe(true); // an answer is not an edit
  });

  it('replies are redacted and capped, cannot be edited, and only the drafter can write one', async () => {
    const quinn = await launch('case_writer');
    const rhea = await launch('case_reviewer');
    await tool(quinn.token, 'qa_create_test_case_draft', draft());
    await tool(rhea.token, 'qa_review_test_case', rv('TC-0001', 'changes_requested', 'x'));
    const secret = 'sk-' + 'ant-api03-REPLYCANARY0123456789abcdef';
    await tool(quinn.token, 'qa_update_test_case_draft', { project: 'Demo Shop', code: 'TC-0001', replyToReviewer: `Used ${secret} and jane.doe@example.com` });
    const stored = JSON.stringify((await detail('TC-0001')).history);
    expect(stored).not.toContain('REPLYCANARY');
    expect(stored).not.toContain('jane.doe@example.com');
    expect((await tool(quinn.token, 'qa_update_test_case_draft', { project: 'Demo Shop', code: 'TC-0001', replyToReviewer: 'y'.repeat(1001) })).body.error).toBe('invalid_input');
    expect(() => sql("UPDATE test_case_history SET note = 'changed' WHERE action = 'reply_to_review'")).toThrow(/append-only/);
    expect((await tool(rhea.token, 'qa_update_test_case_draft', { project: 'Demo Shop', code: 'TC-0001', replyToReviewer: 'mine' })).body.error).toBe('tool_not_allowed');
    await tool(null, 'qa_create_test_case_draft', draft({ title: 'Shared' }));
    await tool(rhea.token, 'qa_review_test_case', rv('TC-0002', 'changes_requested', 'fix'));
    expect((await tool(quinn.token, 'qa_update_test_case_draft', { project: 'Demo Shop', code: 'TC-0002', replyToReviewer: 'not mine' })).body.error).toBe('not_your_draft');
  });

  it('once a person has moved the case on, the writer cannot edit it any more', async () => {
    const quinn = await launch('case_writer');
    const rhea = await launch('case_reviewer');
    await tool(quinn.token, 'qa_create_test_case_draft', draft());
    await tool(rhea.token, 'qa_review_test_case', rv('TC-0001', 'changes_requested', 'Fix it.'));
    const id = (await cases())[0]!.id;
    await ui('POST', `/api/test-cases/${id}/transition`, { to: 'in_review' });
    expect((await tool(quinn.token, 'qa_update_test_case_draft', { project: 'Demo Shop', code: 'TC-0001', title: 'Late edit' })).body.error).toBe('human_required');
    expect((await cases())[0]!.status).toBe('in_review');
  });
});

describe('handing an old, unnamed agent draft to a writer (a person decides)', () => {
  const rv = (code: string, verdict: string, notes = '') => ({ project: 'Demo Shop', code, verdict, notes });
  const hand = (id: string, playbookId = 'case_writer') => ui('POST', `/api/test-cases/${id}/hand-to-agent`, { playbookId });
  /** A draft written by the shared (unnamed) agent, sent back by Rhea. */
  async function sentBackOldDraft() {
    const quinn = await launch('case_writer');
    const rhea = await launch('case_reviewer');
    await tool(null, 'qa_create_test_case_draft', draft({ title: 'Old draft' }));
    await tool(rhea.token, 'qa_review_test_case', rv('TC-0001', 'changes_requested', 'Add a cleanup step.'));
    return { quinn, rhea, id: (await cases())[0]!.id };
  }

  it('without the hand-over Quinn is told so (and not to recreate it), and cannot edit it', async () => {
    const { quinn } = await sentBackOldDraft();
    const l = (await tool(quinn.token, 'qa_list_my_changes_requested', { project: 'Demo Shop' })).body.result;
    expect(l.items).toEqual([]);
    expect(l.notYours).toBe(1);
    expect(l.note).toMatch(/NOT recreate.*Hand to Quinn/s);
    expect((await tool(quinn.token, 'qa_update_test_case_draft', { project: 'Demo Shop', code: 'TC-0001', title: 'x' })).body.error).toBe('not_your_draft');
  });

  it('after a person hands it over, Quinn lists, fixes and answers it; the review stays valid until she edits', async () => {
    const { quinn, rhea, id } = await sentBackOldDraft();
    const r = await hand(id);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject({ code: 'TC-0001', draftedBy: 'Quinn' });
    const d = (await ui('GET', `/api/test-cases/${id}`)).body;
    expect(d.draftedBy).toBe('Quinn');
    expect(d.review.current).toBe(true); // nothing about the content changed
    expect(d.history.at(-1)).toMatchObject({ action: 'handed_to_agent', actor: 'human', note: 'Handed to Quinn' });
    const l = (await tool(quinn.token, 'qa_list_my_changes_requested', { project: 'Demo Shop' })).body.result;
    expect(l.items).toEqual([expect.objectContaining({ code: 'TC-0001', notes: 'Add a cleanup step.' })]);
    expect(l.notYours).toBe(0);
    const edit = await tool(quinn.token, 'qa_update_test_case_draft', { project: 'Demo Shop', code: 'TC-0001', steps: ['Open', 'Submit', 'Delete the account'], replyToReviewer: 'Added the cleanup step.' });
    expect(edit.status, JSON.stringify(edit.body)).toBe(200);
    expect((await tool(rhea.token, 'qa_list_my_reviewable', { project: 'Demo Shop' })).body.result.items).toEqual([expect.objectContaining({ code: 'TC-0001', reason: 'edited_since_review', writerReply: 'Added the cleanup step.' })]);
  });

  it('only a person can do it, and only for what is safe to hand over', async () => {
    const { id } = await sentBackOldDraft();
    const asAgent = (h: Record<string, string>) => env.app.inject({ method: 'POST', url: `/api/test-cases/${id}/hand-to-agent`, headers: { host: env.host, 'content-type': 'application/json', 'x-qavo-client': '1', ...h }, payload: { playbookId: 'case_writer' } });
    expect((await asAgent({ 'x-qavo-agent-token': readAgentToken(env.paths) })).statusCode).toBeGreaterThanOrEqual(400);
    expect((await asAgent({ 'x-qavo-run-token': (await launch('case_writer')).token })).statusCode).toBeGreaterThanOrEqual(400);
    expect((await asAgent({})).statusCode).toBe(401);
    expect((await cases())[0]).toMatchObject({ code: 'TC-0001' });
    expect(env.db.prepare("SELECT drafted_by_name AS n FROM test_cases WHERE id = ?").get(id)).toEqual({ n: '' }); // still nobody's

    expect((await hand(id, 'case_reviewer')).body.error).toBe('not_a_writer'); // never to a reviewer
    expect((await hand(id, 'analyst')).body.error).toBe('not_a_writer');
    expect((await ui('POST', `/api/test-cases/${id}/hand-to-agent`, {})).body.error).toBe('invalid_input');
    expect((await hand('nope')).body.error).toBe('test_case_not_found');
    expect((await hand(id)).status).toBe(200);
    expect((await hand(id)).body.error).toBe('not_handable'); // already has a drafter
  });

  it('is refused for person-written, named, archived, in-review and approved cases', async () => {
    const quinn = await launch('case_writer');
    const human = (await ui('POST', `/api/projects/${pid}/test-cases`, { title: 'Mine', steps: ['a'], expectedResult: 'b' })).body;
    await tool(quinn.token, 'qa_create_test_case_draft', draft({ title: 'Quinn wrote' }));
    await tool(null, 'qa_create_test_case_draft', draft({ title: 'Old A' }));
    await tool(null, 'qa_create_test_case_draft', draft({ title: 'Old B' }));
    const all = await cases();
    const idOf = (n: number) => all[n]!.id;
    expect((await hand(human.id)).body.error).toBe('not_handable'); // written by the person
    expect((await hand(idOf(1))).body.error).toBe('not_handable'); // already Quinn's
    await ui('POST', `/api/test-cases/${idOf(2)}/archive`, { archived: true });
    expect((await hand(idOf(2))).body.error).toBe('archived');
    await ui('POST', `/api/test-cases/${idOf(3)}/transition`, { to: 'in_review' });
    expect((await hand(idOf(3))).body.error).toBe('not_a_draft');
  });

  it('never makes a reviewer the writer of a case it reviewed (names are history)', async () => {
    const { id } = await sentBackOldDraft(); // reviewed by "Rhea"
    await ui('PATCH', '/api/playbooks/case_reviewer', { agentName: 'Mira' });
    await ui('PATCH', '/api/playbooks/case_writer', { agentName: 'Rhea' }); // the writer now carries the reviewer's old name
    const r = await hand(id);
    expect(r.status).toBe(409);
    expect(r.body.error).toBe('reviewer_conflict');
    expect(env.db.prepare('SELECT drafted_by_name AS n FROM test_cases WHERE id = ?').get(id)).toEqual({ n: '' });
  });

  it('shows a Hand to button in the app only where it applies (checked through the API contract the page uses)', async () => {
    const { id } = await sentBackOldDraft();
    const d = (await ui('GET', `/api/test-cases/${id}`)).body;
    expect(d).toMatchObject({ authoredBy: 'agent', draftedBy: '', status: 'draft', archived: false });
    const pbs = (await ui('GET', '/api/playbooks')).body as Array<{ id: string; kind: string; area: string; available: boolean; agentName: string }>;
    expect(pbs.filter((p) => p.kind === 'writer' && p.area === 'manual' && p.available).map((p) => p.agentName)).toEqual(['Quinn']); // Axel writes scripts, not test cases
  });
});
