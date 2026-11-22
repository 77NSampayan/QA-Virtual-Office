/**
 * One shared animation clock for all sprites (about 4.5 fps). It only advances the FRAME INDEX of
 * the animation a status already selected; it never changes which status is shown. Respects
 * prefers-reduced-motion (frame stays 0) and pauses while the tab is hidden.
 */
import { useSyncExternalStore } from 'react';
import { FRAME_COUNT } from './robot.ts';

const TICK_MS = 220;
let frame = 0;
let timer: ReturnType<typeof setInterval> | null = null;
const listeners = new Set<() => void>();

const reducedMotion = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  if (!timer && !reducedMotion()) {
    timer = setInterval(() => {
      if (typeof document !== 'undefined' && document.hidden) return;
      frame = (frame + 1) % FRAME_COUNT;
      for (const l of listeners) l();
    }, TICK_MS);
  }
  return () => {
    listeners.delete(cb);
    if (listeners.size === 0 && timer) {
      clearInterval(timer);
      timer = null;
    }
  };
}

export const useFrame = (): number => useSyncExternalStore(subscribe, () => frame, () => 0);
