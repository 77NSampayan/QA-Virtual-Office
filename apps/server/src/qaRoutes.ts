/**
 * Manual QA HTTP routes (requirements, flags, test cases, traceability).
 * Everything under /api is reached through the signed-in browser or desktop app, so the actor is
 * always the HUMAN user. Agents get their own separate, limited routes in Pass 2D; the service layer
 * enforces the human-only rules regardless of what a route passes.
 */
import type { FastifyInstance } from 'fastify';
import type { Actor } from '@qavo/shared';
import type { Broadcast } from './collector.ts';
import type { DB } from './db/index.ts';
import * as qa from './qa.ts';
import { getPlaybook, listPlaybooks, resetPlaybook, updatePlaybook } from './playbooks.ts';
import { handDraftToWriter } from './qaReview.ts';
import { HttpError } from './store.ts';

const human: Actor = 'human';

export function registerQaRoutes(app: FastifyInstance, deps: { db: DB; broadcast: Broadcast }) {
  const { db, broadcast } = deps;
  const changed = (entity: string, projectId?: string) => broadcast({ type: 'qa.changed', entity, projectId: projectId ?? null });
  const projectOf = (table: 'requirements' | 'test_cases', id: string) =>
    (db.prepare(`SELECT project_id FROM ${table} WHERE id = ?`).get(id) as { project_id: string } | undefined)?.project_id;

  // ---------------------------------------------------------------- agent playbooks (person only: rename, house rules)
  app.get('/api/playbooks', async () => listPlaybooks(db));
  app.patch<{ Params: { id: string }; Body: unknown }>('/api/playbooks/:id', async (req) => {
    const r = updatePlaybook(db, req.params.id, req.body, human);
    changed('playbook');
    return r;
  });
  app.post<{ Params: { id: string } }>('/api/playbooks/:id/reset', async (req) => {
    const r = resetPlaybook(db, req.params.id, human);
    changed('playbook');
    return r;
  });

  // ---------------------------------------------------------------- requirements
  app.get<{ Params: { pid: string } }>('/api/projects/:pid/requirements', async (req) => qa.listRequirements(db, req.params.pid));
  app.post<{ Params: { pid: string }; Body: unknown }>('/api/projects/:pid/requirements', async (req, reply) => {
    const r = qa.createRequirement(db, req.params.pid, req.body, human);
    changed('requirement', req.params.pid);
    return reply.code(201).send(r);
  });
  app.post<{ Params: { pid: string }; Body: unknown }>('/api/projects/:pid/requirements/import', { bodyLimit: 512 * 1024 }, async (req) => {
    const r = qa.importRequirements(db, req.params.pid, req.body, human);
    if (!r.dryRun) changed('requirement', req.params.pid);
    return r;
  });
  app.post<{ Params: { pid: string } }>('/api/projects/:pid/requirements/checks', async (req) => {
    const r = qa.runRequirementChecks(db, req.params.pid, human);
    changed('requirement', req.params.pid);
    return r;
  });
  app.get<{ Params: { id: string } }>('/api/requirements/:id', async (req) => qa.getRequirement(db, req.params.id));
  app.patch<{ Params: { id: string }; Body: unknown }>('/api/requirements/:id', async (req) => {
    const r = qa.updateRequirement(db, req.params.id, req.body, human);
    changed('requirement', r.projectId);
    return r;
  });
  app.delete<{ Params: { id: string } }>('/api/requirements/:id', async (req) => {
    const pid = projectOf('requirements', req.params.id);
    qa.deleteRequirement(db, req.params.id, human);
    changed('requirement', pid);
    return { ok: true };
  });
  app.post<{ Params: { id: string }; Body: unknown }>('/api/requirements/:id/flags', async (req, reply) => {
    const f = qa.raiseFlag(db, req.params.id, req.body, human);
    changed('requirement', projectOf('requirements', req.params.id));
    return reply.code(201).send(f);
  });
  app.patch<{ Params: { id: string }; Body: unknown }>('/api/flags/:id', async (req) => {
    const f = qa.resolveFlag(db, req.params.id, req.body, human);
    changed('requirement', projectOf('requirements', f.requirementId));
    return f;
  });

  // ---------------------------------------------------------------- test cases
  app.get<{
    Params: { pid: string };
    Querystring: { status?: string; testType?: string; priority?: string; requirementId?: string; authoredBy?: string; q?: string; includeArchived?: string; review?: string };
  }>('/api/projects/:pid/test-cases', async (req) =>
    qa.listTestCases(db, { projectId: req.params.pid, ...req.query, includeArchived: req.query.includeArchived === 'true' }),
  );
  app.post<{ Params: { pid: string }; Body: unknown }>('/api/projects/:pid/test-cases/import', { bodyLimit: 512 * 1024 }, async (req) => {
    const r = qa.importTestCases(db, req.params.pid, req.body, human);
    if (!r.dryRun && r.created > 0) changed('test_case', req.params.pid);
    return r;
  });
  app.post<{ Params: { pid: string }; Body: unknown }>('/api/projects/:pid/test-cases', async (req, reply) => {
    const t = qa.createTestCase(db, req.params.pid, req.body, human);
    changed('test_case', req.params.pid);
    return reply.code(201).send(t);
  });
  app.get<{ Params: { id: string } }>('/api/test-cases/:id', async (req) => qa.getTestCase(db, req.params.id));
  app.patch<{ Params: { id: string }; Body: unknown }>('/api/test-cases/:id', async (req) => {
    const t = qa.updateTestCase(db, req.params.id, req.body, human);
    changed('test_case', t.projectId);
    return t;
  });
  app.post<{ Params: { id: string }; Body: { to?: unknown; note?: unknown } }>('/api/test-cases/:id/transition', async (req) => {
    const to = typeof req.body?.to === 'string' ? req.body.to : '';
    const note = typeof req.body?.note === 'string' ? req.body.note : '';
    const t = qa.transitionTestCase(db, req.params.id, to, note, human);
    changed('test_case', t.projectId);
    return t;
  });
  app.post<{ Params: { id: string }; Body: { playbookId?: unknown } }>('/api/test-cases/:id/hand-to-agent', async (req) => {
    if (typeof req.body?.playbookId !== 'string') throw new HttpError(400, 'invalid_input', 'playbookId must be text');
    const pb = getPlaybook(db, req.body.playbookId);
    const r = handDraftToWriter(db, req.params.id, { agentName: pb.agentName, kind: pb.kind, area: pb.area }, human);
    changed('test_case', projectOf('test_cases', req.params.id));
    return r;
  });
  app.post<{ Params: { id: string }; Body: { archived?: unknown } }>('/api/test-cases/:id/archive', async (req) => {
    const t = qa.setArchived(db, req.params.id, req.body?.archived !== false, human);
    changed('test_case', t.projectId);
    return t;
  });

  // ---------------------------------------------------------------- traceability and summary
  app.get<{ Params: { pid: string } }>('/api/projects/:pid/traceability', async (req) => qa.traceability(db, req.params.pid));
  app.get('/api/qa/summary', async () => qa.qaSummary(db));
  app.get<{ Params: { pid: string } }>('/api/projects/:pid/qa-summary', async (req) => qa.projectQaSummary(db, req.params.pid));
}
