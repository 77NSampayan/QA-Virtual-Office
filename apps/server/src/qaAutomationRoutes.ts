/** Automation results HTTP routes (signed-in person only; agents have no automation tools in A1). */
import type { FastifyInstance } from 'fastify';
import type { Actor } from '@qavo/shared';
import type { Broadcast } from './collector.ts';
import type { DB } from './db/index.ts';
import * as au from './qaAutomation.ts';

const human: Actor = 'human';

export function registerQaAutomationRoutes(app: FastifyInstance, deps: { db: DB; broadcast: Broadcast }) {
  const { db, broadcast } = deps;
  const changed = (projectId?: string | null) => broadcast({ type: 'qa.changed', entity: 'automation', projectId: projectId ?? null });

  app.get<{ Params: { pid: string } }>('/api/projects/:pid/automation/runs', async (req) => au.listRuns(db, req.params.pid));
  app.post<{ Params: { pid: string }; Body: unknown }>('/api/projects/:pid/automation/import', { bodyLimit: 6 * 1024 * 1024 }, async (req, reply) => {
    const r = au.importJunit(db, req.params.pid, req.body, human);
    if (!r.dryRun) changed(req.params.pid);
    return reply.code(r.dryRun ? 200 : 201).send(r);
  });
  // read-only scan of the registered project's folder for framework files (person-only, on demand, nothing stored)
  app.post<{ Params: { pid: string } }>('/api/projects/:pid/automation/detect', async (req) => au.detectProjectFrameworks(db, req.params.pid, human));
  app.get<{ Params: { id: string } }>('/api/automation/runs/:id', async (req) => au.getRun(db, req.params.id));
  app.delete<{ Params: { id: string } }>('/api/automation/runs/:id', async (req) => {
    const pid = au.projectOfRun(db, req.params.id);
    const r = au.deleteRun(db, req.params.id, human);
    changed(pid);
    return r;
  });
  app.patch<{ Params: { id: string }; Body: unknown }>('/api/automation/results/:id', async (req) => {
    const r = au.classifyResult(db, req.params.id, req.body, human);
    changed(au.projectOfResult(db, req.params.id));
    return r;
  });
}
