import { Fragment, useCallback, useEffect, useState } from 'react';
import { FLAG_TYPES, REQUIREMENT_KINDS, REQUIREMENT_KIND_LABEL, REVIEW_STATUSES, TEST_CASE_STATUS_LABEL, type TestCaseStatus } from '@qavo/shared';
import { api, ApiDetailError, type QaImportResult, type QaRequirement, type QaRequirementDetail } from '../../api.ts';
import { useLive } from '../../live.tsx';

const REVIEW_LABEL: Record<string, string> = { unreviewed: 'Unreviewed', reviewed: 'Reviewed', needs_clarification: 'Needs clarification' };

export const errText = (err: unknown): string =>
  err instanceof ApiDetailError ? (err.detail ? `${err.code}: ${err.detail}` : err.code) : String(err);

export function useMsg() {
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  return { msg, ok: (text: string) => setMsg({ ok: true, text }), fail: (e: unknown) => setMsg({ ok: false, text: errText(e) }), clear: () => setMsg(null) };
}
export const MsgLine = ({ msg }: { msg: { ok: boolean; text: string } | null }) => (msg ? <p className={msg.ok ? 'ok' : 'error'}>{msg.text}</p> : null);

function AddRequirement({ projectId, onDone }: { projectId: string; onDone: () => void }) {
  const [f, setF] = useState({ ref: '', title: '', text: '', source: '', kind: 'other' });
  const m = useMsg();
  const set = (k: keyof typeof f, v: string) => setF((p) => ({ ...p, [k]: v }));
  return (
    <form
      className="project-form"
      onSubmit={async (e) => {
        e.preventDefault();
        try {
          await api.createRequirement(projectId, f);
          setF({ ref: '', title: '', text: '', source: '', kind: 'other' });
          m.ok('Requirement added.');
          onDone();
        } catch (err) {
          m.fail(err);
        }
      }}
    >
      <div className="row">
        <label>
          Reference
          <input value={f.ref} onChange={(e) => set('ref', e.target.value)} placeholder="REQ-12" required maxLength={40} />
        </label>
        <label style={{ flex: 1, minWidth: 220 }}>
          Title
          <input value={f.title} onChange={(e) => set('title', e.target.value)} required maxLength={200} />
        </label>
        <label>
          Kind
          <select value={f.kind} onChange={(e) => set('kind', e.target.value)}>
            {REQUIREMENT_KINDS.map((k) => (
              <option key={k} value={k}>
                {REQUIREMENT_KIND_LABEL[k]}
              </option>
            ))}
          </select>
        </label>
      </div>
      <label>
        Requirement text
        <textarea rows={3} value={f.text} onChange={(e) => set('text', e.target.value)} maxLength={10000} />
      </label>
      <label>
        Source document (name only, e.g. “BRD v2”)
        <input value={f.source} onChange={(e) => set('source', e.target.value)} maxLength={200} />
      </label>
      <div className="row">
        <button>Add requirement</button>
      </div>
      <MsgLine msg={m.msg} />
    </form>
  );
}

