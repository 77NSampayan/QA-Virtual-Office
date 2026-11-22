/**
 * One test per row of the event -> status matrix (docs/event-schema.md). Row 32 (duplicate
 * events) is enforced at persistence time and tested in apps/server/test/collector.test.ts.
 */
import { describe, it, expect } from 'vitest';
import {
  applyEvent,
  applyTimers,
  newSessionState,
  COMPLETED_TO_IDLE_MS,
  DRONE_LINGER_MS,
  type MachineEvent,
  type SessionState,
  type RobotStatus,
  type StatusSource,
} from '../src/statusMachine.ts';

const SID = 'sess-1';
const T0 = 1_000_000;
const ev = (e: Partial<MachineEvent> & { event: MachineEvent['event'] }, at = T0 + 1000): MachineEvent => ({ at, ...e });

function state(over: Partial<SessionState> = {}, flags: Partial<SessionState['flags']> = {}): SessionState {
  const s = newSessionState(SID, 'new', true, T0);
  return { ...s, ...over, flags: { ...s.flags, ...flags } };
}
function withDrone(s: SessionState, agentId = 'agent-1', agentType = 'Explore'): SessionState {
  return {
    ...s,
    drones: {
      [agentId]: { agentId, agentType, status: 'analyzing', statusSource: 'inferred', startedAt: T0, stoppedAt: null, turnFailed: false },
    },
  };
}

interface Row {
  row: string;
  prev?: SessionState;
  event: MachineEvent;
  status: RobotStatus;
  source: StatusSource;
  check?: (t: ReturnType<typeof applyEvent>) => void;
}

const notifyKinds = (t: ReturnType<typeof applyEvent>) =>
  t.effects.filter((e) => e.type === 'notify').map((e) => (e as { kind: string }).kind);

