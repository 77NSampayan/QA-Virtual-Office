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
  policyVersion: number;
  scope: 'registered' | 'all';
  hooks: { state: 'installed' | 'not_installed' | 'partial'; forwarderPresent: boolean; forwarderUpToDate: boolean };
}

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
  ) {
    super(code);
  }
}

async function call<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: { 'x-qavo-client': '1', ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    credentials: 'same-origin',
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) throw new ApiError(res.status, data?.message ?? data?.error ?? `HTTP ${res.status}`);
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
};