function ImportRequirements({ projectId, onDone }: { projectId: string; onDone: () => void }) {
  const [text, setText] = useState('');
  const [source, setSource] = useState('');
  const [kind, setKind] = useState('auto');
  const [skip, setSkip] = useState<string[]>([]);
  const [preview, setPreview] = useState<QaImportResult | null>(null);
  const m = useMsg();
  const run = async (dryRun: boolean, skipped = skip) => {
    try {
      const only = preview ? Object.keys(preview.byPrefix).filter((p) => !skipped.includes(p)) : undefined;
      const r = await api.importRequirements(projectId, { text, source, kind, dryRun, ...(only && skipped.length ? { onlyPrefixes: only } : {}) });
      if (dryRun) setPreview(r);
      else {
        setPreview(null);
        setSkip([]);
        setText('');
        m.ok(`${r.created.length} requirement(s) imported${r.skippedExisting.length ? `; ${r.skippedExisting.length} already existed and were left unchanged` : ''}.`);
        onDone();
      }
    } catch (err) {
      setPreview(null);
      m.fail(err);
    }
  };
  return (
    <div className="project-form" data-import>
      <p className="hint">
        Paste text from a BRD, FSD or user stories. Each requirement must start with a reference, e.g. <code>REQ-1: …</code>, <code>US-12 - …</code>, <code>BRD 3.2) …</code> or <code>4.1 …</code>. Nothing is interpreted by AI; existing
        references are never overwritten.
      </p>
      <textarea rows={6} value={text} onChange={(e) => (setText(e.target.value), setPreview(null), setSkip([]))} placeholder={'REQ-1: The system shall …\nREQ-2: …'} maxLength={300000} />
      <div className="row">
        <label>
          Source document
          <input value={source} onChange={(e) => setSource(e.target.value)} placeholder="BRD v2" maxLength={200} />
        </label>
        <label>
          Kind
          <select value={kind} onChange={(e) => setKind(e.target.value)}>
            <option value="auto">Detect from the reference (BR, FR, AC …)</option>
            {REQUIREMENT_KINDS.map((k) => (
              <option key={k} value={k}>
                {REQUIREMENT_KIND_LABEL[k]}
              </option>
            ))}
          </select>
        </label>
        <button className="ghost" disabled={!text.trim()} onClick={() => void run(true)}>
          Preview
        </button>
        <button disabled={!preview || preview.wouldCreate.length === 0} onClick={() => void run(false)}>
          Import {preview ? preview.wouldCreate.length : ''} requirement(s)
        </button>
      </div>
      {preview && (
        <div className="plan" data-import-preview>
          <p data-import-prefixes>
            Found by reference type:{' '}
            {Object.entries(preview.byPrefix).map(([p, n]) => (
              <label key={p} className="check-label" style={{ marginRight: 12 }}>
                <input
                  type="checkbox"
                  checked={!skip.includes(p)}
                  onChange={(e) => {
                    const next = e.target.checked ? skip.filter((x) => x !== p) : [...skip, p];
                    setSkip(next);
                    void run(true, next);
                  }}
                />
                {p || 'numbered'} ({n})
              </label>
            ))}
          </p>
          <p>
            <strong>{preview.wouldCreate.length}</strong> new: {preview.wouldCreate.join(', ') || '—'}
          </p>
          {preview.skippedExisting.length > 0 && <p className="muted">Already exist (unchanged): {preview.skippedExisting.join(', ')}</p>}
          {preview.duplicates.length > 0 && <p className="muted">Repeated in the text (first one used): {preview.duplicates.join(', ')}</p>}
          {preview.unparsed.length > 0 && <p className="muted">Ignored lines before the first requirement: {preview.unparsed.length}</p>}
        </div>
      )}
      <MsgLine msg={m.msg} />
    </div>
  );
}

