/**
 * Event -> robot status transition machine (browser-safe, pure).
 * Implements the matrix in docs/event-schema.md (rows 1–32). Every transition reports the
 * matrix `rule` that produced it so the behaviour is traceable and testable.
 */
import { WRITE_TOOLS, type SanitizedEvent } from './events.ts';

export const ROBOT_STATUSES = [
  'idle',
  'analyzing',
  'writing_tests',
  'executing_tests',
  'debugging',
  'awaiting_permission',
  'awaiting_input',
  'completed',
  'failed',
  'disconnected',
] as const;
export type RobotStatus = (typeof ROBOT_STATUSES)[number];
/** 'event' = stated by the hook event itself; 'inferred' = interpreted from activity. */
export type StatusSource = 'event' | 'inferred';
export type SessionOrigin = 'new' | 'resume' | 'fork' | 'resume_unlinked';

export const COMPLETED_TO_IDLE_MS = 10 * 60_000;
export const DRONE_LINGER_MS = 60_000;

export interface SessionFlags {
  turnFailed: boolean;
  awaitingPermission: boolean;
  awaitingInput: boolean;
  pendingPermissionTool: string | null;
  lastPermissionSignalAt: number | null;
  /** agentId of the subagent whose prompt put the parent into awaiting_* (row 25). */
  awaitingFromAgent: string | null;
  backgroundTasksRunning: number;
}

export interface DroneState {
  agentId: string;
  agentType: string;
  status: RobotStatus;
  statusSource: StatusSource;
  startedAt: number;
  stoppedAt: number | null;
  turnFailed: boolean;
}

export interface SessionState {
  sessionId: string;
  status: RobotStatus;
  statusSource: StatusSource;
  origin: SessionOrigin;
  startObserved: boolean;
  startedAt: number;
  endedAt: number | null;
  lastEventAt: number;
  flags: SessionFlags;
  drones: Record<string, DroneState>;
}

export type MachineEvent = Pick<
  SanitizedEvent,
  | 'event'
  | 'toolName'
  | 'fileCategory'
  | 'commandCategory'
  | 'isInterrupt'
  | 'notificationType'
  | 'source'
  | 'agentId'
  | 'agentType'
  | 'error'
  | 'backgroundTasksRunning'
> & { at: number };

export type NotificationKind =
  | 'permission_required'
  | 'input_required'
  | 'waiting_for_user'
  | 'session_completed'
  | 'session_failed'
  | 'agent_completed'
  | 'auth_storage_failure';
export type NotificationPriority = 'high' | 'medium' | 'low' | 'info' | 'warning';

export type Effect =
  | { type: 'session_created'; origin: SessionOrigin }
  | {
      type: 'notify';
      kind: NotificationKind;
      priority: NotificationPriority;
      data: { toolName?: string; error?: string; agentType?: string; backgroundTasks?: number };
    }
  | { type: 'drone_created' | 'drone_updated' | 'drone_removed'; agentId: string };

export interface Transition {
  state: SessionState;
  effects: Effect[];
  /** Matrix row(s) applied, e.g. "29+5" for an unknown session's first PreToolUse. */
  rule: string;
}

const DEFAULT_FLAGS: SessionFlags = {
  turnFailed: false,
  awaitingPermission: false,
  awaitingInput: false,
  pendingPermissionTool: null,
  lastPermissionSignalAt: null,
  awaitingFromAgent: null,
  backgroundTasksRunning: 0,
};

export function newSessionState(
  sessionId: string,
  origin: SessionOrigin,
  startObserved: boolean,
  at: number,
): SessionState {
  return {
    sessionId,
    status: 'idle',
    statusSource: 'event',
    origin,
    startObserved,
    startedAt: at,
    endedAt: null,
    lastEventAt: at,
    flags: { ...DEFAULT_FLAGS },
    drones: {},
  };
}

function clone(s: SessionState): SessionState {
  return {
    ...s,
    flags: { ...s.flags },
    drones: Object.fromEntries(Object.entries(s.drones).map(([k, d]) => [k, { ...d }])),
  };
}

const PERMISSION_NOTIFICATIONS = new Set(['permission_prompt']);
const INPUT_NOTIFICATIONS = new Set(['elicitation_dialog', 'elicitation_url_dialog', 'agent_needs_input']);
const RESUME_NOTIFICATIONS = new Set(['elicitation_complete', 'elicitation_response']);
const TOOL_EVENTS = new Set(['PreToolUse', 'PostToolUse', 'PostToolUseFailure']);

