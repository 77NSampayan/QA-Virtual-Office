import { useEffect, useState } from 'react';
import { api, type AgentEvent } from '../api.ts';
import { useLive } from '../live.tsx';
import { ago, StatusPill, useNow } from '../ui.tsx';

function Timeline({ sessionId, version }: { sessionId: string; version: number }) {
  const [events, setEvents] = useState<AgentEvent[]>([]);
  useEffect(() => {
    api.events(sessionId).then(setEvents).catch(() => setEvents([]));
  }, [sessionId, version]);
  return (
    <section className="card" data-timeline>
      <h3>
        Event timeline <span className="muted mono">{sessionId.slice(0, 8)}</span>
      </h3>
      <div className="scroll-x">
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
              <tr key={e.id} style={{ cursor: 'default' }}>
                <td className="mono">{new Date(e.receivedAt).toLocaleTimeString()}</td>
                <td>
                  {e.event === 'other' ? (e.rawEventName ?? 'other') : e.event}
                  {e.agentId && <span className="muted"> (subagent {e.agentType || e.agentId.slice(0, 8)})</span>}
                </td>
                <td className="muted">
                  {[e.toolName, e.fileCategory && `file:${e.fileCategory}`, e.commandCategory && `cmd:${e.commandCategory}`, e.notificationType, e.source, e.reason, e.error].filter(Boolean).join(' · ')}
                </td>
                <td>
                  <StatusPill status={e.statusAfter} source={e.statusSourceAfter} />
                </td>
                <td className="mono muted">{e.rule}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

/** Raw session list + per-session event timeline (diagnostic detail view). */
export function Sessions() {
  const { sessions, eventVersion } = useLive();
  const now = useNow();
  const [selected, setSelected] = useState<string | null>(null);
  return (
    <div className="page" data-page="sessions">
      <h2>Claude Code sessions</h2>
      <section className="card">
        <div className="scroll-x">
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
                <tr key={s.sessionId} className={selected === s.sessionId ? 'selected' : ''} onClick={() => setSelected(s.sessionId)}>
                  <td>
                    {s.robot?.name ?? '—'}
                    {s.drones.length > 0 && <span className="muted"> +{s.drones.length} drone(s)</span>}
                  </td>
                  <td>{s.projectAlias ?? (s.folderKeyShort ? `Unregistered folder #${s.folderKeyShort}` : 'Unassigned')}</td>
                  <td>
                    <StatusPill status={s.status} source={s.statusSource} />
                    {s.pendingPermissionTool && s.status === 'awaiting_permission' && <span className="muted"> {s.pendingPermissionTool}</span>}
                  </td>
                  <td className="mono">
                    {s.usage?.modelName ?? s.model ?? '—'}
                    {s.usage?.contextUsedPct != null && <span className="muted"> · ctx {Math.round(s.usage.contextUsedPct)}%</span>}
                    {s.usage?.costUsd != null && (
                      <span className="muted" title="Cost as reported by Claude Code's status line (not billing data)">
                        {' '}
                        · ${s.usage.costUsd.toFixed(2)}
                      </span>
                    )}
                  </td>
                  <td>
                    {s.origin === 'fork' ? (s.parentSessionId ? `fork of ${s.parentSessionId.slice(0, 8)}` : 'forked, parent unknown') : s.origin}
                    {!s.startObserved && <span className="muted"> (start not observed)</span>}
                  </td>
                  <td>{ago(s.lastEventAt, now)}</td>
                </tr>
              ))}
              {sessions.length === 0 && (
                <tr style={{ cursor: 'default' }}>
                  <td colSpan={6} className="muted">
                    No sessions yet. Install hooks in Settings, register a project, then start <code>claude</code> in that folder.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
      {selected && <Timeline sessionId={selected} version={eventVersion} />}
    </div>
  );
}
