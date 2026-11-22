import type { DroneState, RobotStatus, StatusSource } from '@qavo/shared/statusMachine';

export interface Project {
  id: string;
  alias: string;
  description: string;
  type: string;
  archived: boolean;
  pathConfigured: boolean;
  pathStatus: 'ok' | 'missing' | 'unset';
}
export interface Robot {
  id: string;
  name: string;
  robotType: string;
  role: string;
}
export interface Session {
  sessionId: string;
  projectId: string | null;
  projectAlias: string | null;
  folderKeyShort: string | null;
  robot: Robot | null;
  origin: 'new' | 'resume' | 'fork' | 'resume_unlinked';
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
  usage: {
    modelName: string | null;
    costUsd: number | null;
    contextUsedPct: number | null;
    fiveHourPct: number | null;
    sevenDayPct: number | null;
    updatedAt: string;
  } | null;
}
export interface AgentEvent {
  id: string;
  sessionId: string;
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
  receivedAt: string;
}
export interface Notification {
  id: string;
  kind: string;
  priority: string;
  title: string;
  body: string;
  createdAt: string;
}
export interface IntegrationStatus {
  version: string;
  policyVersion: number;
  scope: 'registered' | 'all';
  hooks: {
    state: 'installed' | 'not_installed' | 'partial';
    forwarderPresent: boolean;
    forwarderUpToDate: boolean;
    statusLine: 'installed' | 'not_installed' | 'other_configured';
    statusLineUpToDate: boolean;
  };
  lastEventByType: Record<string, string | null>;
  lastHookEventAt: string | null;
  spool: { pendingEvents: number; pendingBytes: number; lastReplay: { at: string; applied: number; duplicates: number; invalid: number } | null };
  lastBackupAt: string | null;
  recovery: { at: string; reason: string; restoredFrom: string | null } | null;
  trustHint: string;
}
export interface Capture {
  prompts: boolean;
  toolInputs: boolean;
  toolOutputs: boolean;
  notificationText: boolean;
}
export interface SettingsState {
  scope: 'registered' | 'all';
  capture: Capture;
  retention: { eventDays: number; contentDays: number };
  excludeCount: number;
}
export interface PlanSummary {
  kind: 'hooks' | 'statusLine';
  action: 'install' | 'uninstall';
  noChange: boolean;
  willCreateBackup: boolean;
  eventsAdded: string[];
  eventsRemoved: string[];
  wrapsExistingStatusLine: boolean;
  restoresOriginalStatusLine: boolean;
  handler: Record<string, unknown> | null;
  warning: string | null;
}
export interface BackupInfo {
  name: string;
  bytes: number;
  createdAt: string;
}

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
  ) {
    super(code);
  }
}

/** Fired when the server answers 401 (no valid session cookie). */
export const unauthorizedListeners = new Set<() => void>();

async function call<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: { 'x-qavo-client': '1', ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    credentials: 'same-origin',
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (res.status === 401) for (const f of unauthorizedListeners) f();
  if (!res.ok) throw new ApiError(res.status, data?.error ?? `HTTP ${res.status}`);
  return data as T;
}

export const api = {
  projects: () => call<Project[]>('GET', '/api/projects'),
  createProject: (p: { alias: string; path: string; type: string }) =>
    call<{ project: Project; warnings: string[]; relinkedSessions: number }>('POST', '/api/projects', p),
  updateProject: (id: string, p: Partial<{ alias: string; path: string; type: string }>) =>
    call<{ project: Project; warnings: string[]; relinkedSessions: number }>('PATCH', `/api/projects/${id}`, p),
  deleteProject: (id: string) => call<{ ok: true }>('DELETE', `/api/projects/${id}`),
  projectPath: (id: string) => call<{ pathEntered: string; exists: boolean }>('GET', `/api/projects/${id}/path`),
  sessions: () => call<Session[]>('GET', '/api/sessions'),
  events: (sessionId: string) => call<AgentEvent[]>('GET', `/api/sessions/${encodeURIComponent(sessionId)}/events`),
  notifications: () => call<Notification[]>('GET', '/api/notifications'),
  integration: () => call<IntegrationStatus>('GET', '/api/integration/status'),
  authStatus: () => call<{ authRequired: boolean; authenticated: boolean }>('GET', '/api/auth/status'),
  logout: () => call<{ ok: true }>('POST', '/api/auth/logout'),
  settings: () => call<SettingsState>('GET', '/api/settings'),
  plan: (kind: string, action: string) => call<PlanSummary>('GET', `/api/integration/plan?kind=${kind}&action=${action}`),
  hooks: (action: 'install' | 'uninstall', acknowledge = false) =>
    call<{ changed: boolean; verified: boolean }>('POST', `/api/integration/hooks/${action}`, { acknowledge }),
  statusLine: (action: 'install' | 'uninstall', acknowledge = false) =>
    call<{ changed: boolean; verified: boolean; wrapped?: boolean }>('POST', `/api/integration/statusline/${action}`, { acknowledge }),
  setScope: (scope: string, confirm = false) => call<{ scope: string }>('PUT', '/api/settings/scope', { scope, confirm }),
  setPrivacy: (p: Partial<Capture> & { confirm?: boolean }) =>
    call<{ capture: Capture; purgeOffered: string[] }>('PUT', '/api/settings/privacy', p),
  purge: (kinds: string[] | 'all') => call<{ purged: number }>('POST', '/api/privacy/purge', { kinds }),
  excludes: () => call<{ paths: string[] }>('GET', '/api/settings/excludes'),
  setExcludes: (paths: string[]) => call<{ count: number }>('PUT', '/api/settings/excludes', { paths }),
  setRetention: (r: { eventDays: number; contentDays: number }) => call<typeof r>('PUT', '/api/settings/retention', r),
  runRetention: () => call<Record<string, number>>('POST', '/api/maintenance/retention'),
  backups: () => call<BackupInfo[]>('GET', '/api/backups'),
  createBackup: () => call<BackupInfo>('POST', '/api/backups'),
  integrity: () => call<{ ok: boolean; detail: string }>('POST', '/api/integrity/check'),
};
