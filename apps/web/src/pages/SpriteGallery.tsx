import { ALL_STATUSES, ROBOT_TYPES, ROBOT_TYPE_INFO, STATUS_ANIMATION, STATUS_LABEL } from '@qavo/shared';
import { NOOK_KINDS, NOOK_LABEL, NOOK_VERB } from '../sprites/nook.ts';
import { DroneSprite, NookSprite, RobotSprite, StationSprite } from '../sprites/Sprite.tsx';
import { statusTextColor } from '../statusColor.ts';

/** Reference sheet of every robot type and status animation. Static design reference, NOT live data. */
export function SpriteGallery() {
  const palette = ROBOT_TYPE_INFO.qa_analyst.defaultPalette;
  return (
    <div className="page" data-page="sprites">
      <h2>Sprite gallery</h2>
      <p className="hint">Design reference only — these robots are not tied to any real session.</p>
      <section className="card">
        <h3>Status animations</h3>
        <div className="gallery">
          {ALL_STATUSES.map((s) => (
            <figure key={s} data-gallery-status={s}>
              <RobotSprite type="qa_analyst" status={s} palette={palette} scale={5} />
              <figcaption>
                <strong style={{ color: statusTextColor(s) }}>{STATUS_LABEL[s]}</strong>
                <span className="muted">{STATUS_ANIMATION[s]}</span>
              </figcaption>
            </figure>
          ))}
        </div>
      </section>
      <section className="card">
        <h3>Robot types and workstations</h3>
        <div className="gallery wide">
          {ROBOT_TYPES.map((t) => (
            <figure key={t} data-gallery-type={t}>
              <div className="stage">
                <RobotSprite type={t} status="writing_tests" palette={ROBOT_TYPE_INFO[t].defaultPalette} scale={4} className="at-desk" />
                <StationSprite type={t} status="writing_tests" palette={ROBOT_TYPE_INFO[t].defaultPalette} scale={4} />
              </div>
              <figcaption>
                <strong>{ROBOT_TYPE_INFO[t].label}</strong>
                <span className="muted">{ROBOT_TYPE_INFO[t].workstation}</span>
              </figcaption>
            </figure>
          ))}
        </div>
      </section>
      <section className="card">
        <h3>Lounge furniture</h3>
        <p className="hint">Robots rest here only while their real status is idle or completed.</p>
        <div className="gallery wide">
          {NOOK_KINDS.map((k, i) => (
            <figure key={k} data-gallery-nook={k}>
              <div className="stage nook-stage">
                <RobotSprite type={ROBOT_TYPES[(i * 2) % ROBOT_TYPES.length]!} status={i === 1 ? 'completed' : 'idle'} palette={ROBOT_TYPE_INFO[ROBOT_TYPES[(i * 2) % ROBOT_TYPES.length]!].defaultPalette} scale={4} className="in-nook" />
                <div className="nook-pair">
                  <NookSprite kind={k} palette={ROBOT_TYPE_INFO[ROBOT_TYPES[(i * 2) % ROBOT_TYPES.length]!].defaultPalette} layer="back" />
                  <NookSprite kind={k} palette={ROBOT_TYPE_INFO[ROBOT_TYPES[(i * 2) % ROBOT_TYPES.length]!].defaultPalette} layer="front" />
                </div>
              </div>
              <figcaption>
                <strong>{NOOK_LABEL[k]}</strong>
                <span className="muted">{NOOK_VERB[k]}</span>
              </figcaption>
            </figure>
          ))}
        </div>
      </section>
      <section className="card">
        <h3>Subagent drones</h3>
        <div className="gallery">
          {ALL_STATUSES.map((s) => (
            <figure key={s}>
              <DroneSprite status={s} scale={6} />
              <figcaption className="muted">{STATUS_LABEL[s]}</figcaption>
            </figure>
          ))}
        </div>
      </section>
    </div>
  );
}
