/**
 * Agent routes (token-authenticated, for the local MCP server) and the person-only controls around them
 * (cookie + CSRF header, like the rest of the UI API).
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import process from 'node:process';
import type { FastifyInstance } from 'fastify';
import { agentAccessEnabled, agentToolList, callAgentTool, recentAgentActivity, setAgentAccess, AGENT_TOOL_NAMES } from './agent.ts';
import { rotateAgentToken, type DataDirPaths } from './dataDir.ts';
import type { DB } from './db/index.ts';
import { getProjectPath, getSetting, HttpError } from './store.ts';

/** Characters that would be interpreted by cmd.exe even inside quotes. A project folder containing one cannot be launched. */
const UNSAFE_FOR_CMD = /[%^&|<>"!\r\n]/;

export type LaunchClaude = (cwd: string) => void;

export const defaultLaunchClaude: LaunchClaude = (cwd) => {
  if (process.platform !== 'win32') throw new HttpError(501, 'not_supported', 'Launching a terminal is only supported on Windows');
  // Fixed command, no user input: a new console window in the project folder running `claude`.
  execFile('cmd.exe', ['/d', '/c', 'start', 'Claude Code', '/D', cwd, 'cmd.exe', '/k', 'claude'], { windowsHide: false }, () => undefined);
};

export function registerAgentRoutes(
  app: FastifyInstance,
  deps: { db: DB; paths: DataDirPaths; port: number; demo: boolean; launchClaude: LaunchClaude; broadcast: (m: unknown) => void },
) {
  const { db, paths, port, demo, launchClaude } = deps;

  // ---------------------------------------------------------------- agent surface (agent token, no cookie, no Origin)
  app.get('/api/agent/tools', async () => {
    if (!agentAccessEnabled(db)) throw new HttpError(403, 'agent_access_disabled', 'Agent access is turned off. A person can turn it on in Settings.');
    return { tools: agentToolList() };
  });
  app.post<{ Params: { name: string }; Body: unknown }>('/api/agent/tools/:name', { bodyLimit: 128 * 1024 }, async (req) => ({
    result: callAgentTool(db, req.params.name, req.body),
  }));

  // ---------------------------------------------------------------- person-only controls
  app.get('/api/settings/agent', async () => ({
    enabled: agentAccessEnabled(db),
    mcpInstalled: fs.existsSync(paths.mcpScript),
    tools: AGENT_TOOL_NAMES,
    activity: recentAgentActivity(db, 50),
    lastRotatedAt: getSetting<string | null>(db, 'agent_token_rotated_at', null),
  }));
  app.put<{ Body: { enabled?: unknown; confirm?: unknown } }>('/api/settings/agent', async (req) => {
    if (typeof req.body?.enabled !== 'boolean') throw new HttpError(400, 'invalid_input', 'enabled must be true or false');
    if (req.body.enabled && req.body.confirm !== true) {
      throw new HttpError(400, 'confirm_required', 'Confirm that you understand agents will be able to read QA data and create drafts, defects and tasks');
    }
    setAgentAccess(db, req.body.enabled);
    return { enabled: req.body.enabled };
  });
  app.post('/api/settings/agent/rotate-token', async () => {
    rotateAgentToken(paths);
    db.prepare("INSERT INTO settings (key, value) VALUES ('agent_token_rotated_at', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(JSON.stringify(new Date().toISOString()));
    return { ok: true };
  });
  // Contains local file paths: a sensitive GET (needs the CSRF header), shown only in the person's own screen.
  app.get('/api/settings/agent/setup', async () => {
    const quote = (s: string) => `"${s}"`;
    const envArgs = [port !== 47821 ? `--env QAVO_PORT=${port}` : '', process.env.QAVO_DATA_DIR ? `--env QAVO_DATA_DIR=${quote(process.env.QAVO_DATA_DIR)}` : ''].filter(Boolean).join(' ');
    return {
      command: `claude mcp add --scope user qa-office${envArgs ? ` ${envArgs}` : ''} -- ${quote(process.execPath)} ${quote(paths.mcpScript)}`,
      removeCommand: 'claude mcp remove qa-office',
    };
  });

  app.post<{ Params: { id: string }; Body: { confirm?: unknown } }>('/api/projects/:id/launch-claude', async (req) => {
    if (demo) throw new HttpError(403, 'demo_mode', 'Demo projects are fictional; there is no folder to open.');
    if (req.body?.confirm !== true) throw new HttpError(400, 'confirm_required', 'Confirm that you want to open a terminal and start Claude Code in this project folder');
    const p = db.prepare('SELECT archived FROM projects WHERE id = ?').get(req.params.id) as { archived: number } | undefined;
    if (!p) throw new HttpError(404, 'project_not_found');
    if (p.archived === 1) throw new HttpError(409, 'project_archived', 'This project is archived');
    const { pathEntered, exists } = getProjectPath(db, req.params.id);
    if (!exists || !fs.existsSync(pathEntered) || !fs.statSync(pathEntered).isDirectory()) throw new HttpError(409, 'path_missing', 'The project folder no longer exists');
    if (UNSAFE_FOR_CMD.test(pathEntered)) throw new HttpError(400, 'path_not_launchable', 'This folder name contains characters (% ^ & | < > " !) that a terminal could misread. Open a terminal there yourself.');
    launchClaude(pathEntered);
    return { launched: true };
  });
}
