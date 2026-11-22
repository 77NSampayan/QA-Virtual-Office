import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import WebSocket from 'ws';
import { COOKIE_NAME } from '../src/auth.ts';
import { makeEnv, uiHeaders, type TestEnv } from './helpers.ts';

let env: TestEnv;
let pid: string;
let cookie: string;

beforeEach(async () => {
  env = await makeEnv({ listen: true, auth: true });
  cookie = `${COOKIE_NAME}=${env.auth.issueSession()}`;
  const dir = path.join(env.root, 'QaProject');
  fs.mkdirSync(dir);
  pid = (await call('POST', '/api/projects', { alias: 'QA Project', path: dir })).body.project.id;
});
afterEach(async () => env.cleanup());

async function call(method: string, url: string, payload?: unknown, headers: Record<string, string> = {}) {
  const r = await env.app.inject({ method: method as 'GET', url, headers: { ...uiHeaders(env), cookie, ...headers }, payload: payload as object });
  return { status: r.statusCode, body: r.body ? r.json() : null, raw: r.body };
}
const goodCase = (extra: object = {}) => ({ title: 'Sign in works', steps: ['Open page', 'Sign in'], expectedResult: 'Dashboard shown', ...extra });

describe('QA API: access control', () => {
  it('every QA route needs the signed-in session', async () => {
    for (const [m, u] of [
      ['GET', `/api/projects/${pid}/requirements`],
      ['GET', `/api/projects/${pid}/test-cases`],
      ['GET', `/api/projects/${pid}/traceability`],
      ['GET', '/api/qa/summary'],
      ['POST', `/api/projects/${pid}/requirements`],
      ['POST', '/api/test-cases/x/transition'],
    ] as const) {
      const r = await env.app.inject({ method: m, url: u, headers: { host: env.host, origin: env.origin, 'x-qavo-client': '1' }, payload: m === 'POST' ? {} : undefined });
      expect(r.statusCode, `${m} ${u}`).toBe(401);
    }
  });
  it('mutations need the CSRF header', async () => {
    const r = await env.app.inject({ method: 'POST', url: `/api/projects/${pid}/requirements`, headers: { host: env.host, origin: env.origin, cookie }, payload: { ref: 'R', title: 't' } });
    expect(r.statusCode).toBe(403);
  });
});

describe('QA API: requirements', () => {
  it('create, list, get, update, flag, resolve, delete with proper status codes', async () => {
    const c = await call('POST', `/api/projects/${pid}/requirements`, { ref: 'REQ-1', title: 'Lockout', text: 'Lock after 5 failures.', kind: 'brd' });
    expect(c.status).toBe(201);
    const id = c.body.id;
    expect((await call('POST', `/api/projects/${pid}/requirements`, { ref: 'req-1', title: 'dup' })).status).toBe(409);
    expect((await call('POST', `/api/projects/${pid}/requirements`, { ref: '', title: 'x' })).body.error).toBe('invalid_input');
    expect((await call('GET', `/api/projects/${pid}/requirements`)).body).toHaveLength(1);
    expect((await call('PATCH', `/api/requirements/${id}`, { reviewStatus: 'reviewed' })).body.reviewStatus).toBe('reviewed');
    const f = await call('POST', `/api/requirements/${id}/flags`, { type: 'gap', note: 'What about admins?' });
    expect(f.status).toBe(201);
    expect((await call('GET', `/api/requirements/${id}`)).body.flags).toHaveLength(1);
    expect((await call('PATCH', `/api/flags/${f.body.id}`, { status: 'resolved', note: 'ok' })).body.status).toBe('resolved');
    expect((await call('PATCH', `/api/flags/${f.body.id}`, { status: 'dismissed' })).status).toBe(409); // already closed
    expect((await call('DELETE', `/api/requirements/${id}`)).body).toEqual({ ok: true });
    expect((await call('GET', `/api/requirements/${id}`)).status).toBe(404);
    expect((await call('GET', '/api/requirements/req_nope')).status).toBe(404);
  });

  it('import (dry run, then real) and automatic checks', async () => {
    const text = 'REQ-1: The system shall sign users in.\nREQ-2: The app should be user-friendly and fast.';
    const dry = await call('POST', `/api/projects/${pid}/requirements/import`, { text, dryRun: true, source: 'BRD v1', kind: 'brd' });
    expect(dry.body.wouldCreate).toEqual(['REQ-1', 'REQ-2']);
    expect((await call('GET', `/api/projects/${pid}/requirements`)).body).toHaveLength(0);
    const real = await call('POST', `/api/projects/${pid}/requirements/import`, { text, source: 'BRD v1', kind: 'brd' });
    expect(real.body.created).toEqual(['REQ-1', 'REQ-2']);
    expect((await call('POST', `/api/projects/${pid}/requirements/import`, { text: '   ' })).status).toBe(400);
    const checks = await call('POST', `/api/projects/${pid}/requirements/checks`);
    expect(checks.body.raised).toBeGreaterThanOrEqual(2);
    const list = (await call('GET', `/api/projects/${pid}/requirements`)).body as Array<{ ref: string; openFlags: number }>;
    expect(list.find((r) => r.ref === 'REQ-1')!.openFlags).toBe(0);
    expect(list.find((r) => r.ref === 'REQ-2')!.openFlags).toBeGreaterThanOrEqual(2);
  });
});

