import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify, { LogController, type FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import fastifyWebsocket from '@fastify/websocket';
import type { WebSocket } from 'ws';
import { projectRootKeys } from '@qavo/shared/folderKeys';
import { AuthStore, clearedCookie, COOKIE_NAME, parseCookies, sessionCookie } from './auth.ts';
import { ingest, ingestStatusLine, ValidationError, type Broadcast } from './collector.ts';
import { loadFolderKeySecret, readAgentToken, rotateFolderKeySecret, type DataDirPaths } from './dataDir.ts';
import { defaultLaunchClaude, registerAgentRoutes, type LaunchClaude } from './agentRoutes.ts';
import type { DB } from './db/index.ts';
import type { InstallContext } from './installer.ts';
import { loggerOptions } from './logger.ts';
import { writePolicy } from './policyWriter.ts';
import { DEMO_BANNER } from './demo.ts';
import { registerPermissionRoutes } from './permissionRoutes.ts';
import { expireOnEvent } from './permissions.ts';
import { registerQaExecRoutes } from './qaExecRoutes.ts';
import { registerQaRoutes } from './qaRoutes.ts';
import { registerQaWorkRoutes } from './qaWorkRoutes.ts';
import { registerRoutes, type Runtime } from './routes.ts';
import { registerSecurity } from './security.ts';
import {
  createProject,
  deleteProject,
  getProjectPath,
  getSetting,
  HttpError,
  listActivity,
  listEvents,
  listNotifications,
  listProjects,
  listSessions,
  markNotifications,
  projectRoom,
  relinkSessions,
  robotsWithSession,
  sessionDto,
  unreadCount,
  updateProject,
  updateRobot,
  type RobotPatch,
  type ProjectInput,
  type ProjectPatch,
} from './store.ts';

export const VERSION = '0.8.0-v4b';
const WEB_DIST = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../web/dist');

export interface AppOptions {
  db: DB;
  paths: DataDirPaths;
  token: string;
  port: number;
  logFile?: string | null;
  webDist?: string;
  claudeSettingsPath?: string;
  /** Test hooks: override the installer context (forwarder sources, node path). */
  installOverrides?: Partial<InstallContext>;
  /** Require the session cookie for the UI API and WebSocket (default true). */
  authRequired?: boolean;
  recovery?: Runtime['recovery'];
  /** Demo mode: fictional data; changing the real Claude Code settings is refused. */
  demo?: boolean;
  /** Test seam for "Launch Claude Code here" (default opens a real terminal). */
  launchClaude?: LaunchClaude;
}

export interface AppHandle {
  app: FastifyInstance;
  broadcast: Broadcast;
  regeneratePolicy: () => number;
  auth: AuthStore;
  runtime: Runtime;
  /** One-time URL that logs a browser in (single use, 5 minutes). */
  createLaunchUrl: () => string;
}

export async function buildApp(opts: AppOptions): Promise<AppHandle> {
  const { db, paths, port } = opts;
  const app = Fastify({
    logger: loggerOptions(opts.logFile === undefined ? path.join(paths.logs, 'server.log') : opts.logFile),
    logController: new LogController({ disableRequestLogging: true }),
    bodyLimit: 256 * 1024,
    trustProxy: false,
    forceCloseConnections: true,
  });

  const auth = new AuthStore(db);
  const authRequired = opts.authRequired ?? true;
  const runtime: Runtime = { lastReplay: null, recovery: opts.recovery ?? null };

  registerSecurity(app, {
    port,
    token: opts.token,
    agentToken: () => readAgentToken(paths),
    isAuthenticated: authRequired ? (req) => auth.verifyHeader(req.headers.cookie) : undefined,
  });
  await app.register(fastifyWebsocket);

  const sockets = new Set<WebSocket>();
  const broadcast: Broadcast = (msg) => {
    const data = JSON.stringify(msg);
    for (const s of sockets) if (s.readyState === 1) s.send(data);
  };

  app.addHook('preClose', async () => {
    for (const s of sockets) s.terminate();
    sockets.clear();
  });

  const regeneratePolicy = () => writePolicy(db, paths.policy, port).version;
  const relinkFor = (projectId: string, forms: { lexical: string; canonical: string | null }) => {
    const secret = loadFolderKeySecret(paths);
    return secret ? relinkSessions(db, projectId, projectRootKeys(secret, forms)) : [];
  };
  const createLaunchUrl = () => `http://127.0.0.1:${port}/launch?k=${auth.createLaunchNonce()}`;

  app.addHook('onResponse', async (req, reply) => {
    req.log.info({ m: req.method, route: req.routeOptions.url ?? 'unmatched', s: reply.statusCode, ms: Math.round(reply.elapsedTime) }, 'req');
  });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof HttpError) return reply.code(err.status).send({ error: err.code, message: err.message });
    if (err instanceof ValidationError) return reply.code(400).send({ error: err.message });
    const status = (err as { statusCode?: number }).statusCode;
    if (status && status >= 400 && status < 500) return reply.code(status).send({ error: 'bad_request' });
    req.log.error({ err }, 'unhandled');
    return reply.code(500).send({ error: 'internal_error' });
  });

  // ------------------------------------------------------------------ auth
  app.get<{ Querystring: { k?: string } }>('/launch', async (req, reply) => {
    if (!auth.consumeNonce(req.query.k)) {
      return reply
        .code(401)
        .type('text/html')
        .send('<!doctype html><title>QA Virtual Office</title><p>This launch link is invalid, expired or already used. Run <code>npm run launch</code> for a new one.</p>');
    }
    return reply.header('set-cookie', sessionCookie(auth.issueSession())).redirect('/', 302);
  });
  app.get('/api/auth/status', async (req) => ({
    authRequired,
    authenticated: !authRequired || auth.verifyHeader(req.headers.cookie),
  }));
  app.post('/api/auth/launch-nonce', async () => ({ url: createLaunchUrl() })); // token route: same-user processes only
  app.post('/api/auth/logout', async (req, reply) => {
    auth.revoke(parseCookies(req.headers.cookie)[COOKIE_NAME]);
    return reply.header('set-cookie', clearedCookie).send({ ok: true });
  });

  // ------------------------------------------------------------------ websocket
  app.get('/ws', { websocket: true }, (socket) => {
    sockets.add(socket);
    socket.send(JSON.stringify({ type: 'hello', version: VERSION }));
    socket.on('close', () => sockets.delete(socket));
    socket.on('message', () => {
      /* server -> client only */
    });
  });

  // ------------------------------------------------------------------ collector (token routes)
  app.post('/api/hooks', { bodyLimit: 64 * 1024 }, async (req, reply) => {
    ingest(db, req.body, broadcast);
    if (expireOnEvent(db, req.body) > 0) broadcast({ type: 'permission.changed' });
    return reply.code(204).send(); // always empty body: cannot be read as a hook decision
  });
  app.post('/api/statusline', { bodyLimit: 16 * 1024 }, async (req, reply) => {
    ingestStatusLine(db, req.body, broadcast);
    return reply.code(204).send();
  });

  // ------------------------------------------------------------------ read APIs
  app.get('/api/health', async () => ({ ok: true, version: VERSION, policyVersion: getSetting(db, 'policy_version', 0), ...(opts.demo ? { demo: true } : {}) }));
  app.get('/api/demo', async () => ({ demo: opts.demo === true, banner: opts.demo ? DEMO_BANNER : '' }));
  if (opts.demo) {
    // Defense in depth: even with a settings path inside the demo folder, never let the demo UI install or remove hooks.
    app.addHook('onRequest', async (req, reply) => {
      if (req.method !== 'GET' && /^\/api\/integration\/(hooks|statusline|permission-hook)\//.test(req.url)) {
        return reply.code(403).send({ error: 'demo_mode', message: 'Demo mode never changes your Claude Code settings.' });
      }
      return undefined;
    });
  }
  app.get('/api/projects', async () => listProjects(db));
  app.get('/api/sessions', async () => listSessions(db));
  app.get<{ Params: { id: string } }>('/api/sessions/:id', async (req) => {
    const s = sessionDto(db, req.params.id);
    if (!s) throw new HttpError(404, 'session_not_found');
    return s;
  });
  app.get<{ Params: { id: string } }>('/api/sessions/:id/events', async (req) => listEvents(db, req.params.id));
  app.get('/api/notifications', async () => listNotifications(db));
  app.get('/api/notifications/unread-count', async () => ({ unread: unreadCount(db) }));
  app.post<{ Body: { ids?: unknown; all?: unknown; read?: unknown } }>('/api/notifications/read', async (req) => {
    const { ids, all } = req.body ?? {};
    const read = req.body?.read === false ? false : true;
    const validIds = Array.isArray(ids) && ids.length > 0 && ids.length <= 500 && ids.every((i) => typeof i === 'string' && /^ntf_[a-f0-9]{16}$/.test(i));
    if (all !== true && !validIds) throw new HttpError(400, 'ids_or_all_required');
    const r = markNotifications(db, { ids: validIds ? (ids as string[]) : undefined, all: all === true, read });
    broadcast({ type: 'notifications.read', unread: r.unread });
    return r;
  });

  // ------------------------------------------------------------------ robots, activity, rooms
  app.get('/api/robots', async () => robotsWithSession(db));
  app.patch<{ Params: { id: string }; Body: RobotPatch }>('/api/robots/:id', async (req) => {
    const robot = updateRobot(db, req.params.id, req.body ?? {});
    broadcast({ type: 'robot.updated', robot });
    return robot;
  });
  app.get<{ Querystring: { limit?: string; projectId?: string } }>('/api/activity', async (req) => {
    const limit = req.query.limit === undefined ? 50 : Number(req.query.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw new HttpError(400, 'limit_invalid');
    return listActivity(db, limit, req.query.projectId);
  });
  app.get<{ Params: { id: string } }>('/api/projects/:id/room', async (req) => projectRoom(db, req.params.id));

  // ------------------------------------------------------------------ project mutations
  app.post<{ Body: ProjectInput }>('/api/projects', async (req, reply) => {
    const { project, forms, warnings } = createProject(db, req.body ?? ({} as ProjectInput));
    const policyVersion = regeneratePolicy();
    const relinked = relinkFor(project.id, forms);
    broadcast({ type: 'project.updated', project });
    for (const id of relinked) broadcast({ type: 'session.updated', session: sessionDto(db, id) });
    return reply.code(201).send({ project, warnings, policyVersion, relinkedSessions: relinked.length });
  });

  app.patch<{ Params: { id: string }; Body: ProjectPatch }>('/api/projects/:id', async (req) => {
    const { project, pathChanged, forms, warnings } = updateProject(db, req.params.id, req.body ?? {});
    const policyVersion = regeneratePolicy();
    const relinked = pathChanged && forms ? relinkFor(project.id, forms) : [];
    broadcast({ type: 'project.updated', project });
    for (const id of relinked) broadcast({ type: 'session.updated', session: sessionDto(db, id) });
    return { project, warnings, policyVersion, relinkedSessions: relinked.length };
  });

  app.delete<{ Params: { id: string } }>('/api/projects/:id', async (req, reply) => {
    deleteProject(db, req.params.id);
    const policyVersion = regeneratePolicy();
    broadcast({ type: 'project.deleted', projectId: req.params.id });
    return reply.code(200).send({ ok: true, policyVersion });
  });

  // Edit form only (same-origin + X-QAVO-Client enforced in security.ts; excluded from logs).
  app.get<{ Params: { id: string } }>('/api/projects/:id/path', async (req) => getProjectPath(db, req.params.id));

  app.post('/api/integration/folder-key/rotate', async () => {
    const next = rotateFolderKeySecret(paths);
    return { kid: next.kid, note: 'Sessions grouped under the previous key can no longer be re-linked to a path.' };
  });

  // ------------------------------------------------------------------ settings, integration, backups, export
  registerRoutes(app, {
    db,
    paths,
    version: VERSION,
    installCtx: () => ({ paths, settingsPath: opts.claudeSettingsPath, ...opts.installOverrides }),
    regeneratePolicy,
    runtime,
  });

  registerPermissionRoutes(app, { db, broadcast, regeneratePolicy, installCtx: () => ({ paths, settingsPath: opts.claudeSettingsPath, ...opts.installOverrides }) });
  registerQaRoutes(app, { db, broadcast });
  registerQaExecRoutes(app, { db, broadcast, evidenceDir: paths.evidence });
  registerQaWorkRoutes(app, { db, broadcast });
  registerAgentRoutes(app, { db, paths, port, demo: opts.demo === true, launchClaude: opts.launchClaude ?? defaultLaunchClaude, broadcast: broadcast as (m: unknown) => void });

  // ------------------------------------------------------------------ static UI
  const dist = opts.webDist ?? WEB_DIST;
  if (fs.existsSync(path.join(dist, 'index.html'))) {
    // wildcard (the default) looks files up on EVERY request. With `wildcard: false` the plugin only
    // routes the files that existed at startup, so a rebuilt UI (new hashed file names) was served as
    // the HTML page and the browser refused it as a script.
    await app.register(fastifyStatic, { root: dist, index: ['index.html'] });
    app.setNotFoundHandler((req, reply) => {
      const pathname = req.url.split('?')[0]!;
      // Only extension-less routes (client-side pages) fall back to the app; a missing file is a real 404.
      const isPage = req.method === 'GET' && !pathname.startsWith('/api/') && !/\.[A-Za-z0-9]{1,8}$/.test(pathname);
      if (isPage) return reply.type('text/html').sendFile('index.html');
      return reply.code(404).send({ error: 'not_found' });
    });
  } else {
    app.get('/', async (_req, reply) =>
      reply.type('text/html').send('<!doctype html><title>QA Virtual Office</title><p>Web UI not built. Run <code>npm run build:web</code>.</p>'),
    );
  }

  return { app, broadcast, regeneratePolicy, auth, runtime, createLaunchUrl };
}
