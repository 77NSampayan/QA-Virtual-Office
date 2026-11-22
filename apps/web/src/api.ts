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
  projectId: string | null;
  palette: { primary: string; accent: string };
}
export interface ActivityItem {
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
  statusAfter: RobotStatus;
  statusSourceAfter: StatusSource;
  receivedAt: string;
}
export interface ProjectRoom {
  project: Project;
  sessionCount: number;
  activeSessions: number;
  robotCount: number;
  byStatus: Record<string, number>;
  lastActivityAt: string | null;
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
  readAt: string | null;
  sessionId: string | null;
  projectId: string | null;
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

export interface QaFlag {
  id: string;
  requirementId: string;
  type: string;
  note: string;
  relatedRequirementId: string | null;
  raisedBy: string;
  status: string;
  createdAt: string;
  resolvedAt: string | null;
  resolvedNote: string | null;
}
export interface QaRequirement {
  id: string;
  projectId: string;
  ref: string;
  title: string;
  text: string;
  source: string;
  kind: string;
  reviewStatus: string;
  authoredBy: string;
  openFlags: number;
  testCaseCount: number;
  approvedTestCaseCount: number;
  createdAt: string;
  updatedAt: string;
}
export interface QaRequirementDetail extends QaRequirement {
  flags: QaFlag[];
  testCases: Array<{ id: string; code: string; title: string; status: string }>;
}
export interface QaTestCase {
  id: string;
  projectId: string;
  code: string;
  scenario: string;
  title: string;
  description: string;
  preconditions: string;
  steps: string[];
  testData: string;
  expectedResult: string;
  priority: string;
  testType: string;
  assignedTester: string;
  requirementIds: string[];
  requirementRefs: string[];
  status: 'draft' | 'in_review' | 'approved' | 'rejected';
  authoredBy: string;
  approvedBy: string | null;
  approvedAt: string | null;
  rejectionNote: string;
  version: number;
  executionStatus: string;
  archived: boolean;
  createdAt: string;
  updatedAt: string;
}
export interface QaHistory {
  id: string;
  at: string;
  actor: string;
  action: string;
  fromStatus: string | null;
  toStatus: string | null;
  note: string;
  changes: Record<string, unknown>;
}
export interface QaTestCaseDetail extends QaTestCase {
  requirements: Array<{ id: string; ref: string; title: string }>;
  history: QaHistory[];
}
export interface QaRatio {
  numerator: number;
  denominator: number;
  percent: number | null;
}
export interface QaTraceability {
  rows: Array<{
    requirementId: string;
    ref: string;
    title: string;
    reviewStatus: string;
    openFlags: number;
    testCases: Array<{ id: string; code: string; title: string; status: string }>;
    covered: 'approved' | 'unapproved' | 'none';
  }>;
  summary: {
    requirements: number;
    testCases: number;
    requirementsWithApprovedTestCase: QaRatio;
    requirementsWithAnyTestCase: QaRatio;
    untracedTestCases: number;
    formulas: { approved: string; any: string };
  };
}
export interface QaImportResult {
  dryRun: boolean;
  wouldCreate: string[];
  created: string[];
  skippedExisting: string[];
  unparsed: string[];
  duplicates: string[];
  byPrefix: Record<string, number>;
}
export interface QaExecCounts {
  not_run: number;
  in_progress: number;
  passed: number;
  failed: number;
  blocked: number;
  skipped: number;
  total: number;
}
export interface QaRun {
  id: string;
  projectId: string;
  code: string;
  name: string;
  environment: string;
  build: string;
  status: 'open' | 'closed';
  createdBy: string;
  createdAt: string;
  closedAt: string | null;
  counts: QaExecCounts;
}
export interface QaExecution {
  id: string;
  runId: string;
  testCaseId: string;
  testCaseCode: string;
  title: string;
  priority: string;
  testType: string;
  caseVersion: number;
  caseChanged: boolean;
  status: string;
  executorKind: string;
  executedBy: string | null;
  note: string;
  actualResult: string;
  startedAt: string | null;
  completedAt: string | null;
  updatedAt: string;
  evidenceCount: number;
}
export interface QaEvidence {
  id: string;
  executionId: string;
  kind: 'note' | 'file';
  label: string;
  body: string;
  fileName: string | null;
  mime: string | null;
  sizeBytes: number | null;
  sha256: string | null;
  redacted: boolean;
  createdBy: string;
  createdAt: string;
}
export interface QaExecutionDetail extends QaExecution {
  run: QaRun;
  steps: string[];
  preconditions: string;
  testData: string;
  expectedResult: string;
  history: Array<{ id: string; at: string; actor: string; action: string; fromStatus: string | null; toStatus: string | null; note: string }>;
  evidence: QaEvidence[];
}
export interface QaExecutionSummary {
  approvedTestCases: number;
  passed: number;
  failed: number;
  blocked: number;
  skipped: number;
  pending: number;
  resultsRecorded: number;
  openRuns: number;
  passRate: QaRatio;
}
export interface QaDefect {
  id: string;
  projectId: string;
  code: string;
  title: string;
  description: string;
  steps: string;
  expectedResult: string;
  actualResult: string;
  environment: string;
  build: string;
  severity: string;
  priority: string;
  status: string;
  assignee: string;
  testCaseId: string | null;
  testCaseCode: string | null;
  executionId: string | null;
  runCode: string | null;
  duplicateOfId: string | null;
  duplicateOfCode: string | null;
  reportedBy: string;
  closedBy: string | null;
  closedAt: string | null;
  createdAt: string;
  updatedAt: string;
}
export interface QaDefectDetail extends QaDefect {
  history: Array<{ id: string; at: string; actor: string; action: string; fromStatus: string | null; toStatus: string | null; note: string }>;
}
export interface QaDefectInput {
  title: string;
  description?: string;
  steps?: string;
  expectedResult?: string;
  actualResult?: string;
  environment?: string;
  build?: string;
  severity?: string;
  priority?: string;
  assignee?: string;
}
export interface QaExploratory {
  id: string;
  projectId: string;
  code: string;
  charter: string;
  area: string;
  tester: string;
  timeboxMinutes: number;
  status: 'planned' | 'in_progress' | 'completed';
  summary: string;
  createdBy: string;
  createdAt: string;
  startedAt: string | null;
  endedAt: string | null;
  noteCount: number;
  bugCount: number;
}
export interface QaExploratoryDetail extends QaExploratory {
  notes: Array<{ id: string; kind: string; text: string; defectId: string | null; defectCode: string | null; createdBy: string; createdAt: string }>;
}
export interface QaTask {
  id: string;
  projectId: string;
  code: string;
  title: string;
  description: string;
  kind: string;
  priority: string;
  stage: string;
  assignee: string;
  dueDate: string | null;
  defectId: string | null;
  defectCode: string | null;
  testCaseId: string | null;
  testCaseCode: string | null;
  createdBy: string;
  completedBy: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
}
export interface QaTaskDetail extends QaTask {
  history: Array<{ id: string; at: string; actor: string; action: string; fromStage: string | null; toStage: string | null; note: string }>;
}
export interface QaSummary {
  requirements: number;
  testCases: number;
  testCasesAwaitingReview: number;
  execution: QaExecutionSummary;
  defects: { total: number; open: number; openBySeverity: Record<string, number> };
  tasks: { total: number; open: number; blocked: number };
}
export interface QaTestCaseInput {
  scenario?: string;
  title: string;
  description?: string;
  preconditions?: string;
  steps?: string[];
  testData?: string;
  expectedResult?: string;
  priority?: string;
  testType?: string;
  assignedTester?: string;
  requirementIds?: string[];
}

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
  ) {
    super(code);
  }
}

