import { useLive } from '../live.tsx';
import { PermissionPanel } from '../PermissionPanel.tsx';
import { ago, agoIso, isActive, needsAttention, NoData, StatusPill, useNow } from '../ui.tsx';
import { ActivityFeed } from './Rooms.tsx';

/** QA Control Room: what needs attention right now, live sessions, usage and the activity feed. */
export function Control() {
  const { sessions, activity, integration, notifications } = useLive();
  const now = useNow();
  const attention = sessions.filter((s) => needsAttention(s) && now - s.lastEventAt <= 24 * 3600_000).sort((a, b) => b.lastEventAt - a.lastEventAt);
  const live = sessions.filter((s) => isActive(s, now));
  const withUsage = sessions.filter((s) => s.usage && isActive(s, now));

  return (
    <div className="page" data-page="control">
      <h2>QA Control Room</h2>

      <PermissionPanel />
      <section className="card" data-attention>
        <h3>Needs your attention ({attention.length})</h3>
        {attention.length === 0 ? (
          <p className="muted">Nothing is waiting for you.</p>
        ) : (
          <ul className="attention-list">
            {attention.map((s) => (
              <li key={s.sessionId} data-session={s.sessionId} data-status={s.status}>
                <strong>{s.robot?.name ?? 'Agent'}</strong> in {s.projectAlias ?? 'an unregistered folder'}: <StatusPill status={s.status} source={s.statusSource} />
                {s.status === 'awaiting_permission' && s.pendingPermissionTool ? <span> for <code>{s.pendingPermissionTool}</code> — approve or deny it in the Claude Code terminal.</span> : null}
                {s.status === 'awaiting_input' ? <span> — it needs your answer in the Claude Code terminal.</span> : null}
                {s.status === 'failed' ? <span> — it stopped with an error.</span> : null}
                <span className="muted"> {ago(s.lastEventAt, now)}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="card">
        <h3>Live agents ({live.length})</h3>
        <div className="scroll-x">
          <table>
            <thead>
              <tr>
                <th>Robot</th>
                <th>Project</th>
                <th>Status</th>
                <th>Last event</th>
              </tr>
            </thead>
            <tbody>
              {live.map((s) => (
                <tr key={s.sessionId} style={{ cursor: 'default' }}>
                  <td>
                    {s.robot?.name ?? '—'}
                    {s.drones.length > 0 && <span className="muted"> +{s.drones.length} drone(s)</span>}
                  </td>
                  <td>{s.projectAlias ?? 'unregistered folder'}</td>
                  <td>
                    <StatusPill status={s.status} source={s.statusSource} />
                  </td>
                  <td>{ago(s.lastEventAt, now)}</td>
                </tr>
              ))}
              {live.length === 0 && (
                <tr>
                  <td colSpan={4} className="muted">
                    No live agents.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      <div className="two-col">
        <section className="card">
          <h3>Usage (from the Claude Code status line)</h3>
          {integration?.hooks.statusLine !== 'installed' ? (
            <p className="muted">The status line is not enabled, so no usage figures are available. Enable it in Settings. Billing and subscription spend are never available through Claude Code.</p>
          ) : withUsage.length === 0 ? (
            <p className="muted">No usage reported yet by active sessions.</p>
          ) : (
            <div className="scroll-x">
              <table>
                <thead>
                  <tr>
                    <th>Robot</th>
                    <th>Model</th>
                    <th>Context</th>
                    <th>Cost*</th>
                    <th>5h / 7d limit</th>
                  </tr>
                </thead>
                <tbody>
                  {withUsage.map((s) => (
                    <tr key={s.sessionId} style={{ cursor: 'default' }}>
                      <td>{s.robot?.name}</td>
                      <td>{s.usage?.modelName ?? s.model ?? '—'}</td>
                      <td>{s.usage?.contextUsedPct != null ? `${Math.round(s.usage.contextUsedPct)}%` : '—'}</td>
                      <td>{s.usage?.costUsd != null ? `$${s.usage.costUsd.toFixed(2)}` : '—'}</td>
                      <td>
                        {s.usage?.fiveHourPct != null ? `${Math.round(s.usage.fiveHourPct)}%` : '—'} / {s.usage?.sevenDayPct != null ? `${Math.round(s.usage.sevenDayPct)}%` : '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="hint">*As reported by Claude Code (may be an estimate; not billing data).</p>
            </div>
          )}
        </section>

        <section className="card">
          <h3>Integration health</h3>
          {integration ? (
            <ul className="plain">
              <li>
                Hooks: <strong>{integration.hooks.state.replace('_', ' ')}</strong>
              </li>
              <li>
                Last hook event: <strong>{agoIso(integration.lastHookEventAt, now)}</strong>
              </li>
              <li>
                Spool: <strong>{integration.spool.pendingEvents}</strong> event(s) pending
              </li>
              <li>
                Last backup: <strong>{agoIso(integration.lastBackupAt, now)}</strong>
              </li>
              <li>
                Unread notifications: <strong>{notifications.filter((n) => n.readAt === null).length}</strong>
              </li>
            </ul>
          ) : (
            <p className="muted loading" role="status">Loading…</p>
          )}
        </section>
      </div>

      <div className="two-col">
        <NoData title="Test execution status" pass="Pass 2/3" />
        <NoData title="Test coverage" pass="Pass 4" text="coverage is only shown when a valid denominator exists" />
        <NoData title="Defect statistics" pass="Pass 2" />
        <NoData title="Automation health" pass="Pass 3" />
      </div>

      <section className="card">
        <h3>Activity feed</h3>
        <ActivityFeed items={activity} now={now} empty="No activity yet." />
      </section>
    </div>
  );
}
