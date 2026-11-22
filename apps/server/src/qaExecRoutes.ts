/**
 * Manual test execution HTTP routes (runs, executions, evidence).
 * Reached through the signed-in browser/desktop app, so the actor is always the HUMAN user. Agents get
 * separate, limited routes in Pass 2D; the service layer enforces the rules regardless.
 */
import fs from 'node:fs';
import type { FastifyInstance } from 'fastify';
import type { Actor } from '@qavo/shared';
import type { Broadcast } from './collector.ts';
import type { DB } from './db/index.ts';
import * as ex from './qaExec.ts';

const human: Actor = 'human';

export function registerQaExecRoutes(app: FastifyInstance, deps: { db: DB; broadcast: Broadcast; evidenceDir: string }) {
  const { db, broadcast, evidenceDir } = deps;
  const changed = (entity: string, projectId?: string | null) => broadcast({ type: 'qa.changed', entity, projectId: projectId ?? null });
  const projectOfRun = (runId: string) => (db.prepare('SELECT project_id FROM test_runs WHERE id = ?').get(runId) as { project_id: string } | undefined)?.project_id;
  const projectOfExec = (id: string) =>
    (db.prepare('SELECT r.project_id FROM test_executions e JOIN test_runs r ON r.id = e.run_id WHERE e.id = ?').get(id) as { project_id: string } | undefined)?.project_id;

  app.get<{ Params: { pid: string } }>('/api/projects/:pid/test-runs', async (req) => ex.listRuns(db, req.params.pid));
  app.post<{ Params: { pid: string }; Body: unknown }>('/api/projects/:pid/test-runs', async (req, reply) => {
    const r = ex.createRun(db, req.params.pid, req.body, human);
    changed('test_run', req.params.pid);
    return reply.code(201).send(r);
  });
  app.get<{ Params: { id: string } }>('/api/test-runs/:id', async (req) => ex.getRun(db, req.params.id));
  app.post<{ Params: { id: string }; Body: unknown }>('/api/test-runs/:id/cases', async (req) => {
    const r = ex.addCasesToRun(db, req.params.id, req.body, human);
    changed('test_run', projectOfRun(req.params.id));
    return r;
  });
  app.post<{ Params: { id: string } }>('/api/test-runs/:id/close', async (req) => {
    const r = ex.closeRun(db, req.params.id, human);
    changed('test_run', r.projectId);
    return r;
  });

  app.get<{ Params: { id: string } }>('/api/executions/:id', async (req) => ex.getExecution(db, req.params.id));
  app.post<{ Params: { id: string }; Body: unknown }>('/api/executions/:id/result', async (req) => {
    const r = ex.setResult(db, req.params.id, req.body, human);
    changed('test_execution', projectOfExec(req.params.id));
    return r;
  });
  app.post<{ Params: { id: string }; Body: unknown }>('/api/executions/:id/evidence/note', async (req, reply) => {
    const r = ex.addNoteEvidence(db, req.params.id, req.body, human);
    changed('test_execution', projectOfExec(req.params.id));
    return reply.code(201).send(r);
  });
  app.post<{ Params: { id: string }; Body: unknown }>('/api/executions/:id/evidence/file', { bodyLimit: 8 * 1024 * 1024 }, async (req, reply) => {
    const r = ex.addFileEvidence(db, evidenceDir, req.params.id, req.body, human);
    changed('test_execution', projectOfExec(req.params.id));
    return reply.code(201).send(r);
  });
  // Downloads are always attachments (never rendered by the browser) and are never sniffed.
  app.get<{ Params: { id: string } }>('/api/evidence/:id/file', async (req, reply) => {
    const f = ex.getEvidenceFile(db, evidenceDir, req.params.id);
    const asciiName = f.fileName.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
    return reply
      .header('Content-Type', f.mime)
      .header('Content-Disposition', `attachment; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(f.fileName)}`)
      .header('Content-Security-Policy', "default-src 'none'; sandbox")
      .send(fs.createReadStream(f.filePath));
  });
  app.delete<{ Params: { id: string } }>('/api/evidence/:id', async (req) => {
    const exId = (db.prepare('SELECT execution_id FROM evidence WHERE id = ?').get(req.params.id) as { execution_id: string } | undefined)?.execution_id;
    ex.deleteEvidence(db, evidenceDir, req.params.id, human);
    changed('test_execution', exId ? projectOfExec(exId) : null);
    return { ok: true };
  });
}