const rows: Row[] = [
  {
    row: '1',
    event: ev({ event: 'SessionStart', source: 'startup' }),
    status: 'idle',
    source: 'event',
    check: (t) => {
      expect(t.effects).toContainEqual({ type: 'session_created', origin: 'new' });
      expect(t.state.startObserved).toBe(true);
    },
  },
  {
    row: '1',
    prev: state({ status: 'debugging', statusSource: 'inferred' }, { turnFailed: true, awaitingInput: true }),
    event: ev({ event: 'SessionStart', source: 'clear' }),
    status: 'idle',
    source: 'event',
    check: (t) => {
      expect(t.state.flags.turnFailed).toBe(false);
      expect(t.state.flags.awaitingInput).toBe(false);
      expect(t.effects).toEqual([]);
    },
  },
  {
    row: '2a',
    prev: state({ status: 'disconnected', endedAt: T0 + 10, origin: 'new' }),
    event: ev({ event: 'SessionStart', source: 'resume' }),
    status: 'idle',
    source: 'event',
    check: (t) => {
      expect(t.state.origin).toBe('new'); // same session & robot kept
      expect(t.state.endedAt).toBeNull();
      expect(t.effects.find((e) => e.type === 'session_created')).toBeUndefined();
    },
  },
  {
    row: '2b',
    event: ev({ event: 'SessionStart', source: 'fork' }),
    status: 'idle',
    source: 'event',
    check: (t) => {
      expect(t.state.origin).toBe('fork');
      expect(t.effects).toContainEqual({ type: 'session_created', origin: 'fork' });
    },
  },
  {
    row: '2c',
    event: ev({ event: 'SessionStart', source: 'resume' }),
    status: 'idle',
    source: 'event',
    check: (t) => {
      expect(t.state.origin).toBe('resume_unlinked');
      expect(t.effects).toContainEqual({ type: 'session_created', origin: 'resume_unlinked' });
    },
  },
  {
    row: '3',
    prev: state({ status: 'executing_tests', statusSource: 'inferred' }),
    event: ev({ event: 'SessionStart', source: 'compact' }),
    status: 'executing_tests',
    source: 'inferred',
  },
  {
    row: '3',
    prev: state({ status: 'disconnected', endedAt: T0 }),
    event: ev({ event: 'SessionStart', source: 'compact' }),
    status: 'idle',
    source: 'event',
  },
  {
    row: '4',
    prev: state({ status: 'completed' }, { turnFailed: true, awaitingInput: true }),
    event: ev({ event: 'UserPromptSubmit' }),
    status: 'analyzing',
    source: 'inferred',
    check: (t) => expect(t.state.flags).toMatchObject({ turnFailed: false, awaitingInput: false, awaitingPermission: false }),
  },
  {
    row: '5',
    prev: state({ status: 'analyzing' }),
    event: ev({ event: 'PreToolUse', toolName: 'Bash', commandCategory: 'test_run' }),
    status: 'executing_tests',
    source: 'inferred',
  },
  {
    row: '5',
    prev: state({ status: 'analyzing' }),
    event: ev({ event: 'PreToolUse', toolName: 'Write', fileCategory: 'test' }),
    status: 'writing_tests',
    source: 'inferred',
  },
  {
    row: '5',
    prev: state({ status: 'debugging' }, { turnFailed: true }),
    event: ev({ event: 'PreToolUse', toolName: 'Read', fileCategory: 'source' }),
    status: 'debugging',
    source: 'inferred',
  },
  {
    row: '5',
    prev: state({ status: 'awaiting_input', statusSource: 'event' }, { awaitingInput: true }),
    event: ev({ event: 'PreToolUse', toolName: 'Grep' }),
    status: 'analyzing',
    source: 'inferred',
    check: (t) => expect(t.state.flags.awaitingInput).toBe(false),
  },
  {
    row: '6',
    prev: state({ status: 'awaiting_permission', statusSource: 'event' }, { awaitingPermission: true, pendingPermissionTool: 'Edit' }),
    event: ev({ event: 'PostToolUse', toolName: 'Edit', fileCategory: 'test' }),
    status: 'writing_tests',
    source: 'inferred',
    check: (t) => expect(t.state.flags).toMatchObject({ awaitingPermission: false, pendingPermissionTool: null }),
  },
  {
    row: '7',
    prev: state({ status: 'executing_tests' }, { turnFailed: true }),
    event: ev({ event: 'PostToolUse', toolName: 'Bash', commandCategory: 'test_run' }),
    status: 'analyzing',
    source: 'inferred',
    check: (t) => expect(t.state.flags.turnFailed).toBe(false),
  },
  {
    row: '8',
    prev: state({ status: 'writing_tests', statusSource: 'inferred' }),
    event: ev({ event: 'PostToolUse', toolName: 'Write', fileCategory: 'test' }),
    status: 'writing_tests',
    source: 'inferred',
  },
  {
    row: '9',
    prev: state(
      { status: 'awaiting_permission', statusSource: 'event' },
      { turnFailed: true, awaitingPermission: true, awaitingInput: true, pendingPermissionTool: 'Bash', awaitingFromAgent: 'agent-x' },
    ),
    event: ev({ event: 'PostToolUseFailure', toolName: 'Bash', isInterrupt: true }),
    status: 'idle',
    source: 'event',
    check: (t) =>
      expect(t.state.flags).toMatchObject({
        turnFailed: false,
        awaitingPermission: false,
        awaitingInput: false,
        pendingPermissionTool: null,
        awaitingFromAgent: null,
      }),
  },
  {
    row: '10',
    prev: state({ status: 'executing_tests' }),
    event: ev({ event: 'PostToolUseFailure', toolName: 'Bash', error: 'Exit code 1' }),
    status: 'debugging',
    source: 'inferred',
    check: (t) => expect(t.state.flags.turnFailed).toBe(true),
  },
  {
    row: '11',
    prev: state({ status: 'analyzing' }),
    event: ev({ event: 'PermissionRequest', toolName: 'Bash' }),
    status: 'awaiting_permission',
    source: 'event',
    check: (t) => {
      expect(t.effects).toContainEqual({ type: 'notify', kind: 'permission_required', priority: 'high', data: { toolName: 'Bash' } });
      expect(t.state.flags.pendingPermissionTool).toBe('Bash');
    },
  },
  {
    row: '12',
    prev: state({ status: 'analyzing' }),
    event: ev({ event: 'Notification', notificationType: 'permission_prompt' }),
    status: 'awaiting_permission',
    source: 'event',
    check: (t) => expect(notifyKinds(t)).toEqual(['permission_required']),
  },
  {
    row: '12',
    // deduped: PermissionRequest already notified 2 s ago
    prev: state({ status: 'awaiting_permission', statusSource: 'event' }, { awaitingPermission: true, lastPermissionSignalAt: T0 - 1000, pendingPermissionTool: 'Bash' }),
    event: ev({ event: 'Notification', notificationType: 'permission_prompt' }),
    status: 'awaiting_permission',
    source: 'event',
    check: (t) => expect(notifyKinds(t)).toEqual([]),
  },
  ...(['elicitation_dialog', 'elicitation_url_dialog', 'agent_needs_input'] as const).map(
    (nt): Row => ({
      row: '13',
      prev: state({ status: 'analyzing' }),
      event: ev({ event: 'Notification', notificationType: nt }),
      status: 'awaiting_input',
      source: 'event',
      check: (t) => expect(t.effects).toContainEqual({ type: 'notify', kind: 'input_required', priority: 'high', data: {} }),
    }),
  ),
  {
    row: '14',
    prev: state({ status: 'completed' }),
    event: ev({ event: 'Notification', notificationType: 'idle_prompt' }),
    status: 'awaiting_input',
    source: 'event',
    check: (t) => expect(t.effects).toContainEqual({ type: 'notify', kind: 'waiting_for_user', priority: 'low', data: {} }),
  },
  ...(['elicitation_complete', 'elicitation_response'] as const).map(
    (nt): Row => ({
      row: '15',
      prev: state({ status: 'awaiting_input', statusSource: 'event' }, { awaitingInput: true }),
      event: ev({ event: 'Notification', notificationType: nt }),
      status: 'analyzing',
      source: 'inferred',
      check: (t) => expect(t.state.flags.awaitingInput).toBe(false),
    }),
  ),
  {
    row: '16',
    prev: state({ status: 'analyzing', statusSource: 'inferred' }),
    event: ev({ event: 'Notification', notificationType: 'agent_completed' }),
    status: 'analyzing',
    source: 'inferred',
    check: (t) => expect(t.effects).toContainEqual({ type: 'notify', kind: 'agent_completed', priority: 'info', data: {} }),
  },
  {
    row: '17',
    prev: state({ status: 'idle' }),
    event: ev({ event: 'Notification', notificationType: 'auth_storage_failure' }),
    status: 'idle',
    source: 'event',
    check: (t) => expect(t.effects).toContainEqual({ type: 'notify', kind: 'auth_storage_failure', priority: 'warning', data: {} }),
  },
  ...(['auth_success', 'quota_auto_resume_scheduled', 'plugin_notification', 'something_new'] as const).map(
    (nt): Row => ({
      row: '18',
      prev: state({ status: 'writing_tests', statusSource: 'inferred' }),
      event: ev({ event: 'Notification', notificationType: nt }),
      status: 'writing_tests',
      source: 'inferred',
      check: (t) => expect(t.effects).toEqual([]),
    }),
  ),
  {
    row: '19',
    prev: state({ status: 'analyzing' }, { turnFailed: true }),
    event: ev({ event: 'Stop', backgroundTasksRunning: 2 }),
    status: 'completed',
    source: 'event',
    check: (t) => {
      expect(t.state.flags.turnFailed).toBe(false);
      expect(t.state.flags.backgroundTasksRunning).toBe(2);
      expect(t.effects).toContainEqual({ type: 'notify', kind: 'session_completed', priority: 'low', data: { backgroundTasks: 2 } });
    },
  },
  {
    row: '20',
    prev: state({ status: 'analyzing' }),
    event: ev({ event: 'StopFailure', error: 'rate_limit' }),
    status: 'failed',
    source: 'event',
    check: (t) => expect(t.effects).toContainEqual({ type: 'notify', kind: 'session_failed', priority: 'high', data: { error: 'rate_limit' } }),
  },
  {
    row: '21',
    prev: state({ status: 'analyzing', statusSource: 'inferred' }),
    event: ev({ event: 'SubagentStart', agentId: 'agent-1', agentType: 'Explore' }),
    status: 'analyzing',
    source: 'inferred',
    check: (t) => {
      expect(t.state.drones['agent-1']).toMatchObject({ status: 'analyzing', agentType: 'Explore' });
      expect(t.effects).toContainEqual({ type: 'drone_created', agentId: 'agent-1' });
    },
  },
  {
    row: '21',
    // internal agent (empty agent_type) is not drawn
    prev: state({ status: 'analyzing', statusSource: 'inferred' }),
    event: ev({ event: 'SubagentStart', agentId: 'agent-int', agentType: '' }),
    status: 'analyzing',
    source: 'inferred',
    check: (t) => expect(t.state.drones).toEqual({}),
  },
  {
    row: '22',
    prev: withDrone(state({ status: 'analyzing', statusSource: 'inferred' })),
    event: ev({ event: 'SubagentStop', agentId: 'agent-1', agentType: 'Explore' }),
    status: 'analyzing',
    source: 'inferred',
    check: (t) => expect(t.state.drones['agent-1']).toMatchObject({ status: 'completed', stoppedAt: T0 + 1000 }),
  },
  {
    row: '22',
    // internal agent stop: nothing drawn, nothing changed
    prev: state({ status: 'analyzing', statusSource: 'inferred' }),
    event: ev({ event: 'SubagentStop', agentId: 'agent-int', agentType: '' }),
    status: 'analyzing',
    source: 'inferred',
    check: (t) => expect(t.effects).toEqual([]),
  },
  {
    row: '23',
    prev: withDrone(state({ status: 'completed' })),
    event: ev({ event: 'SessionEnd' }),
    status: 'disconnected',
    source: 'event',
    check: (t) => {
      expect(t.state.endedAt).toBe(T0 + 1000);
      expect(t.state.drones).toEqual({});
      expect(t.effects).toContainEqual({ type: 'drone_removed', agentId: 'agent-1' });
    },
  },
  {
    row: '24',
    prev: withDrone(state({ status: 'analyzing', statusSource: 'inferred' })),
    event: ev({ event: 'PreToolUse', agentId: 'agent-1', toolName: 'Bash', commandCategory: 'test_run' }),
    status: 'analyzing',
    source: 'inferred',
    check: (t) => expect(t.state.drones['agent-1']!.status).toBe('executing_tests'),
  },
  {
    row: '24',
    prev: withDrone(state({ status: 'analyzing', statusSource: 'inferred' })),
    event: ev({ event: 'PostToolUseFailure', agentId: 'agent-1', toolName: 'Bash' }),
    status: 'analyzing',
    source: 'inferred',
    check: (t) => {
      expect(t.state.drones['agent-1']).toMatchObject({ status: 'debugging', turnFailed: true });
      expect(t.state.flags.turnFailed).toBe(false); // parent untouched
    },
  },
  {
    row: '25',
    prev: withDrone(state({ status: 'analyzing', statusSource: 'inferred' })),
    event: ev({ event: 'PermissionRequest', agentId: 'agent-1', toolName: 'Write' }),
    status: 'awaiting_permission',
    source: 'event',
    check: (t) => {
      expect(t.state.drones['agent-1']!.status).toBe('awaiting_permission');
      expect(t.state.flags.awaitingFromAgent).toBe('agent-1');
      expect(notifyKinds(t)).toEqual(['permission_required']);
    },
  },
  {
    row: '25',
    prev: withDrone(state({ status: 'analyzing', statusSource: 'inferred' })),
    event: ev({ event: 'Notification', agentId: 'agent-1', notificationType: 'agent_needs_input' }),
    status: 'awaiting_input',
    source: 'event',
    check: (t) => expect(t.state.drones['agent-1']!.status).toBe('awaiting_input'),
  },
  {
    row: '26',
    prev: withDrone(state({ status: 'analyzing', statusSource: 'inferred' })),
    event: ev({ event: 'Stop', agentId: 'agent-1' }),
    status: 'analyzing',
    source: 'inferred',
    check: (t) => expect(t.state.drones['agent-1']).toMatchObject({ status: 'completed', stoppedAt: T0 + 1000 }),
  },
  {
    row: '29+5',
    event: ev({ event: 'PreToolUse', toolName: 'Read' }),
    status: 'analyzing',
    source: 'inferred',
    check: (t) => {
      expect(t.state.startObserved).toBe(false);
      expect(t.effects).toContainEqual({ type: 'session_created', origin: 'new' });
    },
  },
  {
    row: '30+4',
    prev: state({ status: 'disconnected', endedAt: T0 }),
    event: ev({ event: 'UserPromptSubmit' }),
    status: 'analyzing',
    source: 'inferred',
    check: (t) => expect(t.state.endedAt).toBeNull(),
  },
  {
    row: '31',
    prev: state({ status: 'executing_tests', statusSource: 'inferred' }),
    event: ev({ event: 'other' }),
    status: 'executing_tests',
    source: 'inferred',
    check: (t) => expect(t.state.lastEventAt).toBe(T0 + 1000),
  },
];

