import { ROBOT_TYPE_INFO, type RobotStatus } from '@qavo/shared';
import type { Robot, Session } from './api.ts';
import { NOOK_KINDS, NOOK_LABEL, NOOK_VERB, nookForRobot, type NookKind } from './sprites/nook.ts';
import { NookSprite, RobotSprite } from './sprites/Sprite.tsx';
import { RobotCard, StatusPill, typeOf } from './ui.tsx';

/** A robot rests in the lounge only while its real status is idle or completed (its session is open and it is not working or waiting for you). */
export const isResting = (s: Session | undefined): boolean => !!s && (s.status === 'idle' || s.status === 'completed');

const ago = (ms: number, now: number) => {
  const sec = Math.max(0, Math.round((now - ms) / 1000));
  if (sec < 60) return `${sec}s ago`;
  if (sec < 3600) return `${Math.round(sec / 60)}m ago`;
  if (sec < 86_400) return `${Math.round(sec / 3600)}h ago`;
  return `${Math.round(sec / 86_400)}d ago`;
};

function EmptyNook({ kind }: { kind: NookKind }) {
  const palette = ROBOT_TYPE_INFO.qa_analyst.defaultPalette;
  return (
    <div className="lounge-unit empty" data-nook-empty={kind}>
      <div className="stage nook-stage">
        <div className="nook-spacer" aria-hidden="true" />
        <div className="nook-pair">
          <NookSprite kind={kind} palette={palette} layer="back" />
          <NookSprite kind={kind} palette={palette} layer="front" />
        </div>
      </div>
      <div className="plate">
        <strong className="muted">{NOOK_LABEL[kind]}</strong>
        <span className="muted">free</span>
      </div>
    </div>
  );
}

function RestingRobot({ robot, session, now, scale = 4 }: { robot: Robot; session: Session; now: number; scale?: number }) {
  const status: RobotStatus = session.status;
  const type = typeOf(robot);
  const kind = nookForRobot(robot.id);
  return (
    <div className="station-unit lounge-unit" data-robot={robot.id} data-status={status} data-name={robot.name} data-nook={kind}>
      <div className="stage nook-stage">
        <RobotSprite type={type} status={status} palette={robot.palette} scale={scale} className="in-nook" />
        <div className="nook-pair">
          <NookSprite kind={kind} palette={robot.palette} scale={scale} layer="back" />
          <NookSprite kind={kind} palette={robot.palette} scale={scale} layer="front" />
        </div>
      </div>
      <div className="plate">
        <strong>{robot.name}</strong>
        <span className="muted">{ROBOT_TYPE_INFO[type].label}</span>
        <StatusPill status={status} source={session.statusSource ?? 'event'} />
        <span className="muted">
          {NOOK_VERB[kind]} · {session.projectAlias ?? 'unregistered folder'}
        </span>
        <span className="muted">seen {ago(session.lastEventAt, now)}</span>
      </div>
    </div>
  );
}

/**
 * The lounge: where robots rest. Who is here follows real status (idle or completed); the furniture
 * a robot uses is a stable cosmetic choice. When work resumes the robot is back at its desk at once.
 */
export function Lounge({ resting, latest, now }: { resting: Robot[]; latest: Map<string, Session>; now: number }) {
  const used = new Set(resting.map((r) => nookForRobot(r.id)));
  const emptyKinds = NOOK_KINDS.filter((k) => !used.has(k));
  return (
    <section className="dept dept-lounge" data-lounge>
      <h3>
        Lounge <span className="muted">· {resting.length} resting</span>
      </h3>
      <p className="muted lounge-note">Robots whose Claude Code session is idle or has just finished rest here, and go straight back to their desk when real work resumes.</p>
      <div className="floor">
        {resting.map((r) => (
          <RestingRobot key={r.id} robot={r} session={latest.get(r.id)!} now={now} />
        ))}
        {emptyKinds.map((k) => (
          <EmptyNook key={k} kind={k} />
        ))}
      </div>
      {resting.length > 0 ? (
        <div className="cards">
          {resting.map((r) => (
            <RobotCard key={r.id} robot={r} session={latest.get(r.id)} now={now} />
          ))}
        </div>
      ) : (
        <p className="muted cards-note">Nobody is resting right now.</p>
      )}
    </section>
  );
}
