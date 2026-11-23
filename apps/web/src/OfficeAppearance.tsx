import { useRef } from 'react';
import type { LightMode } from './office/light.ts';
import { lightFor } from './office/light.ts';
import { setPrefs, useOfficePrefs } from './office/prefs.ts';
import { browserAudio, OfficeSound, type SoundKind } from './office/sound.ts';
import { THEME_LABEL, THEME_PREFS, themeFor, type ThemePref } from './office/theme.ts';

const LIGHT_LABEL: Record<LightMode, string> = { auto: 'Automatic: follows your clock (day 06:30 to 18:30)', day: 'Always day', night: 'Always night' };
const TEST_SOUNDS: Array<[SoundKind, string]> = [
  ['arrive', 'Arrival'],
  ['complete', 'Finished'],
  ['fail', 'Failed'],
  ['alert', 'Needs you'],
];

/** Settings → Office appearance: day/night, seasonal theme and sounds. Per viewer, stored locally; sound is off until you turn it on. */
export function OfficeAppearance() {
  const prefs = useOfficePrefs();
  const tester = useRef<OfficeSound | null>(null);
  const now = new Date();
  const light = lightFor(now, prefs.light);
  const theme = themeFor(now, prefs.theme);
  const test = (kind: SoundKind) => {
    if (!tester.current) tester.current = new OfficeSound(browserAudio, () => Date.now()); // a click is the user gesture browsers require
    tester.current.setEnabled(true);
    tester.current.setVolume(prefs.volume);
    tester.current.unlock();
    tester.current.play(kind);
  };
  return (
    <section className="card" data-office-appearance>
      <h2>Office appearance</h2>
      <p className="muted">
        How the walkable office looks and sounds on this screen. These choices are saved only in this browser or desktop window. Right now it is <strong data-appearance-now>{light.phase}</strong> in the office
        {theme !== 'none' ? ` and the ${theme} decorations are up` : ''}.
      </p>

      <h3>Time of day</h3>
      <div role="radiogroup" aria-label="Time of day" data-appearance-light>
        {(Object.keys(LIGHT_LABEL) as LightMode[]).map((m) => (
          <label className="check" key={m}>
            <input type="radio" name="office-light" checked={prefs.light === m} onChange={() => setPrefs({ light: m })} data-light-option={m} />
            <span>{LIGHT_LABEL[m]}</span>
          </label>
        ))}
      </div>
      <p className="hint">Sun shines through the windows by day; at night the rooms dim and lit screens, hallway lamps and the lounge machines glow. Your location is never used.</p>

      <h3>Seasonal theme</h3>
      <div role="radiogroup" aria-label="Seasonal theme" data-appearance-theme>
        {THEME_PREFS.map((t: ThemePref) => (
          <label className="check" key={t}>
            <input type="radio" name="office-theme" checked={prefs.theme === t} onChange={() => setPrefs({ theme: t })} data-theme-option={t} />
            <span>{THEME_LABEL[t]}</span>
          </label>
        ))}
      </div>
      <p className="hint">Automatic: Halloween from 15 October to 2 November, Christmas from 1 December to 6 January. Decorations, hats and lights only; nothing about your data changes.</p>

      <h3>Sounds</h3>
      <label className="check">
        <input type="checkbox" checked={prefs.sound} onChange={(e) => setPrefs({ sound: e.target.checked })} data-sound-toggle />
        <span>Play office sounds (off by default)</span>
      </label>
      <label>
        Volume
        <input type="range" min={0} max={100} value={Math.round(prefs.volume * 100)} onChange={(e) => setPrefs({ volume: Number(e.target.value) / 100 })} aria-label="Sound volume" data-sound-volume />
      </label>
      <div className="row">
        {TEST_SOUNDS.map(([kind, label]) => (
          <button key={kind} className="ghost" onClick={() => test(kind)} data-test-sound={kind}>
            Hear: {label}
          </button>
        ))}
      </div>
      <p className="hint">
        Short, quiet tones synthesized in your browser (no audio files, nothing downloaded) when a robot arrives, finishes, fails, or needs you. They play only while the office is open and visible, and only for real events.
      </p>
    </section>
  );
}
