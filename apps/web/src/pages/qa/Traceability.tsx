import { useCallback, useEffect, useState } from 'react';
import { TEST_CASE_STATUS_LABEL, type TestCaseStatus } from '@qavo/shared';
import { api, type QaRatio, type QaTraceability } from '../../api.ts';
import { useLive } from '../../live.tsx';
import { StatusBadge } from './TestCases.tsx';

/** A coverage tile: always shows numerator/denominator and the formula; "—" when the denominator is 0. */
function Coverage({ id, label, ratio, formula }: { id: string; label: string; ratio: QaRatio; formula: string }) {
  return (
    <div className="kpi" data-coverage={id} title={formula}>
      <span className="kpi-label">{label}</span>
      <span className="kpi-value">{ratio.percent === null ? '—' : `${ratio.percent}%`}</span>
      <span className="kpi-note">
        {ratio.denominator === 0 ? 'No requirements yet: a percentage would be meaningless.' : `${ratio.numerator} of ${ratio.denominator} requirements`}
      </span>
      <span className="kpi-note">{formula}</span>
    </div>
  );
}

const COVER_LABEL = { approved: 'Covered (approved)', unapproved: 'Covered, not approved', none: 'Not covered' } as const;
const COVER_COLOR = { approved: '#4be37c', unapproved: '#ffd54a', none: '#ff5d6c' } as const;

export function TraceabilityPanel({ projectId }: { projectId: string }) {
  const { qaVersion } = useLive();
  const [t, setT] = useState<QaTraceability | null>(null);
  const load = useCallback(() => void api.traceability(projectId).then(setT).catch(() => setT(null)), [projectId]);
  useEffect(load, [load, qaVersion]);
  if (!t) return <p className="muted loading" role="status">Loading…</p>;
  const s = t.summary;
  return (
    <div data-panel="traceability">
      <div className="kpis">
        <div className="kpi">
          <span className="kpi-label">Requirements</span>
          <span className="kpi-value">{s.requirements}</span>
          <span className="kpi-note">In this project.</span>
        </div>
        <div className="kpi">
          <span className="kpi-label">Test cases</span>
          <span className="kpi-value">{s.testCases}</span>
          <span className="kpi-note">Non-archived.</span>
        </div>
        <Coverage id="approved" label="Requirement coverage (approved)" ratio={s.requirementsWithApprovedTestCase} formula={s.formulas.approved} />
        <Coverage id="any" label="Requirement coverage (any status)" ratio={s.requirementsWithAnyTestCase} formula={s.formulas.any} />
        <div className="kpi" data-untraced>
          <span className="kpi-label">Test cases without a requirement</span>
          <span className="kpi-value">{s.untracedTestCases}</span>
          <span className="kpi-note">Not traceable to any requirement.</span>
        </div>
      </div>
      <section className="card">
        <h3>Requirement → test case matrix</h3>
        <div className="scroll-x">
          <table>
            <thead>
              <tr>
                <th>Requirement</th>
                <th>Coverage</th>
                <th>Test cases</th>
                <th>Open flags</th>
              </tr>
            </thead>
            <tbody>
              {t.rows.map((r) => (
                <tr key={r.requirementId} className="static" data-trace={r.ref} data-covered={r.covered}>
                  <td>
                    <strong className="mono">{r.ref}</strong> {r.title}
                  </td>
                  <td>
                    <span className="pill" style={{ color: COVER_COLOR[r.covered] }}>
                      {COVER_LABEL[r.covered]}
                    </span>
                  </td>
                  <td>
                    {r.testCases.length === 0 ? (
                      <span className="muted">—</span>
                    ) : (
                      r.testCases.map((c) => (
                        <span key={c.id} className="gap" title={`${c.title} (${TEST_CASE_STATUS_LABEL[c.status as TestCaseStatus] ?? c.status})`}>
                          {c.code} <StatusBadge status={c.status as TestCaseStatus} />
                        </span>
                      ))
                    )}
                  </td>
                  <td>{r.openFlags || <span className="muted">—</span>}</td>
                </tr>
              ))}
              {t.rows.length === 0 && (
                <tr className="static">
                  <td colSpan={4} className="muted empty">
                    No requirements yet.
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
