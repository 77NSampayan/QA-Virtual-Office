import { useEffect, useState } from 'react';
import { ALL_STATUSES, ROBOT_TYPES, ROBOT_TYPE_INFO, STATUS_ANIMATION, STATUS_LABEL, type RobotStatus, type RobotType } from '@qavo/shared';
import { api, ApiError, type Robot } from '../api.ts';
import { useLive } from '../live.tsx';
import { RobotSprite, StationSprite } from '../sprites/Sprite.tsx';
import { agoIso, StatusPill, typeOf, useNow } from '../ui.tsx';

function RobotEditor({ robot }: { robot: Robot }) {
  const { sessionOf, refresh } = useLive();
  const now = useNow();
  const session = sessionOf(robot.id);
  const [name, setName] = useState(robot.name);
  const [type, setType] = useState<RobotType>(typeOf(robot));
  const [role, setRole] = useState<RobotType>(ROBOT_TYPES.includes(robot.role as RobotType) ? (robot.role as RobotType) : 'qa_analyst');
  const [primary, setPrimary] = useState(robot.palette.primary);
  const [accent, setAccent] = useState(robot.palette.accent);
  const [preview, setPreview] = useState<RobotStatus | 'live'>('live');
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  // keep the form in step with the saved robot (e.g. an edit made in another window)
  useEffect(() => {
    setName(robot.name);
    setType(typeOf(robot));
    setRole(ROBOT_TYPES.includes(robot.role as RobotType) ? (robot.role as RobotType) : 'qa_analyst');
    setPrimary(robot.palette.primary);
    setAccent(robot.palette.accent);
  }, [robot.name, robot.robotType, robot.role, robot.palette.primary, robot.palette.accent]);
  const live: RobotStatus = session?.status ?? 'disconnected';
  const shown = preview === 'live' ? live : preview;
  const dirty = name !== robot.name || type !== typeOf(robot) || role !== robot.role || primary !== robot.palette.primary || accent !== robot.palette.accent;

  const save = async () => {
    try {
      await api.patchRobot(robot.id, { name, robotType: type, role, palette: { primary, accent } });
      await refresh();
      setMsg({ ok: true, text: 'Saved. This identity persists across restarts.' });
    } catch (err) {
      setMsg({ ok: false, text: err instanceof ApiError ? err.code : String(err) });
    }
  };

  return (
    <section className="card robot-editor" data-robot-editor={robot.id}>
      <div className="editor-preview">
        <div className="stage">
          <RobotSprite type={type} status={shown} palette={{ primary, accent }} scale={5} className="at-desk" />
          <StationSprite type={type} status={shown} palette={{ primary, accent }} scale={5} />
        </div>
        <label>
          Animation preview
          <select value={preview} onChange={(e) => setPreview(e.target.value as RobotStatus | 'live')}>
            <option value="live">Live state ({STATUS_LABEL[live]})</option>
            {ALL_STATUSES.map((s) => (
              <option key={s} value={s}>
                {STATUS_LABEL[s]} — {STATUS_ANIMATION[s]}
              </option>
            ))}
          </select>
        </label>
        {preview !== 'live' && <p className="hint">Preview only: this is not the robot&apos;s real state.</p>}
        <p className="muted">
          Real state: <StatusPill status={live} source={session?.statusSource ?? 'event'} /> {session ? `· seen ${agoIso(new Date(session.lastEventAt).toISOString(), now)}` : '· no session yet'}
        </p>
      </div>
      <div className="editor-form">
        <label>
          Name
          <input value={name} maxLength={30} onChange={(e) => setName(e.target.value)} />
        </label>
        <label>
          Appearance
          <select value={type} onChange={(e) => setType(e.target.value as RobotType)}>
            {ROBOT_TYPES.map((t) => (
              <option key={t} value={t}>
                {ROBOT_TYPE_INFO[t].label}
              </option>
            ))}
          </select>
        </label>
        <label>
          Logical QA role (decides the department and station)
          <select value={role} onChange={(e) => setRole(e.target.value as RobotType)}>
            {ROBOT_TYPES.map((t) => (
              <option key={t} value={t}>
                {ROBOT_TYPE_INFO[t].label} — {ROBOT_TYPE_INFO[t].specialty}
              </option>
            ))}
          </select>
        </label>
        <div className="row">
          <label>
            Body colour
            <input type="color" value={primary} onChange={(e) => setPrimary(e.target.value)} />
          </label>
          <label>
            Accent colour
            <input type="color" value={accent} onChange={(e) => setAccent(e.target.value)} />
          </label>
          <button
            type="button"
            className="ghost"
            onClick={() => {
              setPrimary(ROBOT_TYPE_INFO[type].defaultPalette.primary);
              setAccent(ROBOT_TYPE_INFO[type].defaultPalette.accent);
            }}
          >
            Reset colours
          </button>
        </div>
        <div className="row">
          <button disabled={!dirty} onClick={save}>
            Save
          </button>
        </div>
        <p className="hint">Roles are logical roles in this app; Claude Code has no native specialised agent types.</p>
        {msg && <p className={msg.ok ? 'ok' : 'error'}>{msg.text}</p>}
      </div>
    </section>
  );
}

export function Robots() {
  const { robots } = useLive();
  return (
    <div className="page" data-page="robots">
      <h2>Robots</h2>
      <p className="hint">A robot is created when a Claude Code session starts and keeps its identity (name, look, colours, role) across sessions and restarts.</p>
      {robots.length === 0 && <p className="muted">No robots yet. Start Claude Code in a registered project.</p>}
      {robots.map((r) => (
        <RobotEditor key={r.id} robot={r} />
      ))}
    </div>
  );
}
