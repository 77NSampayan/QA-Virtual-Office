import { useEffect, useState } from 'react';
import { departmentOf, STATUS_COLOR, STATUS_LABEL, ALL_STATUSES } from '@qavo/shared';
import { api, type QaExecutionSummary, type QaSummary } from '../api.ts';
import { Floor } from '../Floor.tsx';
import { useLive } from '../live.tsx';
import { isActive, Kpi, needsAttention, useNow } from '../ui.tsx';

/**
 * QA Office Overview. Every KPI is either computed from real events/records or explicitly shows
 * "No data yet" with the pass in which its source arrives (nothing is invented).
 */
/** Result KPIs show real figures only: "No data yet" until a test has actually been executed. */
function execKpi(x: QaExecutionSummary | undefined, value: number | undefined, label: string) {
  if (!x || x.resultsRecorded === 0) return { nodata: 'No test has been executed yet (Manual QA → Execution)', how: '' };
  return {
    value: value ?? 0,
    how: `Latest ${label} result per approved test case, out of ${x.approvedTestCases} approved. Pass rate: ${x.passRate.percent === null ? '—' : `${x.passRate.percent}% (${x.passRate.numerator} of ${x.passRate.denominator}: passed / (passed + failed + blocked))`}.`,
  };
}

export function Overview() {
  const { projects, sessions, robots, unread, qaVersion } = useLive();
  const now = useNow();
  const [qa, setQa] = useState<QaSummary | null>(null);
  useEffect(() => {
    void api.qaSummary().then(setQa).catch(() => setQa(null));
  }, [qaVersion]);
  const x = qa?.execution;
  const active = sessions.filter((s) => isActive(s, now));
  const attention = sessions.filter((s) => needsAttention(s) && now - s.lastEventAt <= 24 * 3600_000);
  const deptOf = (id: string | undefined) => (id ? departmentOf(robots.find((r) => r.id === id)?.role ?? '') : 'manual');
  const activeIn = (dept: string) => active.filter((s) => deptOf(s.robot?.id) === dept).length;
  const byStatus = ALL_STATUSES.filter((st) => st !== 'disconnected').map((st) => ({ st, n: active.filter((s) => s.status === st).length }));
  const maxN = Math.max(1, ...byStatus.map((b) => b.n));

  return (
    <div className="page" data-page="overview">
      <h2>QA Office Overview</h2>
      <div className="kpis">
        <Kpi id="projects" label="Registered projects" value={projects.filter((p) => !p.archived).length} how="Count of registered, non-archived projects." />
        <Kpi id="active-agents" label="Active QA agents" value={active.length} how="Claude Code sessions that have not ended and sent an event in the last 30 minutes." />
        <Kpi id="attention" label="Agents requiring attention" value={attention.length} how="Sessions awaiting permission or input, or failed, in the last 24 hours." />
        <Kpi id="manual-active" label="Manual QA agents active" value={activeIn('manual')} how="Active sessions whose robot has a Manual QA role." />
        <Kpi id="automation-active" label="Automation agents active" value={activeIn('automation')} how="Active sessions whose robot has an Automation role." />
        <Kpi id="writing" label="Writing test cases (inferred)" value={active.filter((s) => s.status === 'writing_tests').length} how="Active sessions currently editing test-like files. Inferred from tool activity, not stated by Claude Code." />
        <Kpi id="running" label="Running test executions (inferred)" value={active.filter((s) => s.status === 'executing_tests').length} how="Active sessions currently running a test command. Inferred from tool activity." />
        <Kpi id="unread" label="Unread notifications" value={unread} how="Notifications you have not marked as read." />
        <Kpi id="review" label="Test cases awaiting review" value={qa?.testCasesAwaitingReview ?? 0} how="Non-archived test cases submitted for review and waiting for you to approve or reject them." />
        <Kpi id="passed" label="Passed tests" {...execKpi(x, x?.passed, 'passed')} />
        <Kpi id="failed" label="Failed tests" {...execKpi(x, x?.failed, 'failed')} />
        <Kpi id="blocked" label="Blocked tests" {...execKpi(x, x?.blocked, 'blocked')} />
        <Kpi
          id="pending"
          label="Pending test cases"
          {...(x && x.approvedTestCases > 0
            ? { value: x.pending, how: `Formula: approved test cases (${x.approvedTestCases}) minus those with a finished result. Draft, rejected and archived cases are not counted.` }
            : { nodata: 'Needs approved test cases', how: '' })}
        />
        <Kpi
          id="defects"
          label="Open defects"
          {...(qa && qa.defects.total > 0
            ? {
                value: qa.defects.open,
                how: `Defects not yet closed, rejected or marked duplicate (${qa.defects.open} of ${qa.defects.total} reported). Open by severity: critical ${qa.defects.openBySeverity.critical ?? 0}, major ${qa.defects.openBySeverity.major ?? 0}, minor ${qa.defects.openBySeverity.minor ?? 0}, trivial ${qa.defects.openBySeverity.trivial ?? 0}.`,
              }
            : { nodata: 'No defect has been reported yet (Manual QA → Defects)', how: '' })}
        />
      </div>

      <section className="card workload" data-workload>
        <h3>Current testing workload</h3>
        {active.length === 0 ? (
          <p className="muted">No active agents. Start Claude Code in a registered project and its robot will go to work.</p>
        ) : (
          <ul className="bars">
            {byStatus.map(({ st, n }) => (
              <li key={st} data-status={st}>
                <span className="bar-label">{STATUS_LABEL[st]}</span>
                <span className="bar" style={{ width: `${(n / maxN) * 100}%`, background: STATUS_COLOR[st] }} />
                <span className="bar-n">{n}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <Floor robots={robots} sessions={sessions} now={now} />
    </div>
  );
}
