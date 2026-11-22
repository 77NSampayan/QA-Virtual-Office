/** Pass 1B routes: integration health, hook/status-line install, privacy, retention, backups, export. */
import type { FastifyInstance } from 'fastify';
import { HOOK_EVENTS } from '@qavo/shared';
import { buildEventsCsv, buildExport } from './exporter.ts';
import {
  createBackup,
  getRetention,
  integrityCheck,
  listBackups,
  purgeContent,
  runRetention,
  validateRetention,
  type RecoveryNotice,
} from './maintenance.ts';
import { currentCapture, currentScope, DEFAULT_CAPTURE } from './policyWriter.ts';
import { getSetting, HttpError, setSetting, validateProjectPath } from './store.ts';
import {
  describePlan,
  hookStatus,
  install,
  installStatusLine,
  uninstall,
  uninstallStatusLine,
  type InstallContext,
  type PlanSummary,
} from './installer.ts';
import { spoolStatus, type ReplayReport } from './spool.ts';
import type { DataDirPaths } from './dataDir.ts';
import type { DB } from './db/index.ts';

export interface Runtime {
  lastReplay: (ReplayReport & { at: string }) | null;
  recovery: RecoveryNotice | null;
}

export interface RouteDeps {
  db: DB;
  paths: DataDirPaths;
  version: string;
  installCtx: () => InstallContext;
  regeneratePolicy: () => number;
  runtime: Runtime;
}

const TRUST_HINT =
  'Claude Code holds back hooks in a folder until its workspace-trust prompt has been accepted. If a session in a new folder does not appear, accept the trust prompt there.';

/** installer errors are thrown as "code: message" */
function installerError(err: unknown): never {
  const msg = err instanceof Error ? err.message : String(err);
  const code = /^([a-z_]+):/.exec(msg)?.[1] ?? 'install_failed';
  throw new HttpError(code === 'settings_changed_concurrently' ? 409 : 400, code, msg);
}

