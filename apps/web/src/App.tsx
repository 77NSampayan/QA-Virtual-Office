/**
 * Pass 1A real-data console: plain functional UI (pixel-art office arrives in Pass 1C).
 * Everything shown here comes from real Claude Code hook events via the local collector.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, ApiError, type AgentEvent, type IntegrationStatus, type Notification, type Project, type Session } from './api.ts';

const STATUS_LABEL: Record<string, string> = {
  idle: 'Idle',
  analyzing: 'Analyzing',
  writing_tests: 'Writing test cases',
  executing_tests: 'Executing tests',
  debugging: 'Debugging',
  awaiting_permission: 'Awaiting permission',
  awaiting_input: 'Awaiting input',
  completed: 'Completed',
  failed: 'Failed',
  disconnected: 'Disconnected',
};

function ago(ms: number, now: number): string {
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  return `${Math.floor(s / 3600)}h ago`;
}

function StatusPill({ status, source }: { status: string; source: string }) {
  return (
    <span className={`pill st-${status}`} title={source === 'inferred' ? 'Inferred from tool activity' : 'Stated by the hook event'}>
      {source === 'inferred' ? '~ ' : ''}
      {STATUS_LABEL[status] ?? status}
    </span>
  );
}

function useNow(intervalMs = 5000) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}

// ------------------------------------------------------------------------------------ projects
function ProjectForm({ initial, onDone, onCancel }: { initial?: Project; onDone: (msg: string) => void; onCancel?: () => void }) {
  const [alias, setAlias] = useState(initial?.alias ?? '');
  const [path, setPath] = useState('');
  const [type, setType] = useState(initial?.type ?? 'general');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (initial) api.projectPath(initial.id).then((p) => setPath(p.pathEntered)).catch(() => setPath(''));
  }, [initial]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = initial ? await api.updateProject(initial.id, { alias, path, type }) : await api.createProject({ alias, path, type });
      const notes = [
        r.warnings.includes('alias_matches_folder_name') ? 'Warning: the alias reveals a folder name — consider a neutral alias.' : '',
        r.relinkedSessions ? `${r.relinkedSessions} earlier session(s) re-linked.` : '',
      ].filter(Boolean);
      onDone(notes.join(' ') || (initial ? 'Project updated.' : 'Project registered.'));
      if (!initial) {
        setAlias('');
        setPath('');
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.code : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="project-form" onSubmit={submit}>
      <label>
        Safe alias (shown everywhere)
        <input value={alias} onChange={(e) => setAlias(e.target.value)} placeholder="e.g. Payments Web" maxLength={60} required />
      </label>
      <label>
        Project folder (stored locally only, never shown in events)
        <input value={path} onChange={(e) => setPath(e.target.value)} placeholder="C:\\path\\to\\repo" required spellCheck={false} />
      </label>
      <label>
        Type
        <select value={type} onChange={(e) => setType(e.target.value)}>
          {['general', 'web', 'api', 'mobile', 'desktop', 'automation', 'manual'].map((t) => (
            <option key={t}>{t}</option>
          ))}
        </select>
      </label>
      <div className="row">
        <button disabled={busy}>{initial ? 'Save' : 'Register project'}</button>
        {onCancel && (
          <button type="button" className="ghost" onClick={onCancel}>
            Cancel
          </button>
        )}
      </div>
      {error && <p className="error">{error}</p>}
    </form>
  );
}

function Projects({ projects, onChanged }: { projects: Project[]; onChanged: () => void }) {
  const [editing, setEditing] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const done = (m: string) => {
    setMsg(m);
    setEditing(null);
    onChanged();
  };
  return (
    <section className="card">
      <h2>Projects</h2>
      <p className="hint">
        Only sessions inside registered folders are reported (scope: registered projects only). Paths stay on this PC; the forwarder sends a
        project id, never the folder.
      </p>
      <ul className="projects">
        {projects.map((p) =>
          editing === p.id ? (
            <li key={p.id}>
              <ProjectForm initial={p} onDone={done} onCancel={() => setEditing(null)} />
            </li>
          ) : (
            <li key={p.id}>
              <strong>{p.alias}</strong> <span className="muted">{p.type}</span>{' '}
              {p.pathStatus === 'missing' && <span className="pill st-failed">folder missing</span>}
              <span className="actions">
                <button className="ghost" onClick={() => setEditing(p.id)}>
                  Edit
                </button>
                <button
                  className="ghost danger"
                  onClick={async () => {
                    if (confirm(`Remove project "${p.alias}"? Its sessions stay in history as unassigned.`)) {
                      await api.deleteProject(p.id);
                      done('Project removed.');
                    }
                  }}
                >
                  Remove
                </button>
              </span>
            </li>
          ),
        )}
        {projects.length === 0 && <li className="muted">No projects registered yet.</li>}
      </ul>
      {!editing && <ProjectForm onDone={done} />}
      {msg && <p className="ok">{msg}</p>}
    </section>
  );
}

// ------------------------------------------------------------------------------------ sessions
function Timeline({ sessionId, version }: { sessionId: string; version: number }) {
  const [events, setEvents] = useState<AgentEvent[]>([]);
  useEffect(() => {
    api.events(sessionId).then(setEvents).catch(() => setEvents([]));
  }, [sessionId, version]);
  return (
    <section className="card">
      <h2>
        Event timeline <span className="muted mono">{sessionId.slice(0, 8)}</span>
      </h2>
      <table>
        <thead>
          <tr>
            <th>Time</th>
            <th>Event</th>
            <th>Detail</th>
            <th>Status after</th>
            <th>Rule</th>
          </tr>
        </thead>
        <tbody>
          {events.map((e) => (
            <tr key={e.id}>
              <td className="mono">{new Date(e.receivedAt).toLocaleTimeString()}</td>
              <td>
                {e.event === 'other' ? (e.rawEventName ?? 'other') : e.event}
                {e.agentId && <span className="muted"> (subagent {e.agentType || e.agentId.slice(0, 8)})</span>}
              </td>
              <td className="muted">
                {[e.toolName, e.fileCategory && `file:${e.fileCategory}`, e.commandCategory && `cmd:${e.commandCategory}`, e.notificationType, e.source, e.reason, e.error]
                  .filter(Boolean)
                  .join(' · ')}
              </td>
              <td>
                <StatusPill status={e.statusAfter} source={e.statusSourceAfter} />
              </td>
              <td className="mono muted">{e.rule}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

function Sessions({ sessions, selected, onSelect, now }: { sessions: Session[]; selected: string | null; onSelect: (id: string) => void; now: number }) {
  return (
    <section className="card">
      <h2>Claude Code sessions</h2>
      <table>
        <thead>
          <tr>
            <th>Robot</th>
            <th>Project</th>
            <th>Status</th>
            <th>Model</th>
            <th>Origin</th>
            <th>Last event</th>
          </tr>
        </thead>
        <tbody>
          {sessions.map((s) => (
            <tr key={s.sessionId} className={selected === s.sessionId ? 'selected' : ''} onClick={() => onSelect(s.sessionId)}>
              <td>
                {s.robot?.name ?? '—'}
                {s.drones.length > 0 && <span className="muted"> +{s.drones.length} drone(s)</span>}
              </td>
              <td>{s.projectAlias ?? (s.folderKeyShort ? `Unregistered folder #${s.folderKeyShort}` : 'Unassigned')}</td>
              <td>
                <StatusPill status={s.status} source={s.statusSource} />
                {s.pendingPermissionTool && s.status === 'awaiting_permission' && <span className="muted"> {s.pendingPermissionTool}</span>}
              </td>
              <td className="mono">{s.model ?? '—'}</td>
              <td>
                {s.origin === 'fork' ? (s.parentSessionId ? `fork of ${s.parentSessionId.slice(0, 8)}` : 'forked, parent unknown') : s.origin}
                {!s.startObserved && <span className="muted"> (start not observed)</span>}
              </td>
              <td>{ago(s.lastEventAt, now)}</td>
            </tr>
          ))}
          {sessions.length === 0 && (
            <tr>
              <td colSpan={6} className="muted">
                No sessions yet. Install hooks (<code>npm run hooks:install</code>), register a project, then start <code>claude</code> in that folder.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </section>
  );
}

// ------------------------------------------------------------------------------------ app
export function App() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [integration, setIntegration] = useState<IntegrationStatus | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [wsState, setWsState] = useState<'connecting' | 'live' | 'offline'>('connecting');
  const [eventVersion, setEventVersion] = useState(0);
  const now = useNow();

  const refresh = useCallback(async () => {
    const [p, s, n, i] = await Promise.all([api.projects(), api.sessions(), api.notifications(), api.integration()]);
    setProjects(p);
    setSessions(s);
    setNotifications(n);
    setIntegration(i);
  }, []);

  useEffect(() => {
    void refresh();
    let ws: WebSocket | null = null;
    let retry: ReturnType<typeof setTimeout> | undefined;
    const connect = () => {
      ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
      ws.onopen = () => {
        setWsState('live');
        void refresh();
      };
      ws.onclose = () => {
        setWsState('offline');
        retry = setTimeout(connect, 2000);
      };
      ws.onmessage = (m) => {
        const msg = JSON.parse(m.data as string);
        if (msg.type === 'session.updated' && msg.session) {
          setSessions((prev) => [msg.session as Session, ...prev.filter((x) => x.sessionId !== msg.session.sessionId)].sort((a, b) => b.lastEventAt - a.lastEventAt));
        } else if (msg.type === 'event.created') {
          setEventVersion((v) => v + 1);
        } else if (msg.type === 'notification.created') {
          setNotifications((prev) => [msg.notification as Notification, ...prev].slice(0, 100));
        } else if (msg.type === 'project.updated' || msg.type === 'project.deleted') {
          void refresh();
        }
      };
    };
    connect();
    return () => {
      clearTimeout(retry);
      if (ws) {
        ws.onclose = null;
        ws.close();
      }
    };
  }, [refresh]);

  const attention = useMemo(() => sessions.filter((s) => s.status === 'awaiting_permission' || s.status === 'awaiting_input'), [sessions]);

  return (
    <div className="app">
      <header>
        <h1>QA Virtual Office</h1>
        <span className="muted">Pass 1A · real-data console</span>
        <span className={`pill ${wsState === 'live' ? 'st-completed' : 'st-failed'}`}>{wsState === 'live' ? 'live' : wsState}</span>
        {integration && (
          <span className="muted">
            hooks: {integration.hooks.state.replace('_', ' ')}
            {integration.hooks.state === 'installed' && !integration.hooks.forwarderUpToDate ? ' (forwarder outdated)' : ''} · scope:{' '}
            {integration.scope === 'registered' ? 'registered projects only' : 'all sessions'} · policy v{integration.policyVersion}
          </span>
        )}
      </header>
      {attention.length > 0 && (
        <div className="attention">
          {attention.map((s) => (
            <div key={s.sessionId}>
              <strong>{s.robot?.name}</strong> in {s.projectAlias ?? 'an unregistered folder'} is{' '}
              {s.status === 'awaiting_permission' ? `waiting for permission${s.pendingPermissionTool ? ` (${s.pendingPermissionTool})` : ''}` : 'waiting for your input'} — respond in
              its Claude Code terminal.
            </div>
          ))}
        </div>
      )}
      <main>
        <div className="col">
          <Sessions sessions={sessions} selected={selected} onSelect={setSelected} now={now} />
          {selected && <Timeline sessionId={selected} version={eventVersion} />}
        </div>
        <div className="col side">
          <Projects projects={projects} onChanged={refresh} />
          <section className="card">
            <h2>Notifications</h2>
            <ul className="notes">
              {notifications.slice(0, 12).map((n) => (
                <li key={n.id} className={`prio-${n.priority}`}>
                  <strong>{n.title}</strong> <span className="muted">{ago(Date.parse(n.createdAt), now)}</span>
                  <div>{n.body}</div>
                </li>
              ))}
              {notifications.length === 0 && <li className="muted">None yet.</li>}
            </ul>
          </section>
        </div>
      </main>
      <footer className="muted">
        Local only · metadata-only capture (no prompts, tool inputs/outputs, file contents or paths) · "~" marks statuses inferred from tool activity
      </footer>
    </div>
  );
}
