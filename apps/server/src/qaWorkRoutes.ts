/**
 * Defect, exploratory session and task board routes (Pass 2C). Reached through the signed-in browser or
 * desktop app, so the actor is always the HUMAN user. Agents get separate, limited routes in Pass 2D.
 */
import type { FastifyInstance } from 'fastify';
import type { Actor } from '@qavo/shared';
import type { Broadcast } from './collector.ts';
import type { DB } from './db/index.ts';
import * as df from './qaDefects.ts';
import * as wk from './qaWork.ts';

const human: Actor = 'human';

export function registerQaWorkRoutes(app: FastifyInstance, deps: { db: DB; broadcast: Broadcast }) {
  const { db, broadcast } = deps;
  const changed = (entity: string, projectId?: string | null) => broadcast({ type: 'qa.changed', entity, projectId: projectId ?? null });
  const projectOf = (table: 'defects' | 'exploratory_sessions' | 'tasks', id: string) =>
    (db.prepare(`SELECT project_id FROM ${table} WHERE id = ?`).get(id) as { project_id: string } | undefined)?.project_id;

  // ---------------------------------------------------------------- defects
  app.get<{ Params: { pid: string }; Querystring: { status?: string; severity?: string; executionId?: string; testCaseId?: string; openOnly?: string; q?: string } }>(
    '/api/projects/:pid/defects',
    async (req) => df.listDefects(db, { projectId: req.params.pid, ...req.query, openOnly: req.query.openOnly === 'true' }),
  );
  app.post<{ Params: { pid: string }; Body: unknown }>('/api/projects/:pid/defects', async (req, reply) => {
    const d = df.createDefect(db, req.params.pid, req.body, human);
    changed('defect', d.projectId);
    return reply.code(201).send(d);
  });
  app.post<{ Params: { id: string }; Body: unknown }>('/api/executions/:id/defect', async (req, reply) => {
    const d = df.createDefectFromExecution(db, req.params.id, req.body, human);
    changed('defect', d.projectId);
    return reply.code(201).send(d);
  });
  app.get<{ Params: { id: string } }>('/api/defects/:id', async (req) => df.getDefect(db, req.params.id));
  app.patch<{ Params: { id: string }; Body: unknown }>('/api/defects/:id', async (req) => {
    const d = df.updateDefect(db, req.params.id, req.body, human);
    changed('defect', d.projectId);
    return d;
  });
  app.post<{ Params: { id: string }; Body: unknown }>('/api/defects/:id/transition', async (req) => {
    const d = df.transitionDefect(db, req.params.id, req.body, human);
    changed('defect', d.projectId);
    return d;
  });
  app.post<{ Params: { id: string }; Body: unknown }>('/api/defects/:id/comments', async (req) => {
    const d = df.addDefectComment(db, req.params.id, req.body, human);
    changed('defect', d.projectId);
    return d;
  });

  // ---------------------------------------------------------------- exploratory sessions
  app.get<{ Params: { pid: string } }>('/api/projects/:pid/exploratory', async (req) => wk.listSessions(db, req.params.pid));
  app.post<{ Params: { pid: string }; Body: unknown }>('/api/projects/:pid/exploratory', async (req, reply) => {
    const s = wk.createSession(db, req.params.pid, req.body, human);
    changed('exploratory', s.projectId);
    return reply.code(201).send(s);
  });
  app.get<{ Params: { id: string } }>('/api/exploratory/:id', async (req) => wk.getSession(db, req.params.id));
  app.post<{ Params: { id: string } }>('/api/exploratory/:id/start', async (req) => {
    const s = wk.startSession(db, req.params.id, human);
    changed('exploratory', s.projectId);
    return s;
  });
  app.post<{ Params: { id: string }; Body: unknown }>('/api/exploratory/:id/complete', async (req) => {
    const s = wk.completeSession(db, req.params.id, req.body, human);
    changed('exploratory', s.projectId);
    return s;
  });
  app.post<{ Params: { id: string }; Body: unknown }>('/api/exploratory/:id/notes', async (req, reply) => {
    const s = wk.addNote(db, req.params.id, req.body, human);
    changed('exploratory', s.projectId);
    return reply.code(201).send(s);
  });
  app.post<{ Params: { id: string }; Body: unknown }>('/api/exploratory-notes/:id/defect', async (req, reply) => {
    const r = wk.raiseDefectFromNote(db, req.params.id, req.body, human);
    changed('defect', r.defect.projectId);
    changed('exploratory', r.defect.projectId);
    return reply.code(201).send(r);
  });

  // ---------------------------------------------------------------- task board
  app.get<{ Params: { pid: string }; Querystring: { stage?: string; assignee?: string } }>('/api/projects/:pid/tasks', async (req) => wk.listTasks(db, { projectId: req.params.pid, ...req.query }));
  app.post<{ Params: { pid: string }; Body: unknown }>('/api/projects/:pid/tasks', async (req, reply) => {
    const t = wk.createTask(db, req.params.pid, req.body, human);
    changed('task', t.projectId);
    return reply.code(201).send(t);
  });
  app.get<{ Params: { id: string } }>('/api/tasks/:id', async (req) => wk.getTask(db, req.params.id));
  app.patch<{ Params: { id: string }; Body: unknown }>('/api/tasks/:id', async (req) => {
    const t = wk.updateTask(db, req.params.id, req.body, human);
    changed('task', t.projectId);
    return t;
  });
  app.post<{ Params: { id: string }; Body: unknown }>('/api/tasks/:id/move', async (req) => {
    const t = wk.moveTask(db, req.params.id, req.body, human);
    changed('task', projectOf('tasks', req.params.id));
    return t;
  });
}
