/**
 * Permission routes (V4b).
 *  - /api/permission-hook/*  : the hook token only (the synchronous hook script): create a request, wait for its answer
 *  - /api/permissions/*      : the signed-in person only (cookie + CSRF header): see what is waiting, allow or deny
 *  - /api/settings/permission-bridge and /api/integration/permission-hook/* : the person's switches and installer
 * The agent token reaches none of these (it is refused before routing), so an agent can never answer a request.
 */
import type { FastifyInstance } from 'fastify';
import type { Actor } from '@qavo/shared';
import type { Broadcast } from './collector.ts';
import type { DB } from './db/index.ts';
import { currentCapture } from './policyWriter.ts';
import { describePermissionPlan, installPermissionHook, permissionHookStatus, uninstallPermissionHook } from './permissionInstaller.ts';
import type { InstallContext } from './installer.ts';
import { bridgeEnabled, createRequest, decide, DEFAULT_WAIT_SECONDS, listPending, recentDecisions, setBridge, statusOf, sweep } from './permissions.ts';
import { HttpError } from './store.ts';

const human: Actor = 'human';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function registerPermissionRoutes(
  app: FastifyInstance,
  deps: { db: DB; broadcast: Broadcast; regeneratePolicy: () => number; installCtx: () => InstallContext & { permissionSource?: string }; now?: () => number },
) {
  const { db, broadcast, regeneratePolicy, installCtx } = deps;
  const now = deps.now ?? Date.now;
  const changed = () => broadcast({ type: 'permission.changed' });

  // ---------------------------------------------------------------- hook side (hook token)
  app.post<{ Body: unknown }>('/api/permission-hook/request', { bodyLimit: 8 * 1024 }, async (req) => {
    const r = createRequest(db, req.body, now(), DEFAULT_WAIT_SECONDS);
    changed();
    return { id: r.id, status: 'pending', expiresAt: r.expiresAt };
  });
  app.get<{ Params: { id: string }; Querystring: { wait?: string } }>('/api/permission-hook/wait/:id', async (req, reply) => {
    const maxWait = Math.max(0, Math.min(20_000, Number(req.query.wait ?? 20_000) || 0));
    const t0 = Date.now();
    let closed = false;
    req.raw.on('close', () => (closed = true));
    for (;;) {
      const s = statusOf(db, req.params.id, now());
      if (!s) return reply.code(404).send({ status: 'unknown' });
      if (s.status !== 'pending' || closed || Date.now() - t0 >= maxWait) {
        if (s.status === 'expired') changed();
        return { status: s.status };
      }
      await sleep(120);
    }
  });

  // ---------------------------------------------------------------- the person
  app.get('/api/permissions/pending', async () => {
    if (sweep(db, now()) > 0) changed();
    return listPending(db, now());
  });
  app.post<{ Params: { id: string }; Body: { decision?: unknown } }>('/api/permissions/:id/decide', async (req) => {
    const r = decide(db, req.params.id, req.body?.decision, human, now());
    changed();
    return r;
  });

  app.get('/api/settings/permission-bridge', async () => ({
    enabled: bridgeEnabled(db),
    hook: permissionHookStatus(installCtx()),
    toolInputsCapture: currentCapture(db).toolInputs,
    pending: listPending(db, now()).length,
    recent: recentDecisions(db, 20),
  }));
  app.put<{ Body: { enabled?: unknown; confirm?: unknown } }>('/api/settings/permission-bridge', async (req) => {
    if (typeof req.body?.enabled !== 'boolean') throw new HttpError(400, 'invalid_input', 'enabled must be true or false');
    if (req.body.enabled && req.body.confirm !== true) {
      throw new HttpError(400, 'confirm_required', 'Confirm that you want to answer Claude Code permission requests from the office');
    }
    setBridge(db, req.body.enabled);
    regeneratePolicy(); // the hook script reads the switch from the capture policy on every request
    changed();
    return { enabled: req.body.enabled };
  });

  // ---------------------------------------------------------------- installer (the person, with a dry-run plan)
  const installerError = (err: unknown): never => {
    const msg = err instanceof Error ? err.message : String(err);
    const code = /^([a-z_]+):/.exec(msg)?.[1] ?? 'install_failed';
    throw new HttpError(code === 'settings_invalid_json' || code === 'settings_changed_concurrently' ? 409 : 500, code, msg.replace(/^[a-z_]+:\s*/, '').replace(/[A-Za-z]:\\[^\s'"]*/g, '<path>'));
  };
  app.get<{ Querystring: { action?: string } }>('/api/integration/permission-hook/plan', async (req) => {
    if (req.query.action !== 'install' && req.query.action !== 'uninstall') throw new HttpError(400, 'plan_params_invalid');
    try {
      return describePermissionPlan(req.query.action, installCtx());
    } catch (err) {
      return installerError(err);
    }
  });
  app.post<{ Body: { acknowledge?: unknown } }>('/api/integration/permission-hook/install', async (req) => {
    if (req.body?.acknowledge !== true) throw new HttpError(400, 'acknowledge_required', 'You must acknowledge what this hook does');
    try {
      const r = installPermissionHook(installCtx());
      return { changed: r.changed, verified: r.verified, backupCreated: r.backupPath !== null };
    } catch (err) {
      return installerError(err);
    }
  });
  app.post('/api/integration/permission-hook/uninstall', async () => {
    try {
      const r = uninstallPermissionHook(installCtx());
      return { changed: r.changed, verified: r.verified, backupCreated: r.backupPath !== null };
    } catch (err) {
      return installerError(err);
    }
  });
}
