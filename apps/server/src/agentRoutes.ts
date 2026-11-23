/**
 * Agent routes (token-authenticated, for the local MCP server) and the person-only controls around them
 * (cookie + CSRF header, like the rest of the UI API).
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import process from 'node:process';
import type { FastifyInstance } from 'fastify';
import path from 'node:path';
import { agentAccessEnabled, agentToolList, callAgentTool, recentAgentActivity, setAgentAccess, AGENT_TOOL_NAMES } from './agent.ts';
import { rotateAgentToken, type DataDirPaths } from './dataDir.ts';
import type { DB } from './db/index.ts';
import { playbookBrief } from './playbooks.ts';
import { createRun, listRuns, revokeRun } from './runs.ts';
import { getProjectPath, getSetting, HttpError } from './store.ts';

/** Characters that would be interpreted by cmd.exe even inside quotes. A project folder containing one cannot be launched. */
const UNSAFE_FOR_CMD = /[%^&|<>"!\r\n]/;

/** `run` is set when a playbook is launched: the per-run MCP config and the run id for the hooks. */
export type LaunchClaude = (cwd: string, run?: { configPath: string; runId: string }) => void;

export const defaultLaunchClaude: LaunchClaude = (cwd, run) => {
  if (process.platform !== 'win32') throw new HttpError(501, 'not_supported', 'Launching a terminal is only supported on Windows');
  // Fixed command, no user input: a new console window in the project folder running `claude`. For a playbook the extra
  // arguments are fixed too (the generated config path and a fixed sentence); the run id travels in the environment.
  const claude = run ? ['claude', '--mcp-config', run.configPath, '--strict-mcp-config', 'Follow your QA Virtual Office playbook.'] : ['claude'];
  execFile('cmd.exe', ['/d', '/c', 'start', 'Claude Code', '/D', cwd, 'cmd.exe', '/k', ...claude], { windowsHide: false, env: run ? { ...process.env, QAVO_RUN_ID: run.runId } : process.env }, () => undefined);
};

/** Deletes per-run MCP configs whose run is no longer active, so no stale credential file lingers. */
function cleanupRunConfigs(db: DB, dir: string) {
  let files: string[] = [];
  try {
    files = fs.readdirSync(dir);
  } catch {
    return;
  }
  const active = new Set(listRuns(db, 100).filter((r) => r.status === 'active').map((r) => r.id));
  for (const f of files) {
    const m = /^(run_[A-Za-z0-9_-]+)\.mcp\.json$/.exec(f);
    if (m && !active.has(m[1]!)) fs.rmSync(path.join(dir, f), { force: true });
  }
}

export function registerAgentRoutes(
  app: FastifyInstance,
  deps: { db: DB; paths: DataDirPaths; port: number; demo: boolean; launchClaude: LaunchClaude; broadcast: (m: unknown) => void },
) {
  const { db, paths, port, demo, launchClaude } = deps;

  // ---------------------------------------------------------------- agent surface (agent token, no cookie, no Origin)
  app.get('/api/agent/tools', async (req) => {
    if (!agentAccessEnabled(db)) throw new HttpError(403, 'agent_access_disabled', 'Agent access is turned off. A person can turn it on in Settings.');
    return { tools: agentToolList(req.agentRun) };
  });
  // Who am I? A launched run gets its playbook; the shared token gets nothing (it is unattributed).
  app.get('/api/agent/whoami', async (req) => {
    if (!agentAccessEnabled(db)) throw new HttpError(403, 'agent_access_disabled', 'Agent access is turned off. A person can turn it on in Settings.');
    if (!req.agentRun) return { attributed: false };
    const b = playbookBrief(db, req.agentRun);
    return { attributed: true, agentName: req.agentRun.agentName, role: req.agentRun.role, project: b.project, instructions: b.text };
  });
  app.post<{ Params: { name: string }; Body: unknown }>('/api/agent/tools/:name', { bodyLimit: 128 * 1024 }, async (req) => {
    const result = callAgentTool(db, req.params.name, req.body, req.agentRun);
    // What an agent writes must show up in an open page at once, like anything a person does (reads change nothing).
    if (!/^qa_(list|get)_/.test(req.params.name)) deps.broadcast({ type: 'qa.changed', entity: 'agent', projectId: null });
    return { result };
  });

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

  app.get('/api/runs', async () => listRuns(db, 30));
  app.post<{ Params: { id: string } }>('/api/runs/:id/revoke', async (req) => {
    const r = revokeRun(db, req.params.id, 'human');
    fs.rmSync(path.join(paths.runsDir, `${r.id}.mcp.json`), { force: true });
    return r;
  });

  app.post<{ Params: { id: string }; Body: { confirm?: unknown; playbookId?: unknown } }>('/api/projects/:id/launch-claude', async (req) => {
    if (demo) throw new HttpError(403, 'demo_mode', 'Demo projects are fictional; there is no folder to open.');
    if (req.body?.confirm !== true) throw new HttpError(400, 'confirm_required', 'Confirm that you want to open a terminal and start Claude Code in this project folder');
    const p = db.prepare('SELECT archived FROM projects WHERE id = ?').get(req.params.id) as { archived: number } | undefined;
    if (!p) throw new HttpError(404, 'project_not_found');
    if (p.archived === 1) throw new HttpError(409, 'project_archived', 'This project is archived');
    const { pathEntered, exists } = getProjectPath(db, req.params.id);
    if (!exists || !fs.existsSync(pathEntered) || !fs.statSync(pathEntered).isDirectory()) throw new HttpError(409, 'path_missing', 'The project folder no longer exists');
    if (UNSAFE_FOR_CMD.test(pathEntered)) throw new HttpError(400, 'path_not_launchable', 'This folder name contains characters (% ^ & | < > " !) that a terminal could misread. Open a terminal there yourself.');
    if (req.body?.playbookId !== undefined) {
      if (typeof req.body.playbookId !== 'string') throw new HttpError(400, 'invalid_input', 'playbookId must be text');
      if (!agentAccessEnabled(db)) throw new HttpError(409, 'agent_access_disabled', 'Turn agent access on in Settings first: a launched agent could not use any tool otherwise.');
      if (UNSAFE_FOR_CMD.test(paths.runsDir)) throw new HttpError(400, 'path_not_launchable', 'The data folder name contains characters (% ^ & | < > " !) that a terminal could misread.');
      cleanupRunConfigs(db, paths.runsDir);
      const { run, token } = createRun(db, req.params.id, req.body.playbookId, 'human');
      fs.mkdirSync(paths.runsDir, { recursive: true });
      const file = path.join(paths.runsDir, `${run.id}.mcp.json`);
      const env: Record<string, string> = { QAVO_RUN_TOKEN: token };
      if (port !== 47821) env.QAVO_PORT = String(port);
      fs.writeFileSync(file, JSON.stringify({ mcpServers: { 'qa-office': { command: process.execPath, args: [paths.mcpScript], env } } }, null, 2), { mode: 0o600 });
      launchClaude(pathEntered, { configPath: file, runId: run.id });
      return { launched: true, run };
    }
    launchClaude(pathEntered);
    return { launched: true };
  });
}
