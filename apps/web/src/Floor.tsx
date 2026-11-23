import { useState } from 'react';
import { DEPARTMENT_LABEL, departmentOf, type Department } from '@qavo/shared';
import type { Robot, Session } from './api.ts';
import { isResting, Lounge } from './Lounge.tsx';
import { ACTIVE_WINDOW_MS, RobotCard, RobotStation } from './ui.tsx';

const DAY_MS = 24 * 3600_000;
const ORDER: Department[] = ['manual', 'automation', 'lead'];

export interface FloorProps {
  robots: Robot[];
  sessions: Session[];
  now: number;
  /** Restrict to robots whose latest session belongs to this project. */
  projectId?: string;
  /** Departments to show (default: all three). */
  departments?: Department[];
}

/** Latest session per robot. */
function latestByRobot(sessions: Session[]): Map<string, Session> {
  const m = new Map<string, Session>();
  for (const s of [...sessions].sort((a, b) => b.lastEventAt - a.lastEventAt)) {
    if (s.robot && !m.has(s.robot.id)) m.set(s.robot.id, s);
  }
  return m;
}

/** The pixel-art office: departments with robots at their stations. Desktop shows the floor, narrow screens show status cards. */
export function Floor({ robots, sessions, now, projectId, departments = ORDER }: FloorProps) {
  const [showAll, setShowAll] = useState(false);
  const latest = latestByRobot(sessions);
  const visible = robots.filter((r) => {
    const s = latest.get(r.id);
    if (projectId && s?.projectId !== projectId) return false;
    if (showAll) return true;
    return !!s && now - s.lastEventAt <= DAY_MS;
  });
  const hiddenCount = robots.length - visible.length;
  // Robots whose session is idle or has just finished rest in the lounge; everyone else is at a desk.
  const inScope = visible.filter((r) => departments.includes(departmentOf(r.role)));
  const resting = inScope.filter((r) => isResting(latest.get(r.id))).sort((a, b) => (latest.get(b.id)?.lastEventAt ?? 0) - (latest.get(a.id)?.lastEventAt ?? 0));

  return (
    <div className="floor-wrap" data-floor>
      <label className="check floor-toggle">
        <input type="checkbox" checked={showAll} onChange={(e) => setShowAll(e.target.checked)} />
        Show robots idle for more than 24 hours{hiddenCount > 0 && !showAll ? ` (${hiddenCount} hidden)` : ''}
      </label>
      {departments.map((dept) => {
        const list = visible
          .filter((r) => departmentOf(r.role) === dept && !isResting(latest.get(r.id)))
          .sort((a, b) => (latest.get(b.id)?.lastEventAt ?? 0) - (latest.get(a.id)?.lastEventAt ?? 0));
        const active = list.filter((r) => {
          const s = latest.get(r.id);
          return s && s.status !== 'disconnected' && now - s.lastEventAt <= ACTIVE_WINDOW_MS;
        }).length;
        return (
          <section className={`dept dept-${dept}`} key={dept} data-dept={dept}>
            <h3>
              {DEPARTMENT_LABEL[dept]} <span className="muted">· {active} active / {list.length} at desks</span>
            </h3>
            {list.length === 0 ? (
              <p className="muted empty-dept">
                {resting.some((r) => departmentOf(r.role) === dept)
                  ? 'Everyone here is resting in the lounge.'
                  : 'No robots here yet. A robot appears when a Claude Code session starts in a registered project, and you can assign its role on the Robots page.'}
              </p>
            ) : (
              <>
                <div className="floor">
                  {list.map((r) => (
                    <RobotStation key={r.id} robot={r} session={latest.get(r.id)} now={now} />
                  ))}
                </div>
                <div className="cards">
                  {list.map((r) => (
                    <RobotCard key={r.id} robot={r} session={latest.get(r.id)} now={now} />
                  ))}
                </div>
              </>
            )}
          </section>
        );
      })}
      <Lounge resting={resting} latest={latest} now={now} />
    </div>
  );
}