function RequirementDetail({ id, all, onChanged }: { id: string; all: QaRequirement[]; onChanged: () => void }) {
  const { qaVersion } = useLive();
  const [d, setD] = useState<QaRequirementDetail | null>(null);
  const [edit, setEdit] = useState(false);
  const [draft, setDraft] = useState({ ref: '', title: '', text: '', source: '', kind: 'other' });
  const [flag, setFlag] = useState({ type: 'ambiguity', note: '', related: '' });
  const [resolveNote, setResolveNote] = useState<Record<string, string>>({});
  const m = useMsg();
  const load = useCallback(() => void api.requirement(id).then(setD).catch(() => setD(null)), [id]);
  useEffect(load, [load, qaVersion]);
  if (!d) return <p className="muted">Loading…</p>;
  const act = async (fn: () => Promise<unknown>, done: string) => {
    try {
      await fn();
      m.ok(done);
      load();
      onChanged();
    } catch (err) {
      m.fail(err);
    }
  };
  return (
    <div className="detail" data-req-detail={d.ref}>
      {edit ? (
        <form
          className="project-form"
          onSubmit={(e) => {
            e.preventDefault();
            void act(async () => {
              await api.updateRequirement(id, draft);
              setEdit(false);
            }, 'Saved.');
          }}
        >
          <div className="row">
            <input value={draft.ref} onChange={(e) => setDraft({ ...draft, ref: e.target.value })} required />
            <input style={{ flex: 1, minWidth: 200 }} value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} required />
            <select value={draft.kind} onChange={(e) => setDraft({ ...draft, kind: e.target.value })}>
              {REQUIREMENT_KINDS.map((k) => (
                <option key={k} value={k}>
                  {REQUIREMENT_KIND_LABEL[k]}
                </option>
              ))}
            </select>
          </div>
          <textarea rows={4} value={draft.text} onChange={(e) => setDraft({ ...draft, text: e.target.value })} />
          <input value={draft.source} onChange={(e) => setDraft({ ...draft, source: e.target.value })} placeholder="Source document" />
          <div className="row">
            <button>Save</button>
            <button type="button" className="ghost" onClick={() => setEdit(false)}>
              Cancel
            </button>
          </div>
        </form>
      ) : (
        <>
          <p style={{ whiteSpace: 'pre-wrap' }}>{d.text || <span className="muted">No text.</span>}</p>
          <p className="muted">
            {REQUIREMENT_KIND_LABEL[d.kind as keyof typeof REQUIREMENT_KIND_LABEL] ?? d.kind}
            {d.source ? ` · ${d.source}` : ''} · {d.authoredBy === 'agent' ? 'proposed by an agent' : 'entered by you'}
          </p>
          <div className="row">
            <label>
              Review status
              <select value={d.reviewStatus} onChange={(e) => void act(() => api.updateRequirement(id, { reviewStatus: e.target.value }), 'Review status updated.')}>
                {REVIEW_STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {REVIEW_LABEL[s]}
                  </option>
                ))}
              </select>
            </label>
            <button
              className="ghost"
              onClick={() => {
                setDraft({ ref: d.ref, title: d.title, text: d.text, source: d.source, kind: d.kind });
                setEdit(true);
              }}
            >
              Edit
            </button>
            <button
              className="ghost danger"
              onClick={() => {
                if (confirm(`Delete requirement ${d.ref}? Its flags are deleted and its test case links removed (the test cases stay).`)) void act(() => api.deleteRequirement(id), 'Deleted.');
              }}
            >
              Delete
            </button>
          </div>
        </>
      )}

      <h3>Flags for human review</h3>
      <p className="hint">Ambiguities, gaps and conflicts are raised for you to decide. A requirement is never assumed to be correct.</p>
      {d.flags.length === 0 && <p className="muted">No flags.</p>}
      <ul className="notes">
        {d.flags.map((f) => (
          <li key={f.id} data-flag={f.status} className={f.status === 'open' ? 'prio-warning' : 'read'}>
            <div>
              <span className="pill prio">{f.type}</span> <span className="pill prio">{f.status}</span> <span className="muted">raised by {f.raisedBy}</span>
            </div>
            <div>{f.note}</div>
            {f.relatedRequirementId && <div className="muted">Related: {all.find((r) => r.id === f.relatedRequirementId)?.ref ?? f.relatedRequirementId}</div>}
            {f.resolvedNote && <div className="muted">Resolution: {f.resolvedNote}</div>}
            {f.status === 'open' && (
              <div className="row">
                <input placeholder="Note (optional)" value={resolveNote[f.id] ?? ''} onChange={(e) => setResolveNote({ ...resolveNote, [f.id]: e.target.value })} />
                <button className="ghost" onClick={() => void act(() => api.resolveFlag(f.id, { status: 'resolved', note: resolveNote[f.id] }), 'Flag resolved.')}>
                  Resolve
                </button>
                <button className="ghost" onClick={() => void act(() => api.resolveFlag(f.id, { status: 'dismissed', note: resolveNote[f.id] }), 'Flag dismissed.')}>
                  Dismiss
                </button>
              </div>
            )}
          </li>
        ))}
      </ul>
      <form
        className="row"
        onSubmit={(e) => {
          e.preventDefault();
          void act(async () => {
            await api.raiseFlag(id, { type: flag.type, note: flag.note, ...(flag.related ? { relatedRequirementId: flag.related } : {}) });
            setFlag({ type: 'ambiguity', note: '', related: '' });
          }, 'Flag raised.');
        }}
      >
        <select value={flag.type} onChange={(e) => setFlag({ ...flag, type: e.target.value })}>
          {FLAG_TYPES.map((t) => (
            <option key={t}>{t}</option>
          ))}
        </select>
        <input style={{ flex: 1, minWidth: 180 }} placeholder="What is unclear, missing or contradictory?" value={flag.note} onChange={(e) => setFlag({ ...flag, note: e.target.value })} required />
        {flag.type === 'conflict' && (
          <select value={flag.related} onChange={(e) => setFlag({ ...flag, related: e.target.value })}>
            <option value="">Conflicts with…</option>
            {all.filter((r) => r.id !== id).map((r) => (
              <option key={r.id} value={r.id}>
                {r.ref}
              </option>
            ))}
          </select>
        )}
        <button className="ghost">Raise flag</button>
      </form>

      <h3>Test cases covering this requirement</h3>
      {d.testCases.length === 0 ? (
        <p className="muted" data-uncovered>
          None yet: this requirement has no test case.
        </p>
      ) : (
        <ul className="plain">
          {d.testCases.map((t) => (
            <li key={t.id}>
              <strong>{t.code}</strong> {t.title} <span className="pill prio">{TEST_CASE_STATUS_LABEL[t.status as TestCaseStatus] ?? t.status}</span>
            </li>
          ))}
        </ul>
      )}
      <MsgLine msg={m.msg} />
    </div>
  );
}