/** Activity(tool) from the matrix header. */
export function activityFor(ev: MachineEvent, turnFailed: boolean): RobotStatus {
  if (ev.commandCategory === 'test_run') return 'executing_tests';
  if (ev.toolName && (WRITE_TOOLS as readonly string[]).includes(ev.toolName) && ev.fileCategory === 'test') {
    return 'writing_tests';
  }
  if (turnFailed) return 'debugging';
  return 'analyzing';
}

function set(s: SessionState, status: RobotStatus, source: StatusSource) {
  s.status = status;
  s.statusSource = source;
}

function clearAwaiting(f: SessionFlags) {
  f.awaitingPermission = false;
  f.awaitingInput = false;
  f.pendingPermissionTool = null;
  f.awaitingFromAgent = null;
}

function resetTurn(f: SessionFlags) {
  clearAwaiting(f);
  f.turnFailed = false;
}

function isAwaitingSignal(ev: MachineEvent): 'permission' | 'input' | 'idle_prompt' | null {
  if (ev.event === 'PermissionRequest') return 'permission';
  if (ev.event !== 'Notification' || !ev.notificationType) return null;
  if (PERMISSION_NOTIFICATIONS.has(ev.notificationType)) return 'permission';
  if (INPUT_NOTIFICATIONS.has(ev.notificationType)) return 'input';
  if (ev.notificationType === 'idle_prompt') return 'idle_prompt';
  return null;
}

/** Applies rows 11–14 to the parent session (shared by main-session and subagent paths). */
function applyAwaiting(
  s: SessionState,
  ev: MachineEvent,
  kind: 'permission' | 'input' | 'idle_prompt',
  effects: Effect[],
): string {
  if (kind === 'permission') {
    // One notification per unresolved permission episode. Real sessions send the
    // permission_prompt Notification ~6 s after PermissionRequest, so no time window is used.
    const recent = s.status === 'awaiting_permission' && s.flags.awaitingPermission;
    set(s, 'awaiting_permission', 'event');
    s.flags.awaitingPermission = true;
    s.flags.awaitingInput = false;
    if (ev.event === 'PermissionRequest' && ev.toolName) s.flags.pendingPermissionTool = ev.toolName;
    s.flags.lastPermissionSignalAt = ev.at;
    if (!recent) {
      effects.push({
        type: 'notify',
        kind: 'permission_required',
        priority: 'high',
        data: { toolName: s.flags.pendingPermissionTool ?? ev.toolName },
      });
    }
    return ev.event === 'PermissionRequest' ? '11' : '12';
  }
  set(s, 'awaiting_input', 'event');
  s.flags.awaitingInput = true;
  s.flags.awaitingPermission = false;
  if (kind === 'input') {
    effects.push({ type: 'notify', kind: 'input_required', priority: 'high', data: {} });
    return '13';
  }
  effects.push({ type: 'notify', kind: 'waiting_for_user', priority: 'low', data: {} });
  return '14';
}

function applyDroneTool(d: DroneState, ev: MachineEvent) {
  if (ev.event === 'PreToolUse') {
    d.status = activityFor(ev, d.turnFailed);
    d.statusSource = 'inferred';
  } else if (ev.event === 'PostToolUse') {
    if (ev.commandCategory === 'test_run') {
      d.turnFailed = false;
      d.status = 'analyzing';
      d.statusSource = 'inferred';
    } else if (d.status === 'awaiting_permission' || d.status === 'awaiting_input') {
      d.status = activityFor(ev, d.turnFailed);
      d.statusSource = 'inferred';
    }
  } else if (ev.event === 'PostToolUseFailure') {
    if (ev.isInterrupt) {
      d.turnFailed = false;
      d.status = 'idle';
      d.statusSource = 'event';
    } else {
      d.turnFailed = true;
      d.status = 'debugging';
      d.statusSource = 'inferred';
    }
  }
}