export function registerRoutes(app: FastifyInstance, d: RouteDeps) {
  const { db, paths } = d;

  app.get('/api/integration/status', async () => {
    const lastEvents: Record<string, string | null> = Object.fromEntries(HOOK_EVENTS.map((e) => [e, null]));
    for (const r of db
      .prepare("SELECT event, MAX(received_at) AS last FROM agent_events WHERE origin_source = 'hook' GROUP BY event")
      .all() as Array<{ event: string; last: string }>) {
      if (r.event in lastEvents) lastEvents[r.event] = r.last;
    }
    const lastAny = db.prepare("SELECT MAX(received_at) AS last FROM agent_events WHERE origin_source = 'hook'").get() as { last: string | null };
    return {
      version: d.version,
      policyVersion: getSetting(db, 'policy_version', 0),
      scope: currentScope(db),
      hooks: hookStatus({ paths, settingsPath: d.installCtx().settingsPath }),
      lastEventByType: lastEvents,
      lastHookEventAt: lastAny.last,
      spool: { ...spoolStatus(paths), lastReplay: d.runtime.lastReplay },
      lastBackupAt: getSetting<string | null>(db, 'last_backup_at', null),
      recovery: d.runtime.recovery ?? getSetting<RecoveryNotice | null>(db, 'recovery_notice', null),
      trustHint: TRUST_HINT,
    };
  });

  // ---------------------------------------------------------------- hooks / status line install
  app.get<{ Querystring: { kind?: string; action?: string } }>('/api/integration/plan', async (req): Promise<PlanSummary> => {
    const { kind, action } = req.query;
    if ((kind !== 'hooks' && kind !== 'statusLine') || (action !== 'install' && action !== 'uninstall')) {
      throw new HttpError(400, 'plan_params_invalid');
    }
    try {
      return describePlan(kind, action, d.installCtx());
    } catch (err) {
      return installerError(err);
    }
  });

  const needAck = (body: { acknowledge?: boolean } | undefined) => {
    if (body?.acknowledge !== true) throw new HttpError(400, 'acknowledge_required', 'You must acknowledge the cross-project monitoring notice');
  };
  app.post<{ Body: { acknowledge?: boolean } }>('/api/integration/hooks/install', async (req) => {
    needAck(req.body);
    try {
      const r = install(d.installCtx());
      return { changed: r.changed, verified: r.verified, backupCreated: r.backupPath !== null };
    } catch (err) {
      return installerError(err);
    }
  });
  app.post('/api/integration/hooks/uninstall', async () => {
    try {
      const r = uninstall(d.installCtx());
      return { changed: r.changed, verified: r.verified, backupCreated: r.backupPath !== null };
    } catch (err) {
      return installerError(err);
    }
  });
  app.post<{ Body: { acknowledge?: boolean } }>('/api/integration/statusline/install', async (req) => {
    needAck(req.body);
    try {
      const r = installStatusLine(d.installCtx());
      return { changed: r.changed, verified: r.verified, wrapped: r.wrapped, backupCreated: r.backupPath !== null };
    } catch (err) {
      return installerError(err);
    }
  });
  app.post('/api/integration/statusline/uninstall', async () => {
    try {
      const r = uninstallStatusLine(d.installCtx());
      return { changed: r.changed, verified: r.verified, backupCreated: r.backupPath !== null };
    } catch (err) {
      return installerError(err);
    }
  });

  // ---------------------------------------------------------------- settings
  app.get('/api/settings', async () => ({
    scope: currentScope(db),
    capture: currentCapture(db),
    retention: getRetention(db),
    excludeCount: getSetting<unknown[]>(db, 'excludes', []).length,
  }));

  app.put<{ Body: { scope?: string; confirm?: boolean } }>('/api/settings/scope', async (req) => {
    const scope = req.body?.scope;
    if (scope !== 'registered' && scope !== 'all') throw new HttpError(400, 'scope_invalid');
    if (scope === 'all' && currentScope(db) !== 'all' && req.body?.confirm !== true) {
      throw new HttpError(400, 'confirmation_required', 'All sessions scope reports metadata (and opaque folder keys) for every Claude Code session on this PC');
    }
    setSetting(db, 'scope', scope);
    return { scope, policyVersion: d.regeneratePolicy() };
  });

  app.put<{ Body: Partial<Record<keyof typeof DEFAULT_CAPTURE, boolean>> & { confirm?: boolean } }>('/api/settings/privacy', async (req) => {
    const before = currentCapture(db);
    const next = { ...before };
    for (const k of Object.keys(DEFAULT_CAPTURE) as Array<keyof typeof DEFAULT_CAPTURE>) {
      const v = req.body?.[k];
      if (v !== undefined) {
        if (typeof v !== 'boolean') throw new HttpError(400, 'privacy_invalid');
        next[k] = v;
      }
    }
    const enabling = (Object.keys(next) as Array<keyof typeof next>).filter((k) => next[k] && !before[k]);
    if (enabling.length && req.body?.confirm !== true) {
      throw new HttpError(
        400,
        'confirmation_required',
        'Enabling content capture stores (redacted, truncated) prompt/tool/notification text locally. Confirm to proceed.',
      );
    }
    setSetting(db, 'capture', next);
    const disabled = (Object.keys(next) as Array<keyof typeof next>).filter((k) => !next[k] && before[k]);
    return { capture: next, policyVersion: d.regeneratePolicy(), purgeOffered: disabled };
  });

  app.post<{ Body: { kinds?: unknown } }>('/api/privacy/purge', async (req) => {
    const valid = ['prompt', 'toolInput', 'toolResponse', 'notificationText'] as const;
    const kinds = req.body?.kinds;
    if (kinds === 'all') return { purged: purgeContent(db, 'all') };
    if (!Array.isArray(kinds) || kinds.length === 0 || !kinds.every((k) => (valid as readonly string[]).includes(k as string))) {
      throw new HttpError(400, 'kinds_invalid');
    }
    return { purged: purgeContent(db, kinds as Array<(typeof valid)[number]>) };
  });

  app.get('/api/settings/excludes', async () => ({ paths: getSetting<string[]>(db, 'excludes_entered', []) }));
  app.put<{ Body: { paths?: unknown } }>('/api/settings/excludes', async (req) => {
    const list = req.body?.paths;
    if (!Array.isArray(list) || list.length > 100) throw new HttpError(400, 'paths_invalid');
    const entered: string[] = [];
    const forms: Array<{ lexical: string; canonical: string | null }> = [];
    for (const p of list) {
      const v = validateProjectPath(p);
      entered.push(v.entered);
      forms.push(v.forms);
    }
    setSetting(db, 'excludes_entered', entered);
    setSetting(db, 'excludes', forms);
    return { count: forms.length, policyVersion: d.regeneratePolicy() };
  });

  app.get('/api/settings/retention', async () => getRetention(db));
  app.put<{ Body: unknown }>('/api/settings/retention', async (req) => {
    try {
      const r = validateRetention(req.body);
      setSetting(db, 'retention', r);
      return r;
    } catch (err) {
      if (err instanceof RangeError) throw new HttpError(400, 'retention_invalid', err.message);
      throw err;
    }
  });
  app.post('/api/maintenance/retention', async () => runRetention(db));

  // ---------------------------------------------------------------- backups / export / integrity
  app.get('/api/backups', async () => listBackups(paths));
  app.post('/api/backups', async (_req, reply) => reply.code(201).send(await createBackup(db, paths)));

  app.get<{ Querystring: { format?: string } }>('/api/export', async (req, reply) => {
    const data = buildExport(db, d.version);
    const stamp = data.manifest.exportedAt.replace(/[-:]/g, '').replace(/\.\d+Z$/, '').replace('T', '-');
    if (req.query.format === 'csv') {
      return reply
        .header('content-type', 'text/csv; charset=utf-8')
        .header('content-disposition', `attachment; filename="qavo-events-${stamp}.csv"`)
        .send(buildEventsCsv(data));
    }
    if (req.query.format !== undefined && req.query.format !== 'json') throw new HttpError(400, 'format_invalid');
    return reply
      .header('content-type', 'application/json; charset=utf-8')
      .header('content-disposition', `attachment; filename="qavo-export-${stamp}.json"`)
      .send(JSON.stringify(data, null, 2));
  });

  app.post('/api/integrity/check', async () => integrityCheck(db));
}