export function RequirementsPanel({ projectId }: { projectId: string }) {
  const { qaVersion } = useLive();
  const [items, setItems] = useState<QaRequirement[]>([]);
  const [open, setOpen] = useState<string | null>(null);
  const [mode, setMode] = useState<'none' | 'add' | 'import'>('none');
  const m = useMsg();
  const load = useCallback(() => void api.requirements(projectId).then(setItems).catch(() => setItems([])), [projectId]);
  useEffect(load, [load, qaVersion]);
  useEffect(() => setOpen(null), [projectId]);
  const openFlags = items.reduce((n, r) => n + r.openFlags, 0);

  return (
    <div data-panel="requirements">
      <div className="row toolbar">
        <button className={mode === 'add' ? 'tab on' : 'tab'} onClick={() => setMode(mode === 'add' ? 'none' : 'add')}>
          Add requirement
        </button>
        <button className={mode === 'import' ? 'tab on' : 'tab'} onClick={() => setMode(mode === 'import' ? 'none' : 'import')}>
          Import from text
        </button>
        <button
          className="ghost"
          disabled={items.length === 0}
          title="Looks for vague wording, placeholders and untestable performance claims, and raises flags for you to review"
          onClick={async () => {
            try {
              const r = await api.runChecks(projectId);
              m.ok(`Checked ${r.requirementsChecked} requirement(s); ${r.raised} new flag(s) raised for your review.`);
              load();
            } catch (e) {
              m.fail(e);
            }
          }}
        >
          Run ambiguity checks
        </button>
        <span className="muted">
          {items.length} requirement(s) · {openFlags} open flag(s)
        </span>
      </div>
      {mode === 'add' && (
        <section className="card">
          <AddRequirement projectId={projectId} onDone={load} />
        </section>
      )}
      {mode === 'import' && (
        <section className="card">
          <ImportRequirements projectId={projectId} onDone={load} />
        </section>
      )}
      <MsgLine msg={m.msg} />
      <section className="card">
        <div className="scroll-x">
          <table>
            <thead>
              <tr>
                <th>Ref</th>
                <th>Title</th>
                <th>Kind</th>
                <th>Review</th>
                <th>Flags</th>
                <th>Test cases</th>
              </tr>
            </thead>
            <tbody>
              {items.map((r) => (
                <Fragment key={r.id}>
                  <tr className={open === r.id ? 'selected' : ''} data-req={r.ref} onClick={() => setOpen(open === r.id ? null : r.id)}>
                    <td className="mono">{r.ref}</td>
                    <td>
                      {r.title}
                      {r.authoredBy === 'agent' && <span className="pill soon"> agent</span>}
                    </td>
                    <td>{REQUIREMENT_KIND_LABEL[r.kind as keyof typeof REQUIREMENT_KIND_LABEL] ?? r.kind}</td>
                    <td>{REVIEW_LABEL[r.reviewStatus] ?? r.reviewStatus}</td>
                    <td>{r.openFlags > 0 ? <span className="pill" style={{ color: '#ff9f43' }}>{r.openFlags} open</span> : <span className="muted">—</span>}</td>
                    <td>{r.testCaseCount === 0 ? <span className="muted">none</span> : `${r.testCaseCount} (${r.approvedTestCaseCount} approved)`}</td>
                  </tr>
                  {open === r.id && (
                    <tr style={{ cursor: 'default' }}>
                      <td colSpan={6}>
                        <RequirementDetail id={r.id} all={items} onChanged={load} />
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
              {items.length === 0 && (
                <tr style={{ cursor: 'default' }}>
                  <td colSpan={6} className="muted">
                    No requirements yet. Add one, or import them from BRD/FSD text.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
