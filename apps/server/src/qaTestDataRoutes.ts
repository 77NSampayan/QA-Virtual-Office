/** Test data HTTP routes (signed-in person only). */
import type { FastifyInstance } from 'fastify';
import type { Actor } from '@qavo/shared';
import type { Broadcast } from './collector.ts';
import type { DB } from './db/index.ts';
import * as td from './qaTestData.ts';

const human: Actor = 'human';

export function registerQaTestDataRoutes(app: FastifyInstance, deps: { db: DB; broadcast: Broadcast }) {
  const { db, broadcast } = deps;
  const changed = (projectId?: string | null) => broadcast({ type: 'qa.changed', entity: 'test_data', projectId: projectId ?? null });

  app.get<{ Params: { pid: string } }>('/api/projects/:pid/test-data', async (req) => td.listProfiles(db, req.params.pid));
  app.post<{ Params: { pid: string }; Body: unknown }>('/api/projects/:pid/test-data', async (req, reply) => {
    const r = td.createProfile(db, req.params.pid, req.body, human);
    changed(req.params.pid);
    return reply.code(201).send(r);
  });
  // the masking helper: nothing is stored
  app.post<{ Body: unknown }>('/api/test-data/check', { bodyLimit: 200 * 1024 }, async (req) => td.checkText(req.body, human));
  app.get<{ Params: { id: string } }>('/api/test-data/:id', async (req) => td.getProfile(db, req.params.id));
  app.put<{ Params: { id: string }; Body: unknown }>('/api/test-data/:id', async (req) => {
    const r = td.updateProfile(db, req.params.id, req.body, human);
    changed(r.projectId);
    return r;
  });
  app.delete<{ Params: { id: string } }>('/api/test-data/:id', async (req) => {
    const pid = td.projectOfProfile(db, req.params.id);
    const r = td.deleteProfile(db, req.params.id, human);
    changed(pid);
    return r;
  });
}
