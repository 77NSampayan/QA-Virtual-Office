/**
 * Tray and taskbar icons drawn from the SAME pixel sprites as the office (a crisp 16x16 crop of the
 * robot's head, doubled for high-DPI), with an optional attention dot. No image files are shipped.
 */
import { nativeImage, type NativeImage } from 'electron';
import { STATUS_COLOR, type RobotStatus } from '@qavo/shared';
import type { Grid } from '../../web/src/sprites/grid.ts';
import { renderRobot } from '../../web/src/sprites/robot.ts';

const SIZE = 16;

function bgra(grid: Grid, x0: number, y0: number, w: number, h: number, scale: number, dot?: string): Buffer {
  const out = Buffer.alloc(w * scale * h * scale * 4);
  const put = (x: number, y: number, hex: string) => {
    const o = (y * w * scale + x) * 4;
    out[o] = parseInt(hex.slice(5, 7), 16); // B
    out[o + 1] = parseInt(hex.slice(3, 5), 16); // G
    out[o + 2] = parseInt(hex.slice(1, 3), 16); // R
    out[o + 3] = 255;
  };
  for (let y = 0; y < h * scale; y++) {
    for (let x = 0; x < w * scale; x++) {
      const c = grid[y0 + Math.floor(y / scale)]?.[x0 + Math.floor(x / scale)];
      if (c) put(x, y, c);
    }
  }
  if (dot) {
    // attention dot, bottom-right, 6x6 logical px with a dark rim
    for (let y = h - 7; y < h; y++) {
      for (let x = w - 7; x < w; x++) {
        const rim = x === w - 7 || y === h - 7 || x === w - 1 || y === h - 1;
        for (let sy = 0; sy < scale; sy++) for (let sx = 0; sx < scale; sx++) put(x * scale + sx, y * scale + sy, rim ? '#0b0f1a' : dot);
      }
    }
  }
  return out;
}

export function robotIcon(status: RobotStatus = 'idle', attention: 'none' | 'warning' | 'alert' = 'none'): NativeImage {
  const grid = renderRobot({ type: 'qa_analyst', status, palette: { primary: '#6f7fe8', accent: '#ffd54a' }, frame: 0 });
  const dot = attention === 'none' ? undefined : attention === 'alert' ? STATUS_COLOR.failed : STATUS_COLOR.awaiting_permission;
  // rows 3..18 / cols 4..19: antenna, head and shoulders of the 24x24 sprite
  const img = nativeImage.createFromBitmap(bgra(grid, 4, 3, SIZE, SIZE, 1, dot), { width: SIZE, height: SIZE, scaleFactor: 1 });
  img.addRepresentation({ scaleFactor: 2, width: SIZE * 2, height: SIZE * 2, buffer: bgra(grid, 4, 3, SIZE, SIZE, 2, dot) });
  return img;
}

/** Small coloured badge for the taskbar button overlay. */
export function overlayIcon(color: string): NativeImage {
  const g: Grid = Array.from({ length: SIZE }, (_, y) => Array.from({ length: SIZE }, (_, x) => ((x - 7.5) ** 2 + (y - 7.5) ** 2 <= 49 ? color : null)));
  return nativeImage.createFromBitmap(bgra(g, 0, 0, SIZE, SIZE, 1), { width: SIZE, height: SIZE, scaleFactor: 1 });
}