describe('status machine matrix', () => {
  it.each(rows.map((r, i) => [`row ${r.row} #${i}`, r] as const))('%s', (_n, r) => {
    const t = applyEvent(r.prev, SID, r.event);
    expect(t.rule).toBe(r.row);
    expect(t.state.status).toBe(r.status);
    expect(t.state.statusSource).toBe(r.source);
    r.check?.(t);
  });

  it('does not mutate the previous state', () => {
    const prev = state({ status: 'analyzing' });
    const snapshot = JSON.stringify(prev);
    applyEvent(prev, SID, ev({ event: 'Stop' }));
    expect(JSON.stringify(prev)).toBe(snapshot);
  });

  it('row 12 dedupe also works when the Notification arrives first', () => {
    const a = applyEvent(state(), SID, ev({ event: 'Notification', notificationType: 'permission_prompt' }, T0 + 100));
    const b = applyEvent(a.state, SID, ev({ event: 'PermissionRequest', toolName: 'Bash' }, T0 + 900));
    expect(notifyKinds(a)).toEqual(['permission_required']);
    expect(notifyKinds(b)).toEqual([]);
    expect(b.state.flags.pendingPermissionTool).toBe('Bash');
  });

  it('row 12: one notification per permission episode even when permission_prompt arrives 6 s later (observed on a real session)', () => {
    const a = applyEvent(state({ status: 'writing_tests' }), SID, ev({ event: 'PermissionRequest', toolName: 'Write' }, T0));
    const b = applyEvent(a.state, SID, ev({ event: 'Notification', notificationType: 'permission_prompt' }, T0 + 6_000));
    const late = applyEvent(b.state, SID, ev({ event: 'Notification', notificationType: 'permission_prompt' }, T0 + 120_000));
    expect(notifyKinds(a)).toEqual(['permission_required']);
    expect(notifyKinds(b)).toEqual([]);
    expect(notifyKinds(late)).toEqual([]);
  });

  it('row 12: a NEW permission episode (after the previous one was resolved) notifies again', () => {
    let s = applyEvent(state(), SID, ev({ event: 'PermissionRequest', toolName: 'Write' }, T0)).state;
    s = applyEvent(s, SID, ev({ event: 'PostToolUse', toolName: 'Write' }, T0 + 1000)).state; // approved
    const next = applyEvent(s, SID, ev({ event: 'PermissionRequest', toolName: 'Bash' }, T0 + 2000));
    expect(notifyKinds(next)).toEqual(['permission_required']);
  });

  it('A12: after an interrupt the next PreToolUse is Activity(tool), not debugging, with no stale flags', () => {
    let s = applyEvent(state(), SID, ev({ event: 'PostToolUseFailure', toolName: 'Bash' })).state; // turnFailed
    s = applyEvent(s, SID, ev({ event: 'PermissionRequest', toolName: 'Bash' })).state;
    s = applyEvent(s, SID, ev({ event: 'PostToolUseFailure', toolName: 'Bash', isInterrupt: true })).state;
    const t = applyEvent(s, SID, ev({ event: 'PreToolUse', toolName: 'Read' }));
    expect(t.state.status).toBe('analyzing');
    expect(t.state.flags).toMatchObject({ turnFailed: false, awaitingPermission: false, awaitingInput: false, pendingPermissionTool: null });
  });

  it('events with an unknown agent_id (e.g. --agent sessions) apply to the main session', () => {
    const t = applyEvent(state(), SID, ev({ event: 'PreToolUse', agentId: 'agent-main', toolName: 'Bash', commandCategory: 'test_run' }));
    expect(t.state.status).toBe('executing_tests');
    expect(t.rule).toBe('5');
  });

  it('subagent tool activity after its permission prompt clears the parent awaiting state', () => {
    const s1 = applyEvent(withDrone(state({ status: 'analyzing' })), SID, ev({ event: 'PermissionRequest', agentId: 'agent-1', toolName: 'Write' })).state;
    const t = applyEvent(s1, SID, ev({ event: 'PostToolUse', agentId: 'agent-1', toolName: 'Write' }));
    expect(t.state.status).toBe('analyzing');
    expect(t.state.flags.awaitingFromAgent).toBeNull();
  });
});