/** The server's error code plus its message (for validation details such as missing approval fields). */
export class ApiDetailError extends ApiError {
  constructor(
    status: number,
    code: string,
    public detail: string,
  ) {
    super(status, code);
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
  if (!res.ok) throw new ApiDetailError(res.status, data?.error ?? `HTTP ${res.status}`, data?.message ?? '');
  return data as T;
}

export const api = {
  demo: () => call<{ demo: boolean; banner: string }>('GET', '/api/demo'),
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
  robots: () => call<Robot[]>('GET', '/api/robots'),
  patchRobot: (id: string, p: Partial<{ name: string; robotType: string; role: string; palette: { primary: string; accent: string } }>) =>
    call<Robot>('PATCH', `/api/robots/${id}`, p),
  activity: (limit = 50, projectId?: string) =>
    call<ActivityItem[]>('GET', `/api/activity?limit=${limit}${projectId ? `&projectId=${encodeURIComponent(projectId)}` : ''}`),
  room: (id: string) => call<ProjectRoom>('GET', `/api/projects/${id}/room`),
  // ---- Manual QA
  requirements: (pid: string) => call<QaRequirement[]>('GET', `/api/projects/${pid}/requirements`),
  requirement: (id: string) => call<QaRequirementDetail>('GET', `/api/requirements/${id}`),
  createRequirement: (pid: string, b: { ref: string; title: string; text?: string; source?: string; kind?: string }) =>
    call<QaRequirement>('POST', `/api/projects/${pid}/requirements`, b),
  updateRequirement: (id: string, b: Partial<{ ref: string; title: string; text: string; source: string; kind: string; reviewStatus: string }>) =>
    call<QaRequirement>('PATCH', `/api/requirements/${id}`, b),
  deleteRequirement: (id: string) => call<{ ok: true }>('DELETE', `/api/requirements/${id}`),
  importRequirements: (pid: string, b: { text: string; source?: string; kind?: string; onlyPrefixes?: string[]; dryRun?: boolean }) =>
    call<QaImportResult>('POST', `/api/projects/${pid}/requirements/import`, b),
  runChecks: (pid: string) => call<{ requirementsChecked: number; raised: number }>('POST', `/api/projects/${pid}/requirements/checks`),
  raiseFlag: (rid: string, b: { type: string; note: string; relatedRequirementId?: string }) => call<QaFlag>('POST', `/api/requirements/${rid}/flags`, b),
  resolveFlag: (id: string, b: { status: 'resolved' | 'dismissed'; note?: string }) => call<QaFlag>('PATCH', `/api/flags/${id}`, b),
  testCases: (pid: string, f: Record<string, string> = {}) =>
    call<QaTestCase[]>('GET', `/api/projects/${pid}/test-cases?${new URLSearchParams(Object.entries(f).filter(([, v]) => v !== '')).toString()}`),
  testCase: (id: string) => call<QaTestCaseDetail>('GET', `/api/test-cases/${id}`),
  createTestCase: (pid: string, b: QaTestCaseInput) => call<QaTestCase>('POST', `/api/projects/${pid}/test-cases`, b),
  updateTestCase: (id: string, b: Partial<QaTestCaseInput>) => call<QaTestCase>('PATCH', `/api/test-cases/${id}`, b),
  transitionTestCase: (id: string, to: string, note = '') => call<QaTestCase>('POST', `/api/test-cases/${id}/transition`, { to, note }),
  archiveTestCase: (id: string, archived: boolean) => call<QaTestCase>('POST', `/api/test-cases/${id}/archive`, { archived }),
  traceability: (pid: string) => call<QaTraceability>('GET', `/api/projects/${pid}/traceability`),
  qaSummary: () => call<QaSummary>('GET', '/api/qa/summary'),
  defects: (pid: string, f: Record<string, string> = {}) =>
    call<QaDefect[]>('GET', `/api/projects/${pid}/defects?${new URLSearchParams(Object.entries(f).filter(([, v]) => v !== '')).toString()}`),
  defect: (id: string) => call<QaDefectDetail>('GET', `/api/defects/${id}`),
  createDefect: (pid: string, b: QaDefectInput) => call<QaDefect>('POST', `/api/projects/${pid}/defects`, b),
  defectFromExecution: (execId: string, b: Partial<QaDefectInput> = {}) => call<QaDefect>('POST', `/api/executions/${execId}/defect`, b),
  updateDefect: (id: string, b: Partial<QaDefectInput>) => call<QaDefect>('PATCH', `/api/defects/${id}`, b),
  transitionDefect: (id: string, b: { to: string; note?: string; duplicateOfId?: string }) => call<QaDefectDetail>('POST', `/api/defects/${id}/transition`, b),
  commentDefect: (id: string, note: string) => call<QaDefectDetail>('POST', `/api/defects/${id}/comments`, { note }),
  exploratorySessions: (pid: string) => call<QaExploratory[]>('GET', `/api/projects/${pid}/exploratory`),
  exploratory: (id: string) => call<QaExploratoryDetail>('GET', `/api/exploratory/${id}`),
  createExploratory: (pid: string, b: { charter: string; area?: string; tester?: string; timeboxMinutes?: number }) => call<QaExploratory>('POST', `/api/projects/${pid}/exploratory`, b),
  startExploratory: (id: string) => call<QaExploratory>('POST', `/api/exploratory/${id}/start`),
  completeExploratory: (id: string, summary: string) => call<QaExploratory>('POST', `/api/exploratory/${id}/complete`, { summary }),
  addExploratoryNote: (id: string, b: { kind: string; text: string }) => call<QaExploratoryDetail>('POST', `/api/exploratory/${id}/notes`, b),
  defectFromNote: (noteId: string, b: { severity?: string; priority?: string } = {}) => call<{ defect: QaDefect; session: QaExploratoryDetail }>('POST', `/api/exploratory-notes/${noteId}/defect`, b),
  tasks: (pid: string) => call<QaTask[]>('GET', `/api/projects/${pid}/tasks`),
  task: (id: string) => call<QaTaskDetail>('GET', `/api/tasks/${id}`),
  createTask: (pid: string, b: { title: string; description?: string; kind?: string; priority?: string; assignee?: string; dueDate?: string | null }) => call<QaTask>('POST', `/api/projects/${pid}/tasks`, b),
  updateTask: (id: string, b: Partial<{ title: string; description: string; kind: string; priority: string; assignee: string; dueDate: string | null }>) => call<QaTask>('PATCH', `/api/tasks/${id}`, b),
  moveTask: (id: string, to: string, note = '') => call<QaTaskDetail>('POST', `/api/tasks/${id}/move`, { to, note }),
  runs: (pid: string) => call<QaRun[]>('GET', `/api/projects/${pid}/test-runs`),
  createRun: (pid: string, b: { name: string; environment?: string; build?: string; testCaseIds?: string[]; addAllApproved?: boolean }) =>
    call<QaRun & { skipped: string[] }>('POST', `/api/projects/${pid}/test-runs`, b),
  run: (id: string) => call<QaRun & { executions: QaExecution[] }>('GET', `/api/test-runs/${id}`),
  addCasesToRun: (id: string, b: { testCaseIds?: string[]; addAllApproved?: boolean }) =>
    call<{ added: number; skipped: string[] }>('POST', `/api/test-runs/${id}/cases`, b),
  closeRun: (id: string) => call<QaRun>('POST', `/api/test-runs/${id}/close`),
  execution: (id: string) => call<QaExecutionDetail>('GET', `/api/executions/${id}`),
  setResult: (id: string, b: { status: string; note?: string; actualResult?: string }) => call<QaExecutionDetail>('POST', `/api/executions/${id}/result`, b),
  addEvidenceNote: (id: string, b: { label?: string; body: string }) => call<QaEvidence>('POST', `/api/executions/${id}/evidence/note`, b),
  addEvidenceFile: (id: string, b: { fileName: string; label?: string; dataBase64: string }) => call<QaEvidence>('POST', `/api/executions/${id}/evidence/file`, b),
  deleteEvidence: (id: string) => call<{ ok: true }>('DELETE', `/api/evidence/${id}`),
  markRead: (p: { ids?: string[]; all?: boolean; read?: boolean }) => call<{ changed: number; unread: number }>('POST', '/api/notifications/read', p),
};
