/**
 * Workstation sprites (32x16): a desk with a monitor whose screen content follows the status, plus a
 * type-specific side item (requirements terminal, testing device, dev rig, API server, execution
 * tray, debugging jar, control-desk dashboards). Pure function of (type, status, palette, frame).
 */
import { STATUS_COLOR, type RobotPalette, type RobotStatus, type RobotType } from '@qavo/shared';
import { box, darken, lighten, makeGrid, OUTLINE, powerOff, put, puts, rect, SCREEN_DARK, stamp, WHITE, type Grid } from './grid.ts';
import { FRAME_COUNT } from './robot.ts';

export const STATION_W = 32;
export const STATION_H = 16;
export const SCREEN = { x: 11, y: 2, w: 10, h: 7 } as const;

const SIDE_ITEM: Record<RobotType, { rows: readonly string[]; x: number; y: number }> = {
  qa_analyst: { x: 1, y: 3, rows: ['.wwwww..', '.wAAAw..', 'wwwwwww.', 'wAAAAAw.', 'wwwwwww.', 'wAAAAAw.', 'wwwwwww.'] }, // stacked documents
  manual_tester: { x: 2, y: 3, rows: ['.oooo.', 'oSSSSo', 'oSSSSo', 'oSSSSo', 'oSSSSo', 'oAAAAo', '.oooo.'] }, // handheld test device
  automation_engineer: { x: 1, y: 3, rows: ['...AA...', '.A.AA.A.', '..AAAA..', 'AAA..AAA', '..AAAA..', '.A.AA.A.', '...AA...'] }, // cog
  api_tester: { x: 1, y: 3, rows: ['oooooooo', 'oAoSSSSo', 'oooooooo', 'oAoSSSSo', 'oooooooo', 'oAoSSSSo', 'oooooooo'] }, // server rack
  regression_tester: { x: 1, y: 3, rows: ['oooooooo', 'oSSSSSSo', 'oAoAoAoo', 'oSSSSSSo', 'oAoAoAoo', 'oooooooo', '.o....o.'] }, // test tray
  bug_investigator: { x: 2, y: 3, rows: ['..oooo..', '.oSSSSo.', 'oSAASSSo', 'oSSAASSo', 'oSSSSSSo', '.oSSSSo.', '..oooo..'] }, // bug jar
  ci_operator: { x: 1, y: 3, rows: ['oooooooo', 'oAoooAoo', 'oAAAAAAo', 'oAoooAoo', 'oooooooo', '..o..o..', '.oooooo.'] }, // pipeline stages
  qa_lead: { x: 1, y: 3, rows: ['oooooooo', 'oSSSSSSo', 'oSaSaSSo', 'oSSSSSSo', 'oooooooo', '..o..o..', '.oooooo.'] }, // dashboard
};

function drawScreen(g: Grid, status: RobotStatus, frame: number, led: string): void {
  const { x, y, w, h } = SCREEN;
  rect(g, x, y, w, h, status === 'disconnected' ? '#05070d' : SCREEN_DARK);
  const dim = darken(led, 0.55);
  switch (status) {
    case 'disconnected':
      return;
    case 'idle':
      rect(g, x + 1, y + 1, 4, 1, dim);
      if (frame % 2 === 0) rect(g, x + 1, y + 3, 1, 2, led); // blinking cursor
      return;
    case 'analyzing': {
      for (const dy of [1, 3, 5]) rect(g, x + 1, y + dy, 8, 1, dim);
      rect(g, x + 1, y + [1, 3, 5, 3][frame]!, 8, 1, led); // scan line over the document
      return;
    }
    case 'writing_tests': {
      const widths = [3, 6, 4, 7];
      for (let i = 0; i < 3; i++) rect(g, x + 1, y + 1 + i * 2, widths[(frame + i) % 4]!, 1, i === 2 ? led : dim);
      return;
    }
    case 'executing_tests': {
      rect(g, x + 1, y + 2, 8, 1, dim);
      rect(g, x + 1, y + 2, 2 + frame * 2, 1, led); // progress bar filling
      rect(g, x + 1, y + 4, 8, 1, dim);
      rect(g, x + 1, y + 4, Math.max(1, 8 - frame * 2), 1, led);
      return;
    }
    case 'debugging': {
      for (const dy of [1, 3, 5]) rect(g, x + 1, y + dy, 8, 1, dim);
      rect(g, x + 1, y + 1 + (frame % 3) * 2, 8, 1, led); // error line jumping
      return;
    }
    case 'awaiting_permission': {
      const on = frame < 2;
      box(g, x + 1, y + 1, 8, 5, SCREEN_DARK, on ? led : dim);
      rect(g, x + 3, y + 3, 4, 1, on ? led : dim);
      return;
    }
    case 'awaiting_input':
      puts(g, [[0, 0], [1, 0], [2, 0], [2, 1], [1, 2], [2, 2], [1, 4]], led, x + 3, y + 1);
      return;
    case 'completed':
      puts(g, [[0, 3], [1, 4], [2, 3], [3, 2], [4, 1]], led, x + 2, y + 1);
      return;
    case 'failed':
      puts(g, [[0, 0], [1, 1], [2, 2], [3, 3], [4, 4], [4, 0], [3, 1], [1, 3], [0, 4]], led, x + 2, y + 1);
      return;
  }
}

export interface StationSpriteInput {
  type: RobotType;
  status: RobotStatus;
  palette: RobotPalette;
  frame: number;
}

export function renderStation({ type, status, palette, frame }: StationSpriteInput): Grid {
  const f = ((frame % FRAME_COUNT) + FRAME_COUNT) % FRAME_COUNT;
  const off = status === 'disconnected';
  const tone = (c: string) => (off ? powerOff(c) : c);
  const led = off ? '#2a3042' : STATUS_COLOR[status];
  const accent = tone(palette.accent);
  const wood = off ? '#2a2f3d' : darken(palette.primary, 0.55);
  const g = makeGrid(STATION_W, STATION_H);

  // desk
  rect(g, 0, 11, STATION_W, 3, OUTLINE);
  rect(g, 1, 11, STATION_W - 2, 2, wood);
  rect(g, 1, 11, STATION_W - 2, 1, lighten(wood, 0.18));
  rect(g, 2, 14, 3, 2, OUTLINE);
  rect(g, 27, 14, 3, 2, OUTLINE);

  // monitor
  box(g, SCREEN.x - 1, SCREEN.y - 1, SCREEN.w + 2, SCREEN.h + 2, '#2b3247');
  drawScreen(g, status, f, led);
  rect(g, 15, 10, 2, 1, OUTLINE);
  // monitor power LED
  put(g, SCREEN.x + SCREEN.w - 1, SCREEN.y + SCREEN.h, off ? null : led);

  // keyboard
  rect(g, 12, 10, 8, 1, off ? '#1a1f2c' : '#3a4560');

  // side item(s)
  const item = SIDE_ITEM[type];
  stamp(g, item.rows, item.x, item.y, { o: OUTLINE, w: tone(WHITE), A: accent, a: accent, S: off ? '#1a1f2c' : '#2b3247' });
  if (type === 'qa_lead') stamp(g, item.rows, 23, item.y, { o: OUTLINE, w: tone(WHITE), A: accent, a: accent, S: off ? '#1a1f2c' : '#2b3247' });
  return g;
}
