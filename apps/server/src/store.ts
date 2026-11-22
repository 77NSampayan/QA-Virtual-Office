/**
 * Repositories. Privacy rule: functions returning "DTOs" for ordinary API responses NEVER include
 * project paths. Only `getProjectPath`, `projectRoots` and `projectRootFormsFor` read
 * `project_paths`, for the edit form, the policy writer and folder-key re-linking respectively.
 */
import crypto from 'node:crypto';
import path from 'node:path';
import {
  type RobotStatus,
  type SessionOrigin,
  type SessionState,
  type StatusSource,
  type DroneState,
  type SessionFlags,
  type RobotPalette,
  isHexColor,
  isRobotType,
  newSessionState,
  parsePalette,
} from '@qavo/shared';
import { lexicalForm, canonicalForm, normalizeWinPath, type PathForms } from '@qavo/shared/paths';
import type { DB } from './db/index.ts';

export const newId = (prefix: string) => `${prefix}_${crypto.randomBytes(8).toString('hex')}`;
const nowIso = () => new Date().toISOString();

export class HttpError extends Error {
  constructor(
    public status: number,
    public code: string,
    message?: string,
  ) {
    super(message ?? code);
  }
}

// ---------------------------------------------------------------------------- projects
export interface ProjectDTO {
  id: string;
  alias: string;
  description: string;
  type: string;
  archived: boolean;
  pathConfigured: boolean;
  pathStatus: 'ok' | 'missing' | 'unset';
  createdAt: string;
  updatedAt: string;
}

export interface ProjectInput {
  alias: string;
  path: string;
  description?: string;
  type?: string;
}