export function applyEvent(
  prev: SessionState | undefined,
  sessionId: string,
  ev: MachineEvent,
): Transition {
  const effects: Effect[] = [];
  const rules: string[] = [];
  let s: SessionState;

  // ---- SessionStart (rows 1, 2a, 2b, 2c, 3) -------------------------------------------------
  if (ev.event === 'SessionStart') {
    const src = ev.source;
    if (src === 'fork') {
      if (prev) {
        s = clone(prev);
      } else {
        s = newSessionState(sessionId, 'fork', true, ev.at);
        effects.push({ type: 'session_created', origin: 'fork' });
      }
      resetTurn(s.flags);
      s.endedAt = null;
      set(s, 'idle', 'event');
      rules.push('2b');
    } else if (src === 'resume') {
      if (prev) {
        s = clone(prev);
        rules.push('2a');
      } else {
        s = newSessionState(sessionId, 'resume_unlinked', true, ev.at);
        effects.push({ type: 'session_created', origin: 'resume_unlinked' });
        rules.push('2c');
      }
      resetTurn(s.flags);
      s.endedAt = null;
      set(s, 'idle', 'event');
    } else if (src === 'compact') {
      if (prev) {
        s = clone(prev);
      } else {
        s = newSessionState(sessionId, 'new', true, ev.at);
        effects.push({ type: 'session_created', origin: 'new' });
      }
      if (s.status === 'disconnected') {
        s.endedAt = null;
        set(s, 'idle', 'event');
      }
      rules.push('3');
    } else {
      if (prev) {
        s = clone(prev);
      } else {
        s = newSessionState(sessionId, 'new', true, ev.at);
        effects.push({ type: 'session_created', origin: 'new' });
      }
      resetTurn(s.flags);
      s.endedAt = null;
      set(s, 'idle', 'event');
      rules.push('1');
    }
    s.lastEventAt = ev.at;
    return { state: s, effects, rule: rules.join('+') };
  }

  // ---- All other events --------------------------------------------------------------------
  if (prev) {
    s = clone(prev);
  } else {
    s = newSessionState(sessionId, 'new', false, ev.at);
    effects.push({ type: 'session_created', origin: 'new' });
    rules.push('29');
  }
  if (s.endedAt !== null && ev.event !== 'SessionEnd') {
    s.endedAt = null;
    rules.push('30');
  }
  s.lastEventAt = ev.at;

  const drone = ev.agentId ? s.drones[ev.agentId] : undefined;

  // ---- Events from inside a known subagent (rows 24–26) -----------------------------------
  if (drone && ev.event !== 'SubagentStart' && ev.event !== 'SubagentStop') {
    if (TOOL_EVENTS.has(ev.event)) {
      applyDroneTool(drone, ev);
      if (s.flags.awaitingFromAgent === drone.agentId && ev.event !== 'PostToolUseFailure') {
        clearAwaiting(s.flags);
        set(s, 'analyzing', 'inferred');
      }
      effects.push({ type: 'drone_updated', agentId: drone.agentId });
      rules.push('24');
      return { state: s, effects, rule: rules.join('+') };
    }
    const kind = isAwaitingSignal(ev);
    if (kind) {
      drone.status = kind === 'permission' ? 'awaiting_permission' : 'awaiting_input';
      drone.statusSource = 'event';
      applyAwaiting(s, ev, kind, effects);
      s.flags.awaitingFromAgent = drone.agentId;
      effects.push({ type: 'drone_updated', agentId: drone.agentId });
      rules.push('25');
      return { state: s, effects, rule: rules.join('+') };
    }
    if (ev.event === 'Stop') {
      drone.status = 'completed';
      drone.statusSource = 'event';
      drone.stoppedAt = ev.at;
      effects.push({ type: 'drone_updated', agentId: drone.agentId });
      rules.push('26');
      return { state: s, effects, rule: rules.join('+') };
    }
    // other subagent-scoped events fall through to main-session handling
  }

  switch (ev.event) {
    case 'UserPromptSubmit':
      resetTurn(s.flags);
      set(s, 'analyzing', 'inferred');
      rules.push('4');
      break;

    case 'PreToolUse':
      clearAwaiting(s.flags);
      set(s, activityFor(ev, s.flags.turnFailed), 'inferred');
      rules.push('5');
      break;

    case 'PostToolUse':
      if (ev.commandCategory === 'test_run') {
        s.flags.turnFailed = false;
        clearAwaiting(s.flags);
        set(s, 'analyzing', 'inferred');
        rules.push('7');
      } else if (s.status === 'awaiting_permission') {
        clearAwaiting(s.flags);
        set(s, activityFor(ev, s.flags.turnFailed), 'inferred');
        rules.push('6');
      } else {
        rules.push('8');
      }
      break;

    case 'PostToolUseFailure':
      if (ev.isInterrupt) {
        resetTurn(s.flags);
        set(s, 'idle', 'event');
        rules.push('9');
      } else {
        clearAwaiting(s.flags);
        s.flags.turnFailed = true;
        set(s, 'debugging', 'inferred');
        rules.push('10');
      }
      break;

    case 'PermissionRequest':
      rules.push(applyAwaiting(s, ev, 'permission', effects));
      break;

    case 'Notification': {
      const kind = isAwaitingSignal(ev);
      if (kind) {
        rules.push(applyAwaiting(s, ev, kind, effects));
      } else if (ev.notificationType && RESUME_NOTIFICATIONS.has(ev.notificationType)) {
        clearAwaiting(s.flags);
        set(s, 'analyzing', 'inferred');
        rules.push('15');
      } else if (ev.notificationType === 'agent_completed') {
        effects.push({ type: 'notify', kind: 'agent_completed', priority: 'info', data: {} });
        rules.push('16');
      } else if (ev.notificationType === 'auth_storage_failure') {
        effects.push({ type: 'notify', kind: 'auth_storage_failure', priority: 'warning', data: {} });
        rules.push('17');
      } else {
        rules.push('18');
      }
      break;
    }

    case 'Stop':
      resetTurn(s.flags);
      s.flags.backgroundTasksRunning = ev.backgroundTasksRunning ?? 0;
      set(s, 'completed', 'event');
      effects.push({
        type: 'notify',
        kind: 'session_completed',
        priority: 'low',
        data: { backgroundTasks: s.flags.backgroundTasksRunning },
      });
      rules.push('19');
      break;

    case 'StopFailure':
      resetTurn(s.flags);
      set(s, 'failed', 'event');
      effects.push({ type: 'notify', kind: 'session_failed', priority: 'high', data: { error: ev.error ?? 'unknown' } });
      rules.push('20');
      break;

    case 'SubagentStart':
      if (ev.agentId && ev.agentType) {
        s.drones[ev.agentId] = {
          agentId: ev.agentId,
          agentType: ev.agentType,
          status: 'analyzing',
          statusSource: 'inferred',
          startedAt: ev.at,
          stoppedAt: null,
          turnFailed: false,
        };
        effects.push({ type: 'drone_created', agentId: ev.agentId });
      }
      rules.push('21');
      break;

    case 'SubagentStop': {
      const d = ev.agentId ? s.drones[ev.agentId] : undefined;
      if (d) {
        d.status = 'completed';
        d.statusSource = 'event';
        d.stoppedAt = ev.at;
        effects.push({ type: 'drone_updated', agentId: d.agentId });
        if (s.flags.awaitingFromAgent === d.agentId) {
          clearAwaiting(s.flags);
          set(s, 'analyzing', 'inferred');
        }
      }
      rules.push('22');
      break;
    }

    case 'SessionEnd':
      resetTurn(s.flags);
      for (const id of Object.keys(s.drones)) effects.push({ type: 'drone_removed', agentId: id });
      s.drones = {};
      s.endedAt = ev.at;
      set(s, 'disconnected', 'event');
      rules.push('23');
      break;

    default:
      rules.push('31');
      break;
  }

  return { state: s, effects, rule: rules.join('+') };
}

/** Timer rules: 27 (completed -> idle after 10 min) and drone lingering removal (row 22). Row 28: nothing else changes on silence. */
export function applyTimers(prev: SessionState, now: number): Transition | null {
  let changed = false;
  const s = clone(prev);
  const effects: Effect[] = [];
  const rules: string[] = [];
  if (s.status === 'completed' && now - s.lastEventAt >= COMPLETED_TO_IDLE_MS) {
    set(s, 'idle', 'inferred');
    changed = true;
    rules.push('27');
  }
  for (const d of Object.values(s.drones)) {
    if (d.stoppedAt !== null && now - d.stoppedAt >= DRONE_LINGER_MS) {
      delete s.drones[d.agentId];
      effects.push({ type: 'drone_removed', agentId: d.agentId });
      changed = true;
      if (!rules.includes('22t')) rules.push('22t');
    }
  }
  return changed ? { state: s, effects, rule: rules.join('+') } : null;
}
