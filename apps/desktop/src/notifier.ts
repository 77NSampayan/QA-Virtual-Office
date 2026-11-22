/**
 * Listens to the server's WebSocket (same real events as the UI) and
 *  - raises Windows toasts for the priorities the user chose (text is built server-side from
 *    metadata only: robot, project alias, tool name),
 *  - tracks how many agents need attention for the tray/taskbar badge.
 * Nothing is simulated: every toast and badge comes from a real notification or session update.
 */
import WebSocket from 'ws';
import type { Backend } from './backend.ts';
import type { Prefs } from './prefs.ts';

export interface ToastInfo {
  id: string;
  kind: string;
  priority: string;
  title: string;
  body: string;
}
export type AttentionLevel = 'none' | 'warning' | 'alert';
export interface Attention {
  level: AttentionLevel;
  count: number;
  /** Agents waiting on a permission prompt. */
  permission: number;
  input: number;
  failed: number;
}

const DAY_MS = 24 * 3600_000;

export function shouldToast(priority: string, prefs: Prefs): boolean {
  return (prefs.toastPriorities as string[]).includes(priority);
}

interface SessionLite {
  sessionId: string;
  status: string;
  lastEventAt: number;
}

export function computeAttention(sessions: Iterable<SessionLite>, now = Date.now()): Attention {
  let permission = 0;
  let input = 0;
  let failed = 0;
  for (const s of sessions) {
    if (s.status === 'awaiting_permission') permission++;
    else if (s.status === 'awaiting_input') input++;
    else if (s.status === 'failed' && now - s.lastEventAt <= DAY_MS) failed++;
  }
  const count = permission + input + failed;
  return { level: failed > 0 ? 'alert' : count > 0 ? 'warning' : 'none', count, permission, input, failed };
}

export interface NotifierDeps {
  backend: Backend;
  getPrefs: () => Prefs;
  onToast: (n: ToastInfo) => void;
  onAttention: (a: Attention) => void;
  log?: (line: string) => void;
}

export class Notifier {
  private ws: WebSocket | null = null;
  private sessions = new Map<string, SessionLite>();
  private closed = false;
  private retry: ReturnType<typeof setTimeout> | undefined;
  private attempts = 0;
  private cookie = '';
  /** Notification ids already toasted (WS reconnects must never re-toast). */
  private seen = new Set<string>();

  constructor(private deps: NotifierDeps) {}

  async start(): Promise<void> {
    await this.connect();
  }

  stop(): void {
    this.closed = true;
    clearTimeout(this.retry);
    this.ws?.removeAllListeners();
    this.ws?.close();
  }

  attention(): Attention {
    return computeAttention(this.sessions.values());
  }

  private async connect(): Promise<void> {
    const { backend } = this.deps;
    try {
      this.cookie = await backend.sessionCookie();
      await this.loadSessions();
      const ws = new WebSocket(`ws://127.0.0.1:${backend.port}/ws`, { origin: backend.origin, headers: { cookie: this.cookie } });
      this.ws = ws;
      ws.on('open', () => {
        this.attempts = 0;
        this.deps.log?.('notifier connected');
      });
      ws.on('message', (data) => this.onMessage(String(data)));
      ws.on('close', () => this.reconnect());
      ws.on('error', () => undefined);
    } catch (err) {
      this.deps.log?.(`notifier connect failed: ${(err as Error).message}`);
      this.reconnect();
    }
  }

  private reconnect(): void {
    if (this.closed) return;
    this.attempts++;
    clearTimeout(this.retry);
    this.retry = setTimeout(() => void this.connect(), Math.min(15_000, 1000 * 2 ** Math.min(this.attempts, 4)));
  }

  private async loadSessions(): Promise<void> {
    const r = await fetch(`${this.deps.backend.origin}/api/sessions`, { headers: { cookie: this.cookie }, signal: AbortSignal.timeout(4000) });
    if (!r.ok) throw new Error(`sessions HTTP ${r.status}`);
    const list = (await r.json()) as SessionLite[];
    this.sessions = new Map(list.map((s) => [s.sessionId, { sessionId: s.sessionId, status: s.status, lastEventAt: s.lastEventAt }]));
    this.deps.onAttention(this.attention());
    // anything already unread at connect time is not toasted again
    const n = await fetch(`${this.deps.backend.origin}/api/notifications`, { headers: { cookie: this.cookie }, signal: AbortSignal.timeout(4000) });
    if (n.ok) for (const x of (await n.json()) as Array<{ id: string }>) this.seen.add(x.id);
  }

  onMessage(raw: string): void {
    let msg: { type?: string; [k: string]: unknown };
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (msg.type === 'session.updated' && msg.session && typeof msg.session === 'object') {
      const s = msg.session as SessionLite;
      if (typeof s.sessionId === 'string') {
        this.sessions.set(s.sessionId, { sessionId: s.sessionId, status: s.status, lastEventAt: s.lastEventAt });
        this.deps.onAttention(this.attention());
      }
    } else if (msg.type === 'notification.created' && msg.notification && typeof msg.notification === 'object') {
      const n = msg.notification as ToastInfo;
      if (typeof n.id !== 'string' || this.seen.has(n.id)) return;
      this.seen.add(n.id);
      if (shouldToast(n.priority, this.deps.getPrefs())) this.deps.onToast({ id: n.id, kind: n.kind, priority: n.priority, title: String(n.title), body: String(n.body) });
    }
  }
}