const ALIAS_RE = /^[^\\/:*?"<>|\u0000-\u001f]{1,60}$/;
export const PROJECT_TYPES = ['general', 'web', 'api', 'mobile', 'desktop', 'automation', 'manual'] as const;

function validateAlias(alias: unknown): string {
  if (typeof alias !== 'string') throw new HttpError(400, 'alias_required');
  const a = alias.trim();
  if (!ALIAS_RE.test(a)) throw new HttpError(400, 'alias_invalid', 'Alias must be 1-60 chars without path characters');
  return a;
}

export interface ValidatedPath {
  entered: string;
  forms: PathForms;
}

export function validateProjectPath(p: unknown): ValidatedPath {
  if (typeof p !== 'string' || p.trim() === '' || p.length > 1024) throw new HttpError(400, 'path_required');
  const entered = p.trim();
  const normalized = normalizeWinPath(entered);
  if (!path.win32.isAbsolute(entered) || !/^([a-z]:\\|\\\\[^\\]+\\[^\\]+)/.test(normalized)) {
    throw new HttpError(400, 'path_not_absolute');
  }
  const lexical = lexicalForm(entered);
  if (/^[a-z]:\\$/.test(lexical) || /^\\\\[^\\]+\\[^\\]+$/.test(lexical)) {
    throw new HttpError(400, 'path_is_root', 'Registering a drive or share root would capture everything');
  }
  return { entered, forms: { lexical, canonical: canonicalForm(entered) } };
}

function aliasWarnings(alias: string, forms: PathForms): string[] {
  const a = alias.toLowerCase();
  const segments = new Set(
    [forms.lexical, forms.canonical ?? ''].flatMap((f) => f.split('\\')).filter((s) => s && !/^[a-z]:$/.test(s)),
  );
  return [...segments].some((s) => s === a || (s.length >= 4 && a.includes(s))) ? ['alias_matches_folder_name'] : [];
}

type ProjectRow = {
  id: string;
  alias: string;
  description: string;
  type: string;
  archived: number;
  created_at: string;
  updated_at: string;
  path_exists: number | null;
  has_path: number;
};

function projectDto(r: ProjectRow): ProjectDTO {
  return {
    id: r.id,
    alias: r.alias,
    description: r.description,
    type: r.type,
    archived: r.archived === 1,
    pathConfigured: r.has_path === 1,
    pathStatus: r.has_path !== 1 ? 'unset' : r.path_exists === 1 ? 'ok' : 'missing',
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

const PROJECT_SELECT = `SELECT p.id, p.alias, p.description, p.type, p.archived, p.created_at, p.updated_at,
  pp.path_exists, CASE WHEN pp.project_id IS NULL THEN 0 ELSE 1 END AS has_path
  FROM projects p LEFT JOIN project_paths pp ON pp.project_id = p.id`;

export function listProjects(db: DB): ProjectDTO[] {
  return (db.prepare(`${PROJECT_SELECT} ORDER BY p.alias COLLATE NOCASE`).all() as ProjectRow[]).map(projectDto);
}

export function getProject(db: DB, id: string): ProjectDTO | null {
  const r = db.prepare(`${PROJECT_SELECT} WHERE p.id = ?`).get(id) as ProjectRow | undefined;
  return r ? projectDto(r) : null;
}

function assertPathFree(db: DB, lexical: string, exceptId?: string) {
  const row = db.prepare('SELECT project_id FROM project_paths WHERE path_lexical = ?').get(lexical) as
    | { project_id: string }
    | undefined;
  if (row && row.project_id !== exceptId) throw new HttpError(409, 'path_already_registered');
}

export function createProject(db: DB, input: ProjectInput): { project: ProjectDTO; forms: PathForms; warnings: string[] } {
  const alias = validateAlias(input.alias);
  const vp = validateProjectPath(input.path);
  const type = input.type && (PROJECT_TYPES as readonly string[]).includes(input.type) ? input.type : 'general';
  const description = typeof input.description === 'string' ? input.description.slice(0, 500) : '';
  assertPathFree(db, vp.forms.lexical);
  const id = newId('proj');
  const ts = nowIso();
  db.transaction(() => {
    db.prepare(
      'INSERT INTO projects (id, alias, description, type, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(id, alias, description, type, ts, ts);
    db.prepare(
      'INSERT INTO project_paths (project_id, path_entered, path_lexical, path_canonical, path_exists, last_checked_at) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(id, vp.entered, vp.forms.lexical, vp.forms.canonical, vp.forms.canonical ? 1 : 0, ts);
  })();
  return { project: getProject(db, id)!, forms: vp.forms, warnings: aliasWarnings(alias, vp.forms) };
}

export interface ProjectPatch {
  alias?: string;
  description?: string;
  type?: string;
  path?: string;
  archived?: boolean;
}

export function updateProject(
  db: DB,
  id: string,
  patch: ProjectPatch,
): { project: ProjectDTO; pathChanged: boolean; forms: PathForms | null; warnings: string[] } {
  const existing = getProject(db, id);
  if (!existing) throw new HttpError(404, 'project_not_found');
  const ts = nowIso();
  let pathChanged = false;
  let forms: PathForms | null = null;
  const alias = patch.alias !== undefined ? validateAlias(patch.alias) : existing.alias;
  const vp = patch.path !== undefined ? validateProjectPath(patch.path) : null;
  if (vp) assertPathFree(db, vp.forms.lexical, id);
  db.transaction(() => {
    db.prepare('UPDATE projects SET alias = ?, description = ?, type = ?, archived = ?, updated_at = ? WHERE id = ?').run(
      alias,
      patch.description !== undefined ? String(patch.description).slice(0, 500) : existing.description,
      patch.type && (PROJECT_TYPES as readonly string[]).includes(patch.type) ? patch.type : existing.type,
      patch.archived !== undefined ? (patch.archived ? 1 : 0) : existing.archived ? 1 : 0,
      ts,
      id,
    );
    if (vp) {
      const prev = db.prepare('SELECT path_lexical, path_canonical FROM project_paths WHERE project_id = ?').get(id) as
        | { path_lexical: string; path_canonical: string | null }
        | undefined;
      pathChanged = !prev || prev.path_lexical !== vp.forms.lexical || prev.path_canonical !== vp.forms.canonical;
      db.prepare(
        `INSERT INTO project_paths (project_id, path_entered, path_lexical, path_canonical, path_exists, last_checked_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(project_id) DO UPDATE SET path_entered = excluded.path_entered, path_lexical = excluded.path_lexical,
           path_canonical = excluded.path_canonical, path_exists = excluded.path_exists, last_checked_at = excluded.last_checked_at`,
      ).run(id, vp.entered, vp.forms.lexical, vp.forms.canonical, vp.forms.canonical ? 1 : 0, ts);
      forms = vp.forms;
    }
  })();
  const warnings = aliasWarnings(alias, forms ?? projectRootFormsFor(db, id) ?? { lexical: '', canonical: null });
  return { project: getProject(db, id)!, pathChanged, forms, warnings };
}

export function deleteProject(db: DB, id: string): void {
  const r = db.prepare('DELETE FROM projects WHERE id = ?').run(id);
  if (r.changes === 0) throw new HttpError(404, 'project_not_found');
}

/** Edit-form only. */
export function getProjectPath(db: DB, id: string): { pathEntered: string; pathCanonical: string | null; exists: boolean } {
  const r = db.prepare('SELECT path_entered, path_canonical, path_exists FROM project_paths WHERE project_id = ?').get(id) as
    | { path_entered: string; path_canonical: string | null; path_exists: number }
    | undefined;
  if (!r) throw new HttpError(404, 'project_path_not_found');
  return { pathEntered: r.path_entered, pathCanonical: r.path_canonical, exists: r.path_exists === 1 };
}

/** Policy writer only: active (non-archived) roots. */
export function projectRoots(db: DB): Array<{ id: string; lexical: string; canonical: string | null }> {
  return (
    db
      .prepare(
        `SELECT pp.project_id AS id, pp.path_lexical AS lexical, pp.path_canonical AS canonical
         FROM project_paths pp JOIN projects p ON p.id = pp.project_id WHERE p.archived = 0`,
      )
      .all() as Array<{ id: string; lexical: string; canonical: string | null }>
  );
}

export function projectRootFormsFor(db: DB, id: string): PathForms | null {
  const r = db.prepare('SELECT path_lexical, path_canonical FROM project_paths WHERE project_id = ?').get(id) as
    | { path_lexical: string; path_canonical: string | null }
    | undefined;
  return r ? { lexical: r.path_lexical, canonical: r.path_canonical } : null;
}

/** Startup refresh: junction targets may have changed; missing dirs flip to lexical-only. */
export function refreshProjectPaths(db: DB): number {
  const rows = db.prepare('SELECT project_id, path_entered, path_canonical FROM project_paths').all() as Array<{
    project_id: string;
    path_entered: string;
    path_canonical: string | null;
  }>;
  let changed = 0;
  const upd = db.prepare('UPDATE project_paths SET path_canonical = ?, path_exists = ?, last_checked_at = ? WHERE project_id = ?');
  for (const r of rows) {
    const canonical = canonicalForm(r.path_entered);
    if (canonical !== r.path_canonical) changed++;
    upd.run(canonical, canonical ? 1 : 0, nowIso(), r.project_id);
  }
  return changed;
}

export function projectExists(db: DB, id: string): boolean {
  return !!db.prepare('SELECT 1 FROM projects WHERE id = ?').get(id);
}

// ---------------------------------------------------------------------------- settings
export function getSetting<T>(db: DB, key: string, fallback: T): T {
  const r = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
  if (!r) return fallback;
  try {
    return JSON.parse(r.value) as T;
  } catch {
    return fallback;
  }
}

export function setSetting(db: DB, key: string, value: unknown): void {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(
    key,
    JSON.stringify(value),
  );
}

// ---------------------------------------------------------------------------- robots
export interface RobotDTO {
  id: string;
  name: string;
  robotType: string;
  role: string;
  projectId: string | null;
  palette: RobotPalette;
}

export function assignRobot(db: DB, projectId: string | null, origin: SessionOrigin): RobotDTO {
  if (origin !== 'fork') {
    const free = db
      .prepare(
        `SELECT r.id FROM robots r
         WHERE (r.project_id IS ? OR r.project_id = ?)
           AND NOT EXISTS (SELECT 1 FROM sessions s WHERE s.robot_id = r.id AND s.status <> 'disconnected')
         ORDER BY r.created_at LIMIT 1`,
      )
      .get(projectId, projectId) as { id: string } | undefined;
    if (free) return getRobot(db, free.id)!;
  }
  const n = (db.prepare('SELECT COUNT(*) AS c FROM robots').get() as { c: number }).c + 1;
  const id = newId('bot');
  db.prepare('INSERT INTO robots (id, name, robot_type, role, project_id, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(
    id,
    `Unit-${String(n).padStart(2, '0')}`,
    'qa_analyst',
    'qa_analyst',
    projectId,
    nowIso(),
  );
  return getRobot(db, id)!;
}

type RobotRow = { id: string; name: string; robot_type: string; role: string; project_id: string | null; palette_json: string };
const robotDto = (r: RobotRow): RobotDTO => ({
  id: r.id,
  name: r.name,
  robotType: r.robot_type,
  role: r.role,
  projectId: r.project_id,
  palette: parsePalette(r.palette_json, r.robot_type),
});

export function getRobot(db: DB, id: string): RobotDTO | null {
  const r = db.prepare('SELECT id, name, robot_type, role, project_id, palette_json FROM robots WHERE id = ?').get(id) as RobotRow | undefined;
  return r ? robotDto(r) : null;
}

export function listRobots(db: DB): RobotDTO[] {
  return (db.prepare('SELECT id, name, robot_type, role, project_id, palette_json FROM robots ORDER BY created_at, id').all() as RobotRow[]).map(robotDto);
}

export interface RobotPatch {
  name?: unknown;
  robotType?: unknown;
  role?: unknown;
  palette?: unknown;
}

const ROBOT_NAME_RE = /^[^\\/:*?"<>|\u0000-\u001f]{1,30}$/;

/** Validates every field before writing any (all-or-nothing). */
export function updateRobot(db: DB, id: string, patch: RobotPatch): RobotDTO {
  const cur = getRobot(db, id);
  if (!cur) throw new HttpError(404, 'robot_not_found');
  let name = cur.name;
  let robotType = cur.robotType;
  let role = cur.role;
  let palette = cur.palette;
  if (patch.name !== undefined) {
    if (typeof patch.name !== 'string' || !ROBOT_NAME_RE.test(patch.name.trim())) throw new HttpError(400, 'name_invalid', 'Name must be 1-30 characters without path characters');
    name = patch.name.trim();
  }
  if (patch.robotType !== undefined) {
    if (!isRobotType(patch.robotType)) throw new HttpError(400, 'robot_type_invalid');
    robotType = patch.robotType;
  }
  if (patch.role !== undefined) {
    if (!isRobotType(patch.role)) throw new HttpError(400, 'role_invalid');
    role = patch.role;
  }
  if (patch.palette !== undefined) {
    const p = patch.palette as Partial<RobotPalette> | null;
    if (!p || typeof p !== 'object' || !isHexColor(p.primary) || !isHexColor(p.accent)) throw new HttpError(400, 'palette_invalid', 'Colours must be #rrggbb');
    palette = { primary: p.primary, accent: p.accent };
  }
  db.prepare('UPDATE robots SET name = ?, robot_type = ?, role = ?, palette_json = ? WHERE id = ?').run(name, robotType, role, JSON.stringify(palette), id);
  return getRobot(db, id)!;
}

// ---------------------------------------------------------------------------- sessions
type SessionRow = {
  session_id: string;
  project_id: string | null;
  folder_key: string | null;
  robot_id: string | null;
  origin: SessionOrigin;
  parent_session_id: string | null;
  model: string | null;
  permission_mode: string | null;
  started_at: number;
  ended_at: number | null;
  last_event_at: number;
  status: RobotStatus;
  status_source: StatusSource;
  flags_json: string;
  start_observed: number;
  last_rule: string | null;
};

export interface SessionMeta {
  projectId: string | null;
  folderKey: string | null;
  robotId: string | null;
  parentSessionId: string | null;
  model: string | null;
  permissionMode: string | null;
  lastRule: string | null;
}

export function loadSession(db: DB, sessionId: string): { state: SessionState; meta: SessionMeta } | undefined {
  const r = db.prepare('SELECT * FROM sessions WHERE session_id = ?').get(sessionId) as SessionRow | undefined;
  if (!r) return undefined;
  const drones: Record<string, DroneState> = {};
  for (const d of db.prepare('SELECT * FROM subagents WHERE session_id = ?').all(sessionId) as Array<{
    agent_id: string;
    agent_type: string;
    status: RobotStatus;
    status_source: StatusSource;
    started_at: number;
    stopped_at: number | null;
    turn_failed: number;
  }>) {
    drones[d.agent_id] = {
      agentId: d.agent_id,
      agentType: d.agent_type,
      status: d.status,
      statusSource: d.status_source,
      startedAt: d.started_at,
      stoppedAt: d.stopped_at,
      turnFailed: d.turn_failed === 1,
    };
  }
  const base = newSessionState(r.session_id, r.origin, r.start_observed === 1, r.started_at);
  let flags: SessionFlags = base.flags;
  try {
    flags = { ...base.flags, ...(JSON.parse(r.flags_json) as Partial<SessionFlags>) };
  } catch {
    /* keep defaults */
  }
  return {
    state: {
      ...base,
      status: r.status,
      statusSource: r.status_source,
      endedAt: r.ended_at,
      lastEventAt: r.last_event_at,
      flags,
      drones,
    },
    meta: {
      projectId: r.project_id,
      folderKey: r.folder_key,
      robotId: r.robot_id,
      parentSessionId: r.parent_session_id,
      model: r.model,
      permissionMode: r.permission_mode,
      lastRule: r.last_rule,
    },
  };
}

export function saveSession(db: DB, s: SessionState, meta: SessionMeta): void {
  db.prepare(
    `INSERT INTO sessions (session_id, project_id, folder_key, robot_id, origin, parent_session_id, model, permission_mode,
       started_at, ended_at, last_event_at, status, status_source, flags_json, start_observed, last_rule)
     VALUES (@session_id, @project_id, @folder_key, @robot_id, @origin, @parent_session_id, @model, @permission_mode,
       @started_at, @ended_at, @last_event_at, @status, @status_source, @flags_json, @start_observed, @last_rule)
     ON CONFLICT(session_id) DO UPDATE SET project_id = excluded.project_id, folder_key = excluded.folder_key,
       robot_id = excluded.robot_id, parent_session_id = excluded.parent_session_id, model = excluded.model,
       permission_mode = excluded.permission_mode, ended_at = excluded.ended_at, last_event_at = excluded.last_event_at,
       status = excluded.status, status_source = excluded.status_source, flags_json = excluded.flags_json,
       last_rule = excluded.last_rule`,
  ).run({
    session_id: s.sessionId,
    project_id: meta.projectId,
    folder_key: meta.folderKey,
    robot_id: meta.robotId,
    origin: s.origin,
    parent_session_id: meta.parentSessionId,
    model: meta.model,
    permission_mode: meta.permissionMode,
    started_at: s.startedAt,
    ended_at: s.endedAt,
    last_event_at: s.lastEventAt,
    status: s.status,
    status_source: s.statusSource,
    flags_json: JSON.stringify(s.flags),
    start_observed: s.startObserved ? 1 : 0,
    last_rule: meta.lastRule,
  });
  db.prepare('DELETE FROM subagents WHERE session_id = ?').run(s.sessionId);
  const ins = db.prepare(
    `INSERT INTO subagents (session_id, agent_id, agent_type, status, status_source, started_at, stopped_at, turn_failed)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const d of Object.values(s.drones)) {
    ins.run(s.sessionId, d.agentId, d.agentType, d.status, d.statusSource, d.startedAt, d.stoppedAt, d.turnFailed ? 1 : 0);
  }
}

export interface SessionDTO {
  sessionId: string;
  projectId: string | null;
  projectAlias: string | null;
  folderKeyShort: string | null;
  robot: RobotDTO | null;
  origin: SessionOrigin;
  parentSessionId: string | null;
  model: string | null;
  permissionMode: string | null;
  status: RobotStatus;
  statusSource: StatusSource;
  startObserved: boolean;
  startedAt: number;
  endedAt: number | null;
  lastEventAt: number;
  lastRule: string | null;
  backgroundTasksRunning: number;
  pendingPermissionTool: string | null;
  drones: DroneState[];
  /** Exactly what Claude Code's status line reported (if the status line is installed); null otherwise. */
  usage: UsageDTO | null;
}

export interface UsageDTO {
  modelName: string | null;
  costUsd: number | null;
  contextUsedPct: number | null;
  fiveHourPct: number | null;
  sevenDayPct: number | null;
  updatedAt: string;
}

function usageFor(db: DB, sessionId: string): UsageDTO | null {
  const r = db.prepare('SELECT * FROM statusline_snapshots WHERE session_id = ?').get(sessionId) as Record<string, unknown> | undefined;
  if (!r) return null;
  return {
    modelName: (r.model_name as string) ?? null,
    costUsd: (r.cost_usd as number) ?? null,
    contextUsedPct: (r.context_used_pct as number) ?? null,
    fiveHourPct: (r.five_hour_pct as number) ?? null,
    sevenDayPct: (r.seven_day_pct as number) ?? null,
    updatedAt: r.updated_at as string,
  };
}

export function sessionDto(db: DB, sessionId: string): SessionDTO | null {
  const loaded = loadSession(db, sessionId);
  if (!loaded) return null;
  const { state, meta } = loaded;
  const alias = meta.projectId
    ? ((db.prepare('SELECT alias FROM projects WHERE id = ?').get(meta.projectId) as { alias: string } | undefined)?.alias ?? null)
    : null;
  return {
    sessionId: state.sessionId,
    projectId: meta.projectId,
    projectAlias: alias,
    folderKeyShort: meta.folderKey ? meta.folderKey.split(':')[1]!.slice(0, 4) : null,
    robot: meta.robotId ? getRobot(db, meta.robotId) : null,
    origin: state.origin,
    parentSessionId: meta.parentSessionId,
    model: meta.model,
    permissionMode: meta.permissionMode,
    status: state.status,
    statusSource: state.statusSource,
    startObserved: state.startObserved,
    startedAt: state.startedAt,
    endedAt: state.endedAt,
    lastEventAt: state.lastEventAt,
    lastRule: meta.lastRule,
    backgroundTasksRunning: state.flags.backgroundTasksRunning,
    pendingPermissionTool: state.flags.pendingPermissionTool,
    drones: Object.values(state.drones),
    usage: usageFor(db, sessionId),
  };
}

export function listSessions(db: DB, limit = 100): SessionDTO[] {
  const ids = db.prepare('SELECT session_id FROM sessions ORDER BY last_event_at DESC LIMIT ?').all(limit) as Array<{
    session_id: string;
  }>;
  return ids.map((r) => sessionDto(db, r.session_id)!).filter(Boolean);
}

export function sessionIdsForTimers(db: DB): string[] {
  return (
    db
      .prepare(
        `SELECT DISTINCT s.session_id FROM sessions s LEFT JOIN subagents a ON a.session_id = s.session_id
         WHERE s.status = 'completed' OR a.stopped_at IS NOT NULL`,
      )
      .all() as Array<{ session_id: string }>
  ).map((r) => r.session_id);
}

// ---------------------------------------------------------------------------- folder keys
export function addFolderKeys(db: DB, sessionId: string, keys: string[]): void {
  const ins = db.prepare('INSERT OR IGNORE INTO session_folder_keys (session_id, key, kid, ord) VALUES (?, ?, ?, ?)');
  keys.forEach((k, i) => ins.run(sessionId, k, k.split(':')[0], i));
}

/** Re-link unassigned sessions whose folder keys (same kid) include one of the project's root keys. */
export function relinkSessions(db: DB, projectId: string, rootKeys: string[]): string[] {
  if (rootKeys.length === 0) return [];
  const placeholders = rootKeys.map(() => '?').join(',');
  const ids = (
    db
      .prepare(
        `SELECT DISTINCT s.session_id FROM sessions s JOIN session_folder_keys k ON k.session_id = s.session_id
         WHERE s.project_id IS NULL AND k.key IN (${placeholders})`,
      )
      .all(...rootKeys) as Array<{ session_id: string }>
  ).map((r) => r.session_id);
  const upd = db.prepare('UPDATE sessions SET project_id = ? WHERE session_id = ?');
  const updEv = db.prepare('UPDATE agent_events SET project_id = ? WHERE session_id = ? AND project_id IS NULL');
  db.transaction(() => {
    for (const id of ids) {
      upd.run(projectId, id);
      updEv.run(projectId, id);
    }
  })();
  return ids;
}

// ---------------------------------------------------------------------------- events
export interface EventDTO {
  id: string;
  sessionId: string;
  projectId: string | null;
  event: string;
  rawEventName: string | null;
  agentId: string | null;
  agentType: string | null;
  toolName: string | null;
  notificationType: string | null;
  source: string | null;
  reason: string | null;
  error: string | null;
  fileCategory: string | null;
  commandCategory: string | null;
  durationMs: number | null;
  statusAfter: RobotStatus;
  statusSourceAfter: StatusSource;
  rule: string;
  occurredAt: string;
  receivedAt: string;
}

export function eventRowToDto(r: Record<string, unknown>): EventDTO {
  return {
    id: r.id as string,
    sessionId: r.session_id as string,
    projectId: (r.project_id as string) ?? null,
    event: r.event as string,
    rawEventName: (r.raw_event_name as string) ?? null,
    agentId: (r.agent_id as string) ?? null,
    agentType: (r.agent_type as string) ?? null,
    toolName: (r.tool_name as string) ?? null,
    notificationType: (r.notification_type as string) ?? null,
    source: (r.source as string) ?? null,
    reason: (r.reason as string) ?? null,
    error: (r.error as string) ?? null,
    fileCategory: (r.file_category as string) ?? null,
    commandCategory: (r.command_category as string) ?? null,
    durationMs: (r.duration_ms as number) ?? null,
    statusAfter: r.status_after as RobotStatus,
    statusSourceAfter: r.status_source_after as StatusSource,
    rule: r.rule as string,
    occurredAt: r.occurred_at as string,
    receivedAt: r.received_at as string,
  };
}

export function listEvents(db: DB, sessionId: string, limit = 300): EventDTO[] {
  return (
    db
      .prepare('SELECT * FROM agent_events WHERE session_id = ? ORDER BY received_at DESC, rowid DESC LIMIT ?')
      .all(sessionId, limit) as Array<Record<string, unknown>>
  ).map(eventRowToDto);
}

export function eventExists(db: DB, dedupeKey: string): boolean {
  return !!db.prepare('SELECT 1 FROM agent_events WHERE dedupe_key = ?').get(dedupeKey);
}

// ---------------------------------------------------------------------------- notifications
export interface NotificationDTO {
  id: string;
  kind: string;
  priority: string;
  title: string;
  body: string;
  projectId: string | null;
  sessionId: string | null;
  createdAt: string;
  readAt: string | null;
}

export function insertNotification(db: DB, n: Omit<NotificationDTO, 'id' | 'createdAt' | 'readAt'>): NotificationDTO {
  const dto: NotificationDTO = { ...n, id: newId('ntf'), createdAt: nowIso(), readAt: null };
  db.prepare(
    'INSERT INTO notifications (id, kind, priority, title, body, project_id, session_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(dto.id, dto.kind, dto.priority, dto.title, dto.body, dto.projectId, dto.sessionId, dto.createdAt);
  return dto;
}

export function listNotifications(db: DB, limit = 100): NotificationDTO[] {
  return (
    db.prepare('SELECT * FROM notifications ORDER BY created_at DESC LIMIT ?').all(limit) as Array<Record<string, unknown>>
  ).map((r) => ({
    id: r.id as string,
    kind: r.kind as string,
    priority: r.priority as string,
    title: r.title as string,
    body: r.body as string,
    projectId: (r.project_id as string) ?? null,
    sessionId: (r.session_id as string) ?? null,
    createdAt: r.created_at as string,
    readAt: (r.read_at as string) ?? null,
  }));
}

export function markNotifications(db: DB, opts: { ids?: string[]; all?: boolean; read: boolean }): { changed: number; unread: number } {
  const at = opts.read ? nowIso() : null;
  let changed = 0;
  db.transaction(() => {
    if (opts.all) {
      changed = db.prepare(opts.read ? 'UPDATE notifications SET read_at = ? WHERE read_at IS NULL' : 'UPDATE notifications SET read_at = ? WHERE read_at IS NOT NULL').run(at).changes;
    } else {
      const upd = db.prepare('UPDATE notifications SET read_at = ? WHERE id = ?');
      for (const id of opts.ids ?? []) changed += upd.run(at, id).changes;
    }
  })();
  return { changed, unread: unreadCount(db) };
}

export function unreadCount(db: DB): number {
  return (db.prepare('SELECT COUNT(*) AS c FROM notifications WHERE read_at IS NULL').get() as { c: number }).c;
}

// ---------------------------------------------------------------------------- activity + project rooms
export interface ActivityDTO {
  id: string;
  sessionId: string;
  robotName: string | null;
  projectId: string | null;
  projectAlias: string | null;
  event: string;
  toolName: string | null;
  notificationType: string | null;
  fileCategory: string | null;
  commandCategory: string | null;
  agentType: string | null;
  statusAfter: string;
  statusSourceAfter: string;
  receivedAt: string;
}

/** Recent real events (metadata only), newest first. */
export function listActivity(db: DB, limit: number, projectId?: string): ActivityDTO[] {
  const rows = db
    .prepare(
      `SELECT e.id, e.session_id, r.name AS robot_name, e.project_id, p.alias AS project_alias, e.event, e.raw_event_name, e.tool_name,
              e.notification_type, e.file_category, e.command_category, e.agent_type, e.status_after, e.status_source_after, e.received_at
       FROM agent_events e
       LEFT JOIN sessions s ON s.session_id = e.session_id
       LEFT JOIN robots r ON r.id = s.robot_id
       LEFT JOIN projects p ON p.id = e.project_id
       ${projectId ? 'WHERE e.project_id = ?' : ''}
       ORDER BY e.received_at DESC, e.rowid DESC LIMIT ?`,
    )
    .all(...(projectId ? [projectId, limit] : [limit])) as Array<Record<string, string | null>>;
  return rows.map((r) => ({
    id: r.id!,
    sessionId: r.session_id!,
    robotName: r.robot_name ?? null,
    projectId: r.project_id ?? null,
    projectAlias: r.project_alias ?? null,
    event: r.event === 'other' ? (r.raw_event_name ?? 'other') : r.event!,
    toolName: r.tool_name ?? null,
    notificationType: r.notification_type ?? null,
    fileCategory: r.file_category ?? null,
    commandCategory: r.command_category ?? null,
    agentType: r.agent_type ?? null,
    statusAfter: r.status_after!,
    statusSourceAfter: r.status_source_after!,
    receivedAt: r.received_at!,
  }));
}

export interface ProjectRoomDTO {
  project: ProjectDTO;
  sessionCount: number;
  activeSessions: number;
  robotCount: number;
  byStatus: Record<string, number>;
  lastActivityAt: string | null;
}

export function projectRoom(db: DB, projectId: string): ProjectRoomDTO {
  const project = getProject(db, projectId);
  if (!project) throw new HttpError(404, 'project_not_found');
  const sessions = db.prepare('SELECT status, robot_id, last_event_at FROM sessions WHERE project_id = ?').all(projectId) as Array<{
    status: string;
    robot_id: string | null;
    last_event_at: number;
  }>;
  const byStatus: Record<string, number> = {};
  for (const s of sessions) byStatus[s.status] = (byStatus[s.status] ?? 0) + 1;
  const last = db.prepare('SELECT MAX(received_at) AS t FROM agent_events WHERE project_id = ?').get(projectId) as { t: string | null };
  return {
    project,
    sessionCount: sessions.length,
    activeSessions: sessions.filter((s) => s.status !== 'disconnected').length,
    robotCount: new Set(sessions.map((s) => s.robot_id).filter(Boolean)).size,
    byStatus,
    lastActivityAt: last.t,
  };
}

export interface RobotWithSessionDTO extends RobotDTO {
  /** The robot's most recent session (its current state), or null if it has none. */
  session: SessionDTO | null;
}

export function robotsWithSession(db: DB): RobotWithSessionDTO[] {
  const latest = db.prepare('SELECT session_id FROM sessions WHERE robot_id = ? ORDER BY last_event_at DESC LIMIT 1');
  return listRobots(db).map((r) => {
    const row = latest.get(r.id) as { session_id: string } | undefined;
    return { ...r, session: row ? sessionDto(db, row.session_id) : null };
  });
}
