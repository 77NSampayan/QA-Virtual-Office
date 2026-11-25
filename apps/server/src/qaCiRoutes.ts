/** CI/CD connection HTTP routes (signed-in person only; agents have no CI tools). */
import type { FastifyInstance } from 'fastify';
import type { Actor } from '@qavo/shared';
import type { Broadcast } from './collector.ts';
import type { DB } from './db/index.ts';
import * as ci from './qaCi.ts';

const human: Actor = 'human';
const SMALL = { bodyLimit: 8 * 1024 };

export function registerQaCiRoutes(app: FastifyInstance, deps: { db: DB; broadcast: Broadcast; ci: ci.CiDeps }) {
  const { db, broadcast } = deps;
  const changed = (projectId?: string | null) => broadcast({ type: 'qa.changed', entity: 'ci', projectId: projectId ?? null });

  app.get<{ Params: { pid: string } }>('/api/projects/:pid/ci/connections', async (req) => ci.listConnections(db, deps.ci, req.params.pid));
  app.post<{ Params: { pid: string }; Body: unknown }>('/api/projects/:pid/ci/connections', SMALL, async (req, reply) => {
    const r = await ci.connect(db, deps.ci, req.params.pid, req.body, human);
    changed(req.params.pid);
    return reply.code(201).send(r);
  });
  app.post<{ Params: { id: string } }>('/api/ci/connections/:id/test', async (req) => {
    const r = await ci.testConnection(db, deps.ci, req.params.id, human);
    changed(r.connection.projectId);
    return r;
  });
  app.put<{ Params: { id: string }; Body: unknown }>('/api/ci/connections/:id/token', SMALL, async (req) => {
    const r = await ci.replaceToken(db, deps.ci, req.params.id, req.body, human);
    changed(r.projectId);
    return r;
  });
  app.delete<{ Params: { id: string } }>('/api/ci/connections/:id', async (req) => {
    const pid = ci.projectOfConnection(db, req.params.id);
    const r = await ci.disconnect(db, deps.ci, req.params.id, human);
    changed(pid);
    return r;
  });
}
