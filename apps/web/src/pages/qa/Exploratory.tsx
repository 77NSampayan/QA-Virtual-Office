import { useCallback, useEffect, useState } from 'react';
import { EXPLORATORY_KIND_LABEL, EXPLORATORY_NOTE_KINDS } from '@qavo/shared';
import { api, type QaExploratory, type QaExploratoryDetail } from '../../api.ts';
import { useLive } from '../../live.tsx';
import { MsgLine, useMsg } from './Requirements.tsx';

const STATUS_LABEL = { planned: 'Planned', in_progress: 'Running', completed: 'Completed' } as const;
const STATUS_COLOR = { planned: '#9aa3b5', in_progress: '#5ad1ff', completed: '#4be37c' } as const;

function SessionDetail({ id, onChanged }: { id: string; onChanged: () => void }) {
  const { qaVersion } = useLive();
  const [s, setS] = useState<QaExploratoryDetail | null>(null);
  const [kind, setKind] = useState('note');
  const [text, setText] = useState('');
  const [summary, setSummary] = useState('');
  const m = useMsg();
  const load = useCallback(() => void api.exploratory(id).then(setS).catch(() => setS(null)), [id]);
  useEffect(load, [load, qaVersion]);
  if (!s) return <p className="muted loading" role="status">Loading…</p>;
  const act = async (fn: () => Promise<unknown>, ok: string) => {
    try {
      await fn();
      m.ok(ok);
      load();
      onChanged();
    } catch (err) {
      m.fail(err);
    }
  };
  return (
    <div className="detail" data-session-detail={s.code}>
      <p>
        <strong>Charter:</strong> {s.charter}
      </p>
      <p className="muted">
        {s.area && `Area: ${s.area} · `}
        {s.tester && `Tester: ${s.tester} · `}
        Timebox {s.timeboxMinutes} min
        {s.startedAt ? ` · started ${new Date(s.startedAt).toLocaleString()}` : ''}
      </p>
      {s.status === 'planned' && (
        <button onClick={() => void act(() => api.startExploratory(id), 'Session started.')} data-start-session>
          Start session
        </button>
      )}
      {s.status === 'in_progress' && (
        <div className="project-form" data-note-form>
          <div className="row">
            <label>
              Kind
              <select value={kind} onChange={(e) => setKind(e.target.value)} data-note-kind>
                {EXPLORATORY_NOTE_KINDS.map((k) => (
                  <option key={k} value={k}>
                    {EXPLORATORY_KIND_LABEL[k]}
                  </option>
                ))}
              </select>
            </label>
            <label className="grow">
              Note
              <input value={text} onChange={(e) => setText(e.target.value)} maxLength={5000} data-note-text />
            </label>
            <button
              disabled={!text.trim()}
              data-add-note
              onClick={() =>
                void act(async () => {
                  await api.addExploratoryNote(id, { kind, text });
                  setText('');
                }, 'Note added.')
              }
            >
              Add
            </button>
          </div>
        </div>
      )}
      <h4>Notes ({s.notes.length})</h4>
      {s.notes.length === 0 && <p className="muted">No notes yet.</p>}
      <ul data-notes>
        {s.notes.map((n) => (
          <li key={n.id} data-note={n.kind}>
            <span className="pill">{EXPLORATORY_KIND_LABEL[n.kind as keyof typeof EXPLORATORY_KIND_LABEL] ?? n.kind}</span> {n.text} <span className="muted">· {n.createdBy}</span>
            {n.kind === 'bug' &&
              (n.defectCode ? (
                <span className="pill soon"> {n.defectCode}</span>
              ) : (
                <button className="ghost small" data-raise-defect onClick={() => void act(() => api.defectFromNote(n.id), 'Defect raised.')}>
                  Raise defect
                </button>
              ))}
          </li>
        ))}
      </ul>
      {s.status === 'in_progress' && (
        <div className="project-form">
          <label>
            Summary (what you covered and found)
            <textarea rows={2} value={summary} onChange={(e) => setSummary(e.target.value)} maxLength={5000} data-session-summary />
          </label>
          <button className="ghost" onClick={() => void act(() => api.completeExploratory(id, summary), 'Session completed.')} data-complete-session>
            Complete session
          </button>
        </div>
      )}
      {s.status === 'completed' && <p>{s.summary ? `Summary: ${s.summary}` : 'Completed with no summary.'}</p>}
      <MsgLine msg={m.msg} />
    </div>
  );
}

export function ExploratoryPanel({ projectId }: { projectId: string }) {
  const { qaVersion } = useLive();
  const [items, setItems] = useState<QaExploratory[]>([]);
  const [open, setOpen] = useState<string | null>(null);
  const [form, setForm] = useState({ charter: '', area: '', tester: '', timeboxMinutes: 60 });
  const m = useMsg();
  const load = useCallback(() => void api.exploratorySessions(projectId).then(setItems).catch(() => setItems([])), [projectId]);
  useEffect(load, [load, qaVersion]);
  useEffect(() => setOpen(null), [projectId]);
  const create = async () => {
    try {
      const s = await api.createExploratory(projectId, form);
      setForm({ charter: '', area: '', tester: '', timeboxMinutes: 60 });
      setOpen(s.id);
      m.ok(`${s.code} planned.`);
      load();
    } catch (err) {
      m.fail(err);
    }
  };
  return (
    <div data-panel="exploratory">
      <section className="card">
        <h3>Plan an exploratory session</h3>
        <p className="hint">A charter is a short mission, e.g. “Explore checkout with unusual quantities”. Start it, jot notes as you go, turn bug notes into defects, then complete it with a summary.</p>
        <div className="row">
          <label className="grow">
            Charter
            <input value={form.charter} onChange={(e) => setForm({ ...form, charter: e.target.value })} maxLength={1000} data-charter />
          </label>
          <label>
            Area
            <input value={form.area} onChange={(e) => setForm({ ...form, area: e.target.value })} maxLength={200} />
          </label>
          <label>
            Tester
            <input value={form.tester} onChange={(e) => setForm({ ...form, tester: e.target.value })} maxLength={100} />
          </label>
          <label>
            Timebox (min)
            <input type="number" min={5} max={480} value={form.timeboxMinutes} onChange={(e) => setForm({ ...form, timeboxMinutes: Number(e.target.value) || 60 })} />
          </label>
          <button disabled={!form.charter.trim()} onClick={() => void create()} data-create-session>
            Plan session
          </button>
        </div>
        <MsgLine msg={m.msg} />
      </section>
      <section className="card">
        <h3>Sessions</h3>
        <ul data-session-list>
          {items.map((s) => (
            <li key={s.id}>
              <button className={open === s.id ? 'tab on' : 'tab'} onClick={() => setOpen(open === s.id ? null : s.id)} data-session-open={s.code}>
                {s.code} · {s.charter.length > 70 ? `${s.charter.slice(0, 67)}…` : s.charter}
              </button>{' '}
              <span className="pill" style={{ color: STATUS_COLOR[s.status] }}>
                {STATUS_LABEL[s.status]}
              </span>{' '}
              <span className="muted">
                {s.noteCount} note(s), {s.bugCount} bug(s)
              </span>
            </li>
          ))}
          {items.length === 0 && <li className="muted">No exploratory sessions yet.</li>}
        </ul>
      </section>
      {open && (
        <section className="card">
          <SessionDetail id={open} onChanged={load} />
        </section>
      )}
    </div>
  );
}
