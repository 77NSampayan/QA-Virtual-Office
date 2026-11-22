import { describe, expect, it } from 'vitest';
import { Notifier, computeAttention, shouldToast, type Attention, type ToastInfo } from '../src/notifier.ts';
import { DEFAULT_PREFS, applyPrefUpdate, sanitizePrefs } from '../src/prefs.ts';

describe('desktop preferences', () => {
  it('defaults: minimize to tray, no sound, toast high + warning, not a login item', () => {
    expect(sanitizePrefs(undefined)).toEqual({ minimizeToTray: true, sound: false, toastPriorities: ['high', 'warning'], startWithWindows: false });
    expect(sanitizePrefs('garbage')).toEqual(DEFAULT_PREFS);
  });
  it('invalid or unknown fields fall back to defaults and are dropped', () => {
    const p = sanitizePrefs({ minimizeToTray: 'yes', sound: 1, toastPriorities: ['high', 'bogus', 'high', 'low'], startWithWindows: true, evil: '<script>' });
    expect(p).toEqual({ minimizeToTray: true, sound: false, toastPriorities: ['high', 'low'], startWithWindows: true });
    expect(JSON.stringify(p)).not.toContain('evil');
  });
  it('single-key updates are validated (IPC input is untrusted)', () => {
    expect(applyPrefUpdate(DEFAULT_PREFS, 'sound', true)?.sound).toBe(true);
    expect(applyPrefUpdate(DEFAULT_PREFS, 'toastPriorities', ['low'])?.toastPriorities).toEqual(['low']);
    expect(applyPrefUpdate(DEFAULT_PREFS, 'toastPriorities', [])?.toastPriorities).toEqual([]);
    for (const [k, v] of [['sound', 'yes'], ['minimizeToTray', 1], ['toastPriorities', ['nope']], ['toastPriorities', 'high'], ['__proto__', {}], ['constructor', 1], ['unknownKey', true], [42, true], [undefined, true]] as const) {
      expect(applyPrefUpdate(DEFAULT_PREFS, k, v), `${String(k)}=${JSON.stringify(v)}`).toBeNull();
    }
  });
});

describe('toast filtering', () => {
  it('toasts only the chosen priorities', () => {
    expect(shouldToast('high', DEFAULT_PREFS)).toBe(true);
    expect(shouldToast('warning', DEFAULT_PREFS)).toBe(true);
    expect(shouldToast('low', DEFAULT_PREFS)).toBe(false);
    expect(shouldToast('info', DEFAULT_PREFS)).toBe(false);
    expect(shouldToast('low', { ...DEFAULT_PREFS, toastPriorities: ['low'] })).toBe(true);
    expect(shouldToast('high', { ...DEFAULT_PREFS, toastPriorities: [] })).toBe(false);
  });
});

describe('attention counting (tray badge)', () => {
  const now = 1_000_000_000_000;
  const s = (status: string, ageMs = 0) => ({ sessionId: Math.random().toString(36).slice(2), status, lastEventAt: now - ageMs });
  it('none when nothing needs the user', () => {
    expect(computeAttention([s('idle'), s('analyzing'), s('completed'), s('disconnected')], now)).toMatchObject({ level: 'none', count: 0 });
  });
  it('permission and input prompts are a warning; failures an alert', () => {
    expect(computeAttention([s('awaiting_permission'), s('awaiting_input')], now)).toEqual({ level: 'warning', count: 2, permission: 1, input: 1, failed: 0 });
    expect(computeAttention([s('awaiting_permission'), s('failed')], now)).toMatchObject({ level: 'alert', count: 2, failed: 1 });
  });
  it('an old failure (over 24 h) no longer counts', () => {
    expect(computeAttention([s('failed', 25 * 3600_000)], now)).toMatchObject({ level: 'none', count: 0 });
    expect(computeAttention([s('failed', 23 * 3600_000)], now)).toMatchObject({ level: 'alert', count: 1 });
  });
});

describe('notifier message handling', () => {
  const make = (prefs = DEFAULT_PREFS) => {
    const toasts: ToastInfo[] = [];
    const attention: Attention[] = [];
    const n = new Notifier({ backend: {} as never, getPrefs: () => prefs, onToast: (t) => toasts.push(t), onAttention: (a) => attention.push(a) });
    return { n, toasts, attention };
  };
  const note = (id: string, priority: string) =>
    JSON.stringify({ type: 'notification.created', notification: { id, kind: 'permission_required', priority, title: 'Permission required', body: 'Unit-01 in Demo is waiting for permission to use Bash.' } });

  it('raises one toast per real notification, never twice for the same id', () => {
    const { n, toasts } = make();
    n.onMessage(note('ntf_1', 'high'));
    n.onMessage(note('ntf_1', 'high')); // WebSocket reconnect replay
    n.onMessage(note('ntf_2', 'high'));
    expect(toasts.map((t) => t.id)).toEqual(['ntf_1', 'ntf_2']);
    expect(toasts[0]).toMatchObject({ title: 'Permission required', priority: 'high' });
  });
  it('respects the priority choice', () => {
    const { n, toasts } = make();
    n.onMessage(note('ntf_3', 'low'));
    expect(toasts).toHaveLength(0);
  });
  it('tracks attention from session updates and ignores malformed messages', () => {
    const { n, attention } = make();
    n.onMessage('not json');
    n.onMessage(JSON.stringify({ type: 'session.updated', session: { sessionId: 'a', status: 'awaiting_permission', lastEventAt: Date.now() } }));
    n.onMessage(JSON.stringify({ type: 'session.updated', session: { sessionId: 'a', status: 'analyzing', lastEventAt: Date.now() } }));
    n.onMessage(JSON.stringify({ type: 'session.updated', session: { status: 'failed' } })); // no id: ignored
    n.onMessage(JSON.stringify({ type: 'notification.created', notification: { id: 5 } })); // bad id: ignored
    expect(attention.map((a) => a.count)).toEqual([1, 0]);
  });
});
