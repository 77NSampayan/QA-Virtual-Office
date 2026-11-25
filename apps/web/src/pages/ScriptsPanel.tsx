import { useCallback, useEffect, useState } from 'react';
import { REVIEW_VERDICT_LABEL, SCRIPT_STATUS_LABEL, type ReviewVerdict } from '@qavo/shared';
import { api, type AutomationScript, type AutomationScriptDetail } from '../api.ts';
import { MsgLine, useMsg } from './qa/Requirements.tsx';

const reviewText = (x: AutomationScript['review']) => (x ? (x.current ? `${x.by} ${REVIEW_VERDICT_LABEL[x.verdict as ReviewVerdict] ?? x.verdict}` : `review by ${x.by} is outdated`) : 'not reviewed');

/** One script draft: its text, who wrote and reviewed it, and the person-only decision. */
export function ScriptDetail({ id, onChanged }: { id: string; onChanged: () => void }) {
  const [d, setD] = useState<AutomationScriptDetail | null>(null);
  const [reason, setReason] = useState('');
  const [copied, setCopied] = useState(false);
  const m = useMsg();
  const load = useCallback(() => void api.automationScript(id).then(setD).catch(m.fail), [id]);
  useEffect(load, [load]);
  if (!d) return <p className="muted loading" role="status">Loading…</p>;
  const decide = (to: 'approved' | 'rejected') => {
    if (to === 'approved' && !confirm(`Approve ${d.code}? This only records your decision: nothing is run and nothing is added to your project.`)) return;
    void api
      .decideScript(d.id, to, reason)
      .then(() => (setReason(''), load(), onChanged(), m.ok(to === 'approved' ? 'Approved.' : 'Rejected.')))
      .catch(m.fail);
  };
  return (
    <div className="detail" data-script-detail={d.code}>
      <p>
        <strong>{d.title}</strong> <span className="pill">{SCRIPT_STATUS_LABEL[d.status]}</span>
      </p>
      <p className="muted">
        {d.framework} · version {d.version} · drafted by <strong>{d.draftedBy}</strong> · automates {d.testCaseCode ? <span className="mono">{d.testCaseCode}</span> : 'a test case that was removed'}
      </p>
      {d.review && (
        <div className="plan quiet" data-script-review={d.review.current ? d.review.verdict : 'outdated'}>
          <p>
            <strong>{d.review.by}</strong> {REVIEW_VERDICT_LABEL[d.review.verdict as ReviewVerdict] ?? d.review.verdict}
            {!d.review.current && <span className="muted"> (outdated: the script changed after this review)</span>}
          </p>
          {d.review.notes && <p className="prewrap">{d.review.notes}</p>}
          <p className="hint">A reviewer agent only recommends. Only you can approve or reject.</p>
        </div>
      )}
      {d.writerReply && (
        <p className="muted prewrap" data-script-reply>
          {d.draftedBy} answered: {d.writerReply}
        </p>
      )}
      {d.notes && <p className="muted prewrap">Notes: {d.notes}</p>}
      <div className="row">
        <h3 className="grow">Script text</h3>
        <button
          className="ghost"
          data-script-copy
          onClick={() => {
            try {
              void navigator.clipboard.writeText(d.content).then(() => setCopied(true));
            } catch {
              m.fail(new Error('Copying is not available here: select the text and copy it.'));
            }
          }}
        >
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <pre className="prewrap" data-script-text style={{ overflowX: 'auto', maxHeight: 360 }}>
        {d.content}
      </pre>
      <p className="hint">Nothing here is run and nothing is written into your project. If you approve it, copy it into your project yourself. Secrets and personal data were masked when it was saved.</p>
      {d.status === 'draft' ? (
        <div className="project-form">
          <label>
            Reason (required to reject)
            <input value={reason} maxLength={2000} onChange={(e) => setReason(e.target.value)} data-script-reason />
          </label>
          <div className="row">
            <button data-script-approve onClick={() => decide('approved')}>
              Approve
            </button>
            <button className="danger" data-script-reject disabled={!reason.trim()} onClick={() => decide('rejected')}>
              Reject
            </button>
          </div>
        </div>
      ) : (
        <p className="muted" data-script-decided>
          {SCRIPT_STATUS_LABEL[d.status]} by you{d.decidedAt ? ` on ${new Date(d.decidedAt).toLocaleString()}` : ''}. {d.decisionNote}
        </p>
      )}
      <MsgLine msg={m.msg} />
    </div>
  );
}

/** The table of script drafts of the current project. */
export function ScriptsPanel({ scripts, open, onOpen }: { scripts: AutomationScript[] | null; open: string | null; onOpen: (id: string | null) => void }) {
  return (
    <section className="card" data-auto-scripts>
      <h3>Script drafts from the Automation Writer</h3>
      <p className="hint">
        Run the Automation Writer (Axel) from the <a href="#/team">Team page</a>: it writes script drafts for your <strong>approved</strong> test cases, a different agent (Vera) reviews them, and <strong>you</strong> approve or reject. Scripts are kept as text here; nothing is run and
        nothing is written into your project.
      </p>
      {scripts === null ? (
        <p className="muted loading" role="status">
          Loading…
        </p>
      ) : (
        <div className="scroll-x">
          <table data-auto-script-table>
            <thead>
              <tr>
                <th>Script</th>
                <th>Title</th>
                <th>Test case</th>
                <th>Status</th>
                <th>Review</th>
              </tr>
            </thead>
            <tbody>
              {scripts.map((x) => (
                <tr key={x.id} className={open === x.id ? 'selected' : ''} data-script-row={x.code} onClick={() => onOpen(open === x.id ? null : x.id)}>
                  <td className="mono">{x.code}</td>
                  <td>
                    {x.title}{' '}
                    <span className="muted">
                      · {x.framework} · by {x.draftedBy}
                    </span>
                  </td>
                  <td className="mono">{x.testCaseCode ?? '—'}</td>
                  <td>{SCRIPT_STATUS_LABEL[x.status]}</td>
                  <td className="muted">{reviewText(x.review)}</td>
                </tr>
              ))}
              {scripts.length === 0 && (
                <tr className="static">
                  <td colSpan={5} className="muted empty">
                    No script drafts yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
