import { useEffect, useState } from 'react';
import { api, type ActivityItem, type ProjectRoom } from '../api.ts';
import { Floor } from '../Floor.tsx';
import { useLive } from '../live.tsx';
import { navigate } from '../router.ts';
import { ProjectForm } from '../ProjectForm.tsx';
import { agoIso, NoData, StatusPill, useNow } from '../ui.tsx';

export function ActivityFeed({ items, now, empty }: { items: ActivityItem[]; now: number; empty: string }) {
  if (items.length === 0) return <p className="muted">{empty}</p>;
  return (
    <ul className="feed" data-feed>
      {items.map((e) => (
        <li key={e.id}>
          <span className="mono muted">{agoIso(e.receivedAt, now)}</span> <strong>{e.robotName ?? 'agent'}</strong>
          {e.projectAlias ? <span className="muted"> · {e.projectAlias}</span> : null} — {e.event}
          {e.agentType ? <span className="muted"> (subagent {e.agentType})</span> : null}
          {e.toolName ? <span className="muted"> · {e.toolName}</span> : null}
          {e.fileCategory ? <span className="muted"> · file:{e.fileCategory}</span> : null}
          {e.commandCategory ? <span className="muted"> · cmd:{e.commandCategory}</span> : null}{' '}
          <StatusPill status={e.statusAfter} source={e.statusSourceAfter} />
        </li>
      ))}
    </ul>
  );
}

/** Project Rooms: one card per registered project. */
export function RoomsList() {
  const { projects, sessions, refresh } = useLive();
  const now = useNow();
  const [msg, setMsg] = useState<string | null>(null);
  return (
    <div className="page" data-page="rooms">
      <h2>Project QA Rooms</h2>
      <div className="room-grid">
        {projects.map((p) => {
          const mine = sessions.filter((s) => s.projectId === p.id);
          const active = mine.filter((s) => s.status !== 'disconnected').length;
          const last = mine.reduce((m, s) => Math.max(m, s.lastEventAt), 0);
          return (
            <button key={p.id} className="room-card" data-project={p.id} onClick={() => navigate(`/projects/${p.id}`)}>
              <strong>{p.alias}</strong>
              <span className="muted">{p.type}</span>
              {p.pathStatus === 'missing' && <span className="pill" style={{ color: '#ff5d6c' }}>folder missing</span>}
              <span>
                {active} active · {mine.length} session(s)
              </span>
              <span className="muted">{last ? `last activity ${agoIso(new Date(last).toISOString(), now)}` : 'no activity yet'}</span>
            </button>
          );
        })}
        {projects.length === 0 && <p className="muted">No projects yet. Register one below: only registered folders are monitored.</p>}
      </div>
      <section className="card">
        <h3>Register a project</h3>
        <p className="hint">Only sessions inside registered folders are reported. The folder path stays on this PC; events carry just a project id.</p>
        <ProjectForm
          onDone={(m) => {
            setMsg(m);
            void refresh();
          }}
        />
        {msg && <p className="ok">{msg}</p>}
      </section>
    </div>
  );
}

/** A single project's room: its robots at their stations, summary, and recent activity. */
export function ProjectRoomView({ id }: { id: string }) {
  const { projects, robots, sessions, refresh, eventVersion } = useLive();
  const now = useNow();
  const project = projects.find((p) => p.id === id);
  const [room, setRoom] = useState<ProjectRoom | null>(null);
  const [feed, setFeed] = useState<ActivityItem[]>([]);
  const [editing, setEditing] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    void api.room(id).then(setRoom).catch(() => setRoom(null));
    void api.activity(25, id).then(setFeed).catch(() => setFeed([]));
  }, [id, eventVersion, sessions.length]);

  if (!project) {
    return (
      <div className="page">
        <p>
          This project no longer exists. <a href="#/projects">Back to Project Rooms</a>
        </p>
      </div>
    );
  }
  return (
    <div className="page" data-page="room" data-project={id}>
      <p>
        <a href="#/projects">← Project Rooms</a>
      </p>
      <h2>
        {project.alias} <span className="muted">{project.type}</span>
      </h2>
      <div className="kpis">
        <div className="kpi">
          <span className="kpi-label">Robots</span>
          <span className="kpi-value">{room?.robotCount ?? '—'}</span>
          <span className="kpi-note">Distinct robots that have worked in this project.</span>
        </div>
        <div className="kpi">
          <span className="kpi-label">Active sessions</span>
          <span className="kpi-value">{room?.activeSessions ?? '—'}</span>
          <span className="kpi-note">Sessions not yet ended.</span>
        </div>
        <div className="kpi">
          <span className="kpi-label">Total sessions</span>
          <span className="kpi-value">{room?.sessionCount ?? '—'}</span>
          <span className="kpi-note">Within the retention window.</span>
        </div>
        <div className="kpi">
          <span className="kpi-label">Last activity</span>
          <span className="kpi-value small">{room ? agoIso(room.lastActivityAt, now) : '—'}</span>
          <span className="kpi-note">From the latest real event.</span>
        </div>
      </div>

      <Floor robots={robots} sessions={sessions} now={now} projectId={id} />

      <div className="two-col">
        <NoData title="Manual testing progress" pass="Pass 2" />
        <NoData title="Automation progress" pass="Pass 3" />
        <NoData title="Test execution results" pass="Pass 2/3" />
        <NoData title="Open defects" pass="Pass 2" />
      </div>

      <section className="card">
        <h3>Recent activity</h3>
        <ActivityFeed items={feed} now={now} empty="No activity in this room yet." />
      </section>

      <section className="card">
        <h3>Project settings</h3>
        <p className="muted">
          Folder: {project.pathStatus === 'ok' ? 'found' : project.pathStatus === 'missing' ? 'not found on disk (matching by path text only)' : 'not set'} · the path itself is shown only in the edit form.
        </p>
        {editing ? (
          <ProjectForm
            initial={project}
            onDone={(m) => {
              setMsg(m);
              setEditing(false);
              void refresh();
            }}
            onCancel={() => setEditing(false)}
          />
        ) : (
          <div className="row">
            <button className="ghost" onClick={() => setEditing(true)}>
              Edit project
            </button>
            <button
              className="ghost danger"
              onClick={async () => {
                if (confirm(`Remove project "${project.alias}"? Its sessions stay in history as unassigned.`)) {
                  await api.deleteProject(id);
                  await refresh();
                  navigate('/projects');
                }
              }}
            >
              Remove project
            </button>
          </div>
        )}
        {msg && <p className="ok">{msg}</p>}
      </section>
    </div>
  );
}