describe('timers', () => {
  it('row 27: completed -> idle (inferred) after 10 minutes without events', () => {
    const s = state({ status: 'completed', lastEventAt: T0 });
    expect(applyTimers(s, T0 + COMPLETED_TO_IDLE_MS - 1)).toBeNull();
    const t = applyTimers(s, T0 + COMPLETED_TO_IDLE_MS)!;
    expect(t.rule).toBe('27');
    expect([t.state.status, t.state.statusSource]).toEqual(['idle', 'inferred']);
  });

  it.each(['idle', 'analyzing', 'awaiting_permission', 'awaiting_input', 'debugging', 'failed', 'executing_tests'] as const)(
    'row 28: silence in %s never changes status (never inferred disconnected)',
    (status) => {
      expect(applyTimers(state({ status, lastEventAt: T0 }), T0 + 24 * 3600_000)).toBeNull();
    },
  );

  it('row 22 (timer): stopped drones are removed after 60 s', () => {
    const s = withDrone(state({ status: 'analyzing' }));
    s.drones['agent-1']!.stoppedAt = T0;
    s.drones['agent-1']!.status = 'completed';
    expect(applyTimers(s, T0 + DRONE_LINGER_MS - 1)).toBeNull();
    const t = applyTimers(s, T0 + DRONE_LINGER_MS)!;
    expect(t.state.drones).toEqual({});
    expect(t.effects).toContainEqual({ type: 'drone_removed', agentId: 'agent-1' });
  });
});
