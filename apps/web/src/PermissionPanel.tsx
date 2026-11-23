import { useCallback, useEffect, useState } from 'react';
import { api, ApiDetailError, type PermissionRequestItem } from './api.ts';
import { useLive } from './live.tsx';
import { useNow } from './ui.tsx';

const errText = (err: unknown) => (err instanceof ApiDetailError ? err.detail || err.code : String(err));

/**
 * Claude Code permission requests waiting for you, answered from here (V4b). Nothing is ever approved by itself:
 * a request that nobody answers expires and Claude Code asks in the terminal. ALLOW is only offered when the details
 * are shown (tool-input capture on); DENY is always possible.
 */
export function PermissionPanel({ sessionId, compact = false }: { sessionId?: string; compact?: boolean }) {
  const { permissionVersion } = useLive();
  const now = useNow();
  const [items, setItems] = useState<PermissionRequestItem[]>([]);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const load = useCallback(() => void api.permissionsPending().then(setItems).catch(() => setItems([])), []);
  useEffect(load, [load, permissionVersion]);
  useEffect(() => {
    if (items.length === 0) return;
    const t = setInterval(load, 5000); // keeps countdowns honest and drops expired requests even if a message is missed
    return () => clearInterval(t);
  }, [items.length, load]);

  const shown = items.filter((i) => (!sessionId || i.sessionId === sessionId) && i.expiresAt > now - 1000);
  if (shown.length === 0) return msg && !compact ? <p className={msg.ok ? 'ok' : 'error'}>{msg.text}</p> : null;

  const answer = async (it: PermissionRequestItem, decision: 'allow' | 'deny') => {
    setBusy(it.id);
    try {
      await api.decidePermission(it.id, decision);
      setMsg({ ok: true, text: decision === 'allow' ? 'Allowed once. Claude Code continues.' : 'Denied. Claude Code was told.' });
      setItems((prev) => prev.filter((x) => x.id !== it.id));
    } catch (err) {
      setMsg({ ok: false, text: errText(err) });
      load();
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className={`perm-panel ${compact ? 'compact' : 'card'}`} data-permission-panel role="region" aria-label="Permission requests waiting for you">
      {!compact && <h3>Waiting for your answer ({shown.length})</h3>}
      {shown.map((it) => {
        const left = Math.max(0, Math.ceil((it.expiresAt - now) / 1000));
        return (
          <div className="perm-card" key={it.id} data-permission={it.id} data-can-allow={it.canAllow ? 'true' : 'false'}>
            <p>
              <strong>{it.robotName ?? 'A robot'}</strong> <span className="muted">in {it.projectAlias ?? 'a project'}</span> wants to use <code>{it.toolName}</code>
            </p>
            {it.summary !== null ? (
              <pre className="perm-summary" data-perm-summary>
                {it.summary}
              </pre>
            ) : (
              <p className="muted" data-perm-hidden>
                Details are hidden by your privacy settings, so this cannot be approved here. Deny it, or answer in the terminal.
              </p>
            )}
            <div className="row">
              <button data-perm-allow disabled={!it.canAllow || busy === it.id} title={it.canAllow ? 'Allow this one request' : 'Turn on tool-input capture in Settings to see what you approve'} onClick={() => void answer(it, 'allow')}>
                Allow once
              </button>
              <button className="ghost danger" data-perm-deny disabled={busy === it.id} onClick={() => void answer(it, 'deny')}>
                Deny
              </button>
              <span className="muted" data-perm-timer>
                {left}s left · or answer in the terminal
              </span>
            </div>
          </div>
        );
      })}
      {msg && <p className={msg.ok ? 'ok' : 'error'}>{msg.text}</p>}
    </section>
  );
}