describe('QA API: test cases and the approval workflow', () => {
  it('create -> review -> approve over HTTP; every step is in the history; traceability follows', async () => {
    const r = (await call('POST', `/api/projects/${pid}/requirements`, { ref: 'REQ-1', title: 'Sign in' })).body;
    const c = await call('POST', `/api/projects/${pid}/test-cases`, goodCase({ requirementIds: [r.id], testType: 'positive', priority: 'high' }));
    expect(c.status).toBe(201);
    expect(c.body).toMatchObject({ code: 'TC-0001', status: 'draft', authoredBy: 'human' });
    const id = c.body.id;
    expect((await call('POST', `/api/test-cases/${id}/transition`, { to: 'approved' })).status).toBe(409);
    expect((await call('POST', `/api/test-cases/${id}/transition`, { to: 'in_review' })).body.status).toBe('in_review');
    expect((await call('POST', `/api/test-cases/${id}/transition`, { to: 'approved', note: 'Good' })).body).toMatchObject({ status: 'approved', approvedBy: 'human' });
    const detail = (await call('GET', `/api/test-cases/${id}`)).body;
    expect(detail.history.map((h: { action: string }) => h.action)).toEqual(['created', 'transition', 'transition']);
    expect(detail.requirements.map((x: { ref: string }) => x.ref)).toEqual(['REQ-1']);
    const t = (await call('GET', `/api/projects/${pid}/traceability`)).body;
    expect(t.summary.requirementsWithApprovedTestCase).toEqual({ numerator: 1, denominator: 1, percent: 100 });
    expect((await call('GET', '/api/qa/summary')).body).toMatchObject({ requirements: 1, testCases: 1, testCasesAwaitingReview: 0 });
  });

  it('error mapping: validation 400, missing approval content 422, bad status 400/409, not found 404', async () => {
    expect((await call('POST', `/api/projects/${pid}/test-cases`, { title: '' })).status).toBe(400);
    expect((await call('POST', `/api/projects/${pid}/test-cases`, goodCase({ status: 'approved' }))).status).toBe(400);
    expect((await call('POST', '/api/projects/proj_nope/test-cases', goodCase())).status).toBe(404);
    const bare = (await call('POST', `/api/projects/${pid}/test-cases`, { title: 'Bare' })).body;
    await call('POST', `/api/test-cases/${bare.id}/transition`, { to: 'in_review' });
    const refused = await call('POST', `/api/test-cases/${bare.id}/transition`, { to: 'approved' });
    expect(refused.status).toBe(422);
    expect(refused.body.message).toBe('steps_required,expected_result_required');
    expect((await call('POST', `/api/test-cases/${bare.id}/transition`, { to: 'bogus' })).status).toBe(400);
    expect((await call('POST', `/api/test-cases/${bare.id}/transition`, {})).status).toBe(400);
    expect((await call('POST', `/api/test-cases/${bare.id}/transition`, { to: 'rejected' })).body.error).toBe('note_required');
    expect((await call('GET', '/api/test-cases/tc_nope')).status).toBe(404);
  });

  it('PATCH edits content (never status), archive hides from the default list, filters work over HTTP', async () => {
    const a = (await call('POST', `/api/projects/${pid}/test-cases`, goodCase({ title: 'Alpha login', testType: 'negative' }))).body;
    const b = (await call('POST', `/api/projects/${pid}/test-cases`, goodCase({ title: 'Beta export' }))).body;
    expect((await call('PATCH', `/api/test-cases/${a.id}`, { title: 'Alpha login (renamed)' })).body.title).toBe('Alpha login (renamed)');
    expect((await call('PATCH', `/api/test-cases/${a.id}`, { status: 'approved' })).status).toBe(400);
    await call('POST', `/api/test-cases/${b.id}/archive`, { archived: true });
    expect(((await call('GET', `/api/projects/${pid}/test-cases`)).body as unknown[]).length).toBe(1);
    expect(((await call('GET', `/api/projects/${pid}/test-cases?includeArchived=true`)).body as unknown[]).length).toBe(2);
    expect(((await call('GET', `/api/projects/${pid}/test-cases?testType=negative`)).body as unknown[]).length).toBe(1);
    expect(((await call('GET', `/api/projects/${pid}/test-cases?q=renamed`)).body as unknown[]).length).toBe(1);
    expect(((await call('GET', `/api/projects/${pid}/test-cases?q=%25`)).body as unknown[]).length).toBe(0); // % is not a wildcard
    expect((await call('POST', `/api/test-cases/${b.id}/archive`, { archived: false })).body.archived).toBe(false);
  });
});

