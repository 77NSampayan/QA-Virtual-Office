/** Pass 1B Settings: integration health, hook/status-line install, privacy, scope, retention, backups. */
import { useCallback, useEffect, useState } from 'react';
import { AgentAccess } from './AgentAccess.tsx';
import { OfficeAppearance } from './OfficeAppearance.tsx';
import { PermissionBridge } from './PermissionBridge.tsx';
import { api, ApiError, type BackupInfo, type Capture, type IntegrationStatus, type PlanSummary, type SettingsState } from './api.ts';

const HOOK_EVENTS = [
  'SessionStart',
  'SessionEnd',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'PermissionRequest',
  'Notification',
  'Stop',
  'StopFailure',
  'SubagentStart',
  'SubagentStop',
];

const CAPTURE_LABELS: Record<keyof Capture, string> = {
  prompts: 'Prompts',
  toolInputs: 'Tool inputs (commands, file arguments)',
  toolOutputs: 'Tool outputs',
  notificationText: 'Notification text',
};

function ago(iso: string | null): string {
  if (!iso) return 'never';
  const s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

function useAction() {
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const run = useCallback(async (fn: () => Promise<string | void>) => {
    try {
      const text = await fn();
      setMsg({ ok: true, text: text ?? 'Done.' });
    } catch (err) {
      setMsg({ ok: false, text: err instanceof ApiError ? err.code : String(err) });
    }
  }, []);
  return { msg, run };
}

function Msg({ msg }: { msg: { ok: boolean; text: string } | null }) {
  return msg ? <p className={msg.ok ? 'ok' : 'error'}>{msg.text}</p> : null;
}

// ------------------------------------------------------------------------------ health + install
function Integration({ status, refresh }: { status: IntegrationStatus; refresh: () => void }) {
  const [plan, setPlan] = useState<PlanSummary | null>(null);
  const [ack, setAck] = useState(false);
  const { msg, run } = useAction();
  const hooksInstalled = status.hooks.state === 'installed';

  const openPlan = async (kind: 'hooks' | 'statusLine', action: 'install' | 'uninstall') => {
    setAck(false);
    await run(async () => {
      setPlan(await api.plan(kind, action));
    });
  };
  const apply = async () => {
    if (!plan) return;
    await run(async () => {
      const r =
        plan.kind === 'hooks'
          ? await api.hooks(plan.action, ack)
          : await api.statusLine(plan.action, ack);
      setPlan(null);
      refresh();
      return r.changed ? `${plan.kind === 'hooks' ? 'Hooks' : 'Status line'} ${plan.action}ed (verified: ${r.verified}).` : 'No changes were needed.';
    });
  };

  return (
    <section className="card">
      <h2>Claude Code integration</h2>
      <p>
        Hooks: <strong>{status.hooks.state.replace('_', ' ')}</strong>
        {hooksInstalled && !status.hooks.forwarderUpToDate && <span className="pill st-debugging"> forwarder outdated — reinstall</span>}
        {' · '}Status line:{' '}
        <strong>
          {status.hooks.statusLine === 'other_configured' ? 'another status line is configured (not ours)' : status.hooks.statusLine.replace('_', ' ')}
        </strong>
        {' · '}Spool: <strong>{status.spool.pendingEvents}</strong> pending
        {status.spool.lastReplay && (
          <span className="muted">
            {' '}
            (last replay {ago(status.spool.lastReplay.at)}: {status.spool.lastReplay.applied} applied)
          </span>
        )}
        {' · '}Last backup: <strong>{ago(status.lastBackupAt)}</strong>
      </p>
      {status.recovery && (
        <p className="error">
          Database recovery happened {ago(status.recovery.at)}: {status.recovery.restoredFrom ? `restored from ${status.recovery.restoredFrom}` : 'started with a fresh database'}. The damaged file was kept
          aside in the data folder.
        </p>
      )}
      <p className="hint">{status.trustHint}</p>
      <table>
        <thead>
          <tr>
            <th>Hook</th>
            <th>Installed</th>
            <th>Last event seen</th>
          </tr>
        </thead>
        <tbody>
          {HOOK_EVENTS.map((e) => (
            <tr key={e} style={{ cursor: 'default' }}>
              <td>{e}</td>
              <td>{hooksInstalled || status.hooks.state === 'partial' ? '✓' : '—'}</td>
              <td className="muted">{ago(status.lastEventByType[e] ?? null)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="row" style={{ marginTop: 10, flexWrap: 'wrap' }}>
        {!hooksInstalled || !status.hooks.forwarderUpToDate ? <button onClick={() => openPlan('hooks', 'install')}>{hooksInstalled ? 'Reinstall hooks' : 'Install hooks…'}</button> : null}
        {status.hooks.state !== 'not_installed' && (
          <button className="ghost" onClick={() => openPlan('hooks', 'uninstall')}>
            Uninstall hooks…
          </button>
        )}
        {status.hooks.statusLine !== 'installed' ? (
          <button className="ghost" onClick={() => openPlan('statusLine', 'install')}>
            Enable status line (usage)…
          </button>
        ) : (
          <button className="ghost" onClick={() => openPlan('statusLine', 'uninstall')}>
            Disable status line…
          </button>
        )}
      </div>
      {plan && (
        <div className="plan">
          <h3>
            Review: {plan.action} {plan.kind === 'hooks' ? 'hooks' : 'status line'}
          </h3>
          {plan.noChange && <p className="muted">Nothing would change.</p>}
          {plan.warning && <pre className="warn">{plan.warning}</pre>}
          {plan.eventsAdded.length > 0 && <p>Adds an async handler for: {plan.eventsAdded.join(', ')}.</p>}
          {plan.eventsRemoved.length > 0 && <p>Removes our handler from: {plan.eventsRemoved.join(', ')}.</p>}
          {plan.wrapsExistingStatusLine && <p>Your existing status line will keep working: its output is preserved and it is restored on uninstall.</p>}
          {plan.restoresOriginalStatusLine && <p>Your original status line will be restored.</p>}
          {plan.handler && <pre>{JSON.stringify(plan.handler, null, 2)}</pre>}
          <p className="muted">{plan.willCreateBackup ? 'A timestamped backup of settings.json is written first. ' : ''}Only our entries are touched; everything else in settings.json is preserved.</p>
          {plan.action === 'install' && (
            <label className="check">
              <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} />
              {plan.kind === 'hooks'
                ? 'I understand these hooks run for Claude Code sessions in every folder on this PC (events from unregistered folders are dropped locally).'
                : 'I understand the status line reports usage numbers (model, context %, cost, rate limits) for sessions in registered projects.'}
            </label>
          )}
          <div className="row">
            <button disabled={plan.noChange || (plan.action === 'install' && !ack)} onClick={apply}>
              {plan.action === 'install' ? 'Install' : 'Uninstall'}
            </button>
            <button className="ghost" onClick={() => setPlan(null)}>
              Cancel
            </button>
          </div>
        </div>
      )}
      <Msg msg={msg} />
    </section>
  );
}

// ------------------------------------------------------------------------------ privacy + scope
function Privacy({ settings, refresh }: { settings: SettingsState; refresh: () => void }) {
  const { msg, run } = useAction();
  const toggle = (k: keyof Capture) =>
    run(async () => {
      const turningOn = !settings.capture[k];
      if (turningOn && !confirm(`Store redacted, truncated ${CAPTURE_LABELS[k].toLowerCase()} locally?\n\nThey are kept ${settings.retention.contentDays} day(s), and registered project paths are masked. Anything typed into a prompt can still contain sensitive text that redaction does not recognise.`)) return 'Cancelled.';
      const r = await api.setPrivacy({ [k]: turningOn, confirm: turningOn });
      refresh();
      if (r.purgeOffered.length && confirm('Also delete the content already stored for this setting?')) {
        const kinds = { prompts: 'prompt', toolInputs: 'toolInput', toolOutputs: 'toolResponse', notificationText: 'notificationText' } as const;
        const p = await api.purge([kinds[k]]);
        return `Turned off; ${p.purged} stored record(s) purged.`;
      }
      return turningOn ? 'Enabled.' : 'Disabled.';
    });
  const setScope = (scope: 'registered' | 'all') =>
    run(async () => {
      if (scope === 'all' && !confirm('"All sessions" reports metadata (never prompts or paths) for every Claude Code session on this PC, grouping unregistered folders by an opaque key. Continue?')) return 'Cancelled.';
      await api.setScope(scope, scope === 'all');
      refresh();
    });
  return (
    <section className="card">
      <h2>Privacy and monitoring scope</h2>
      <p className="hint">By default only metadata is captured: no prompts, tool inputs/outputs, file contents, transcripts or paths. Content capture is opt-in per type.</p>
      <h3>Scope</h3>
      <label className="check">
        <input type="radio" name="scope" checked={settings.scope === 'registered'} onChange={() => setScope('registered')} />
        Registered projects only (default) — events from other folders are dropped before they leave the hook.
      </label>
      <label className="check">
        <input type="radio" name="scope" checked={settings.scope === 'all'} onChange={() => setScope('all')} />
        All sessions — unregistered folders appear as “Unregistered folder #xxxx”.
      </label>
      <h3>Content capture (off by default)</h3>
      {(Object.keys(CAPTURE_LABELS) as Array<keyof Capture>).map((k) => (
        <label className="check" key={k}>
          <input type="checkbox" checked={settings.capture[k]} onChange={() => toggle(k)} />
          {CAPTURE_LABELS[k]}
        </label>
      ))}
      <div className="row" style={{ marginTop: 8 }}>
        <button
          className="ghost danger"
          onClick={() =>
            run(async () => {
              if (!confirm('Delete ALL stored prompt/tool/notification content now? Event metadata is kept.')) return 'Cancelled.';
              const r = await api.purge('all');
              return `${r.purged} record(s) purged.`;
            })
          }
        >
          Purge all stored content
        </button>
      </div>
      <Msg msg={msg} />
    </section>
  );
}

function Excludes({ refresh }: { refresh: () => void }) {
  const [text, setText] = useState('');
  const [loaded, setLoaded] = useState(false);
  const { msg, run } = useAction();
  useEffect(() => {
    api
      .excludes()
      .then((r) => setText(r.paths.join('\n')))
      .finally(() => setLoaded(true));
  }, []);
  return (
    <section className="card">
      <h2>Excluded folders</h2>
      <p className="hint">Events from these folders (and below) are never reported, even inside a registered project. One absolute path per line; stored locally only.</p>
      <textarea rows={4} value={text} disabled={!loaded} onChange={(e) => setText(e.target.value)} spellCheck={false} placeholder="C:\path\to\private-folder" />
      <div className="row">
        <button
          onClick={() =>
            run(async () => {
              const paths = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
              const r = await api.setExcludes(paths);
              refresh();
              return `${r.count} excluded folder(s) saved.`;
            })
          }
        >
          Save
        </button>
      </div>
      <Msg msg={msg} />
    </section>
  );
}

// ------------------------------------------------------------------------------ data
function Data({ settings, refresh }: { settings: SettingsState; refresh: () => void }) {
  const [ev, setEv] = useState(String(settings.retention.eventDays));
  const [ct, setCt] = useState(String(settings.retention.contentDays));
  const [backups, setBackups] = useState<BackupInfo[]>([]);
  const { msg, run } = useAction();
  const load = useCallback(() => void api.backups().then(setBackups).catch(() => setBackups([])), []);
  useEffect(load, [load]);
  return (
    <section className="card">
      <h2>Data: retention, backups, export</h2>
      <h3>Retention</h3>
      <div className="row" style={{ flexWrap: 'wrap', alignItems: 'end' }}>
        <label>
          Keep events (days)
          <input type="number" min={1} max={3650} value={ev} onChange={(e) => setEv(e.target.value)} />
        </label>
        <label>
          Keep captured content (days)
          <input type="number" min={1} max={365} value={ct} onChange={(e) => setCt(e.target.value)} />
        </label>
        <button
          onClick={() =>
            run(async () => {
              await api.setRetention({ eventDays: Number(ev), contentDays: Number(ct) });
              refresh();
              return 'Retention saved.';
            })
          }
        >
          Save
        </button>
        <button
          className="ghost"
          onClick={() =>
            run(async () => {
              const r = await api.runRetention();
              return `Cleanup done: ${r.eventsDeleted} event(s), ${r.sessionsDeleted} session(s) removed; ${r.contentCleared} content record(s) cleared.`;
            })
          }
        >
          Run cleanup now
        </button>
      </div>
      <h3>Backups</h3>
      <p className="hint">Daily automatic backup, newest 7 kept, each verified. Backups are full database copies (they include project folder paths) under the same current-user-only permissions. Restore: stop the server, then <code>npm run db:restore -- &lt;name&gt;</code>.</p>
      <div className="row">
        <button
          onClick={() =>
            run(async () => {
              const b = await api.createBackup();
              load();
              refresh();
              return `Backup ${b.name} created.`;
            })
          }
        >
          Back up now
        </button>
        <button
          className="ghost"
          onClick={() =>
            run(async () => {
              const r = await api.integrity();
              return r.ok ? 'Database integrity: ok.' : `Integrity problem: ${r.detail}`;
            })
          }
        >
          Check database
        </button>
      </div>
      <ul className="notes">
        {backups.map((b) => (
          <li key={b.name}>
            <span className="mono">{b.name}</span> <span className="muted">{(b.bytes / 1024).toFixed(0)} KB · {ago(b.createdAt)}</span>
          </li>
        ))}
        {backups.length === 0 && <li className="muted">No backups yet.</li>}
      </ul>
      <h3>Export</h3>
      <p className="hint">Redacted export with project aliases only (never folder paths) and a manifest describing the capture policy.</p>
      <div className="row">
        <a className="btnlink" href="/api/export?format=json" download>
          Download JSON
        </a>
        <a className="btnlink" href="/api/export?format=csv" download>
          Download events CSV
        </a>
      </div>
      <Msg msg={msg} />
    </section>
  );
}

// ------------------------------------------------------------------------------ desktop app
const PRIORITY_LABEL: Record<string, string> = {
  high: 'High (permission or input needed, failures)',
  warning: 'Warnings',
  low: 'Low (task completed, waiting for you)',
  info: 'Info',
};

/** Shown only inside the Electron desktop shell (it exposes window.qavoDesktop). */
function DesktopCard() {
  const desktop = window.qavoDesktop;
  const [prefs, setPrefs] = useState<DesktopPrefs | null>(null);
  const { msg, run } = useAction();
  useEffect(() => {
    void desktop?.getPrefs().then(setPrefs);
  }, [desktop]);
  if (!desktop || !prefs) return null;
  const set = (key: keyof DesktopPrefs, value: unknown) =>
    run(async () => {
      const next = await desktop.setPref(key, value);
      if (next) setPrefs(next);
      else throw new Error('rejected');
    });
  const togglePriority = (p: DesktopPrefs['toastPriorities'][number]) =>
    set('toastPriorities', prefs.toastPriorities.includes(p) ? prefs.toastPriorities.filter((x) => x !== p) : [...prefs.toastPriorities, p]);
  return (
    <section className="card" data-desktop-card>
      <h2>Desktop app</h2>
      <label className="check">
        <input type="checkbox" checked={prefs.minimizeToTray} onChange={(e) => set('minimizeToTray', e.target.checked)} />
        Minimize and close to the system tray (the app keeps monitoring; use the tray menu to quit)
      </label>
      <label className="check">
        <input type="checkbox" checked={prefs.startWithWindows} onChange={(e) => set('startWithWindows', e.target.checked)} />
        Start with Windows (hidden in the tray)
      </label>
      <label className="check">
        <input type="checkbox" checked={prefs.sound} onChange={(e) => set('sound', e.target.checked)} />
        Play the Windows notification sound with alerts
      </label>
      <h3>Windows notifications for</h3>
      {Object.keys(PRIORITY_LABEL).map((p) => (
        <label className="check" key={p}>
          <input type="checkbox" checked={prefs.toastPriorities.includes(p as DesktopPrefs['toastPriorities'][number])} onChange={() => togglePriority(p as DesktopPrefs['toastPriorities'][number])} />
          {PRIORITY_LABEL[p]}
        </label>
      ))}
      <p className="hint">Alerts never approve or deny anything: respond to permission requests in the Claude Code terminal.</p>
      <div className="row">
        <button className="ghost" onClick={() => run(async () => ((await desktop.testNotification()) ? 'Test notification sent.' : 'Not allowed.'))}>
          Send a test notification
        </button>
      </div>
      <Msg msg={msg} />
    </section>
  );
}

export function Settings({ onSignOut }: { onSignOut: () => void }) {
  const [status, setStatus] = useState<IntegrationStatus | null>(null);
  const [settings, setSettings] = useState<SettingsState | null>(null);
  const refresh = useCallback(() => {
    void api.integration().then(setStatus).catch(() => undefined);
    void api.settings().then(setSettings).catch(() => undefined);
  }, []);
  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 10_000);
    return () => clearInterval(t);
  }, [refresh]);
  if (!status || !settings) return <p className="muted">Loading settings…</p>;
  return (
    <div className="settings">
      <DesktopCard />
      <OfficeAppearance />
      <Integration status={status} refresh={refresh} />
      <PermissionBridge />
      <AgentAccess />
      <Privacy settings={settings} refresh={refresh} />
      <Excludes refresh={refresh} />
      <Data key={`${settings.retention.eventDays}-${settings.retention.contentDays}`} settings={settings} refresh={refresh} />
      <section className="card">
        <h2>Session</h2>
        <button
          className="ghost"
          onClick={async () => {
            await api.logout().catch(() => undefined);
            onSignOut();
          }}
        >
          Sign out of this browser
        </button>
      </section>
    </div>
  );
}
