import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { ROBOT_TYPE_INFO, STATUS_LABEL, isRobotType, type RobotStatus, type RobotType } from '@qavo/shared';
import type { Robot, Session } from './api.ts';
import { DroneSprite, RobotSprite, StationSprite } from './sprites/Sprite.tsx';
import { statusTextColor } from './statusColor.ts';

export const ACTIVE_WINDOW_MS = 30 * 60_000;

export function useNow(intervalMs = 5000): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}

export function ago(ms: number, now: number): string {
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}
export const agoIso = (iso: string | null, now: number) => (iso ? ago(Date.parse(iso), now) : 'never');

/** A session counts as "active" when it has not ended and was seen in the last 30 minutes. */
export const isActive = (s: Session, now: number) => s.status !== 'disconnected' && now - s.lastEventAt <= ACTIVE_WINDOW_MS;
export const needsAttention = (s: Session) => s.status === 'awaiting_permission' || s.status === 'awaiting_input' || s.status === 'failed';

export function StatusPill({ status, source }: { status: RobotStatus; source: string }) {
  return (
    <span className="pill" style={{ color: statusTextColor(status) }} data-status={status} title={source === 'inferred' ? 'Inferred from tool activity' : 'Stated by the hook event'}>
      {source === 'inferred' ? '~ ' : ''}
      {STATUS_LABEL[status]}
    </span>
  );
}

export function typeOf(robot: Robot): RobotType {
  return isRobotType(robot.robotType) ? robot.robotType : 'qa_analyst';
}

/** A robot standing at its workstation. State comes ONLY from the robot's real session. */
export function RobotStation({ robot, session, now, scale = 4, showProject = true }: { robot: Robot; session: Session | undefined; now: number; scale?: number; showProject?: boolean }) {
  const status: RobotStatus = session?.status ?? 'disconnected';
  const type = typeOf(robot);
  return (
    <div className="station-unit" data-robot={robot.id} data-status={status} data-name={robot.name}>
      <div className="stage">
        {session && session.drones.length > 0 && (
          <div className="drones">
            {session.drones.slice(0, 3).map((d) => (
              <DroneSprite key={d.agentId} status={d.status} />
            ))}
          </div>
        )}
        <RobotSprite type={type} status={status} palette={robot.palette} scale={scale} className="at-desk" />
        <StationSprite type={type} status={status} palette={robot.palette} scale={scale} />
      </div>
      <div className="plate">
        <strong>{robot.name}</strong>
        <span className="muted">{ROBOT_TYPE_INFO[type].label}</span>
        <StatusPill status={status} source={session?.statusSource ?? 'event'} />
        {showProject && <span className="muted">{session?.projectAlias ?? (session ? 'unregistered folder' : 'no session yet')}</span>}
        {session && <span className="muted">seen {ago(session.lastEventAt, now)}</span>}
      </div>
    </div>
  );
}

/** Compact text row for narrow screens: information first, decoration last. */
export function RobotCard({ robot, session, now }: { robot: Robot; session: Session | undefined; now: number }) {
  const status: RobotStatus = session?.status ?? 'disconnected';
  return (
    <div className="robot-card" data-robot={robot.id} data-status={status}>
      <RobotSprite type={typeOf(robot)} status={status} palette={robot.palette} scale={2} />
      <div>
        <strong>{robot.name}</strong> <span className="muted">{ROBOT_TYPE_INFO[typeOf(robot)].label}</span>
        <div>
          <StatusPill status={status} source={session?.statusSource ?? 'event'} />
        </div>
        <div className="muted">
          {session?.projectAlias ?? (session ? 'unregistered folder' : 'no session yet')}
          {session ? ` · seen ${ago(session.lastEventAt, now)}` : ''}
        </div>
      </div>
    </div>
  );
}

export function Kpi({ id, label, value, how, nodata }: { id: string; label: string; value?: ReactNode; how: string; nodata?: string }) {
  return (
    <div className={`kpi ${nodata ? 'nodata' : ''}`} data-kpi={id} data-nodata={nodata ? 'true' : 'false'} title={how}>
      <span className="kpi-label">{label}</span>
      {nodata ? (
        <span className="kpi-value muted">No data yet</span>
      ) : (
        <span className="kpi-value">{value}</span>
      )}
      <span className="kpi-note">{nodata ?? how}</span>
    </div>
  );
}

export function ComingSoon({ title, pass, intro, items }: { title: string; pass: string; intro: string; items: string[] }) {
  return (
    <section className="card coming" data-coming={pass}>
      <h2>{title}</h2>
      <p className="pill soon">Arrives in {pass}</p>
      <p>{intro}</p>
      <ul>
        {items.map((i) => (
          <li key={i}>{i}</li>
        ))}
      </ul>
      <p className="hint">Nothing on this screen is simulated: it stays empty until the feature exists and has real data.</p>
    </section>
  );
}

export const NoData = ({ title, pass, text }: { title: string; pass: string; text?: string }) => (
  <section className="card nodata-panel" data-nodata="true">
    <h3>{title}</h3>
    <p className="muted">
      No data yet — {text ?? 'this appears once test execution and defects are tracked'} (arrives in {pass}).
    </p>
  </section>
);

/**
 * Side drawer for the details of a selected table row. Not modal on wide screens (the table stays usable beside it; the page
 * makes room via the `drawer-open` class on body); a full-width overlay on narrow ones. Escape or the Close button closes it.
 */
export function Drawer({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    document.body.classList.add('drawer-open');
    return () => document.body.classList.remove('drawer-open');
  }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null; // never lose text being typed
      if (e.key === 'Escape' && !(t && /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  useEffect(() => ref.current?.focus({ preventScroll: true }), [title]);
  return createPortal(
    <aside className="drawer" ref={ref} tabIndex={-1} role="complementary" aria-label={`Details: ${title}`} data-drawer>
      <header className="drawer-head">
        <strong className="grow mono">{title}</strong>
        <button className="ghost" onClick={onClose} data-drawer-close aria-label="Close details">
          Close
        </button>
      </header>
      <div className="drawer-body">{children}</div>
    </aside>,
    document.body,
  );
}