describe('QA API: safety and live updates', () => {
  it('removing a project that holds QA records is refused with a clear message; archiving works', async () => {
    await call('POST', `/api/projects/${pid}/requirements`, { ref: 'R-1', title: 'x' });
    const r = await call('DELETE', `/api/projects/${pid}`);
    expect(r.status).toBe(409);
    expect(r.body.error).toBe('project_has_qa_data');
    expect(r.body.message).toMatch(/archive/i);
    expect((await call('PATCH', `/api/projects/${pid}`, { archived: true })).body.project.archived).toBe(true);
    expect(((await call('GET', `/api/projects/${pid}/requirements`)).body as unknown[]).length).toBe(1);
  });

  it('QA changes are broadcast so open screens refresh', async () => {
    const seen: Array<{ type: string; entity?: string; projectId?: string }> = [];
    const ws = new WebSocket(`ws://127.0.0.1:${env.port}/ws`, { origin: env.origin, headers: { cookie } });
    await new Promise((r) => ws.once('message', r));
    ws.on('message', (d) => seen.push(JSON.parse(String(d))));
    await call('POST', `/api/projects/${pid}/requirements`, { ref: 'R-9', title: 'x' });
    await call('POST', `/api/projects/${pid}/test-cases`, goodCase());
    await new Promise((r) => setTimeout(r, 150));
    ws.close();
    expect(seen.filter((m) => m.type === 'qa.changed').map((m) => m.entity)).toEqual(['requirement', 'test_case']);
    expect(seen.every((m) => m.type !== 'qa.changed' || m.projectId === pid)).toBe(true);
  });

  it('HTTP clients cannot choose their actor: authorship is always the human user', async () => {
    const c = (await call('POST', `/api/projects/${pid}/test-cases`, goodCase(), { 'x-qavo-actor': 'agent' })).body;
    expect(c.authoredBy).toBe('human');
    expect((await call('POST', `/api/projects/${pid}/test-cases`, goodCase({ authoredBy: 'agent' }))).status).toBe(400);
  });
});
