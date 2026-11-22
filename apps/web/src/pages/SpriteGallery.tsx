import { ALL_STATUSES, ROBOT_TYPES, ROBOT_TYPE_INFO, STATUS_ANIMATION, STATUS_COLOR, STATUS_LABEL } from '@qavo/shared';
import { DroneSprite, RobotSprite, StationSprite } from '../sprites/Sprite.tsx';

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
                <strong style={{ color: STATUS_COLOR[s] }}>{STATUS_LABEL[s]}</strong>
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
