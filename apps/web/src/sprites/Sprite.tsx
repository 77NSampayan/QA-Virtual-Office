import { useEffect, useRef } from 'react';
import { STATUS_ANIMATION, STATUS_LABEL, type RobotPalette, type RobotStatus, type RobotType } from '@qavo/shared';
import { drawGrid } from './draw.ts';
import { DRONE_H, DRONE_W, renderDrone } from './drone.ts';
import type { Grid } from './grid.ts';
import { NOOK_H, NOOK_LABEL, NOOK_W, renderNookBack, renderNookFront, type NookKind } from './nook.ts';
import { renderRobot, ROBOT_H, ROBOT_W } from './robot.ts';
import { renderStation, STATION_H, STATION_W } from './station.ts';
import { useFrame } from './ticker.ts';

interface CanvasProps {
  grid: Grid;
  w: number;
  h: number;
  scale: number;
  className?: string;
  label: string;
  data: Record<string, string | number>;
}

function PixelCanvas({ grid, w, h, scale, className, label, data }: CanvasProps) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const ctx = ref.current?.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, w * scale, h * scale);
    drawGrid(ctx, grid, scale);
  }, [grid, w, h, scale]);
  const dataAttrs = Object.fromEntries(Object.entries(data).map(([k, v]) => [`data-${k}`, v]));
  return <canvas ref={ref} width={w * scale} height={h * scale} className={`sprite ${className ?? ''}`} role="img" aria-label={label} {...dataAttrs} />;
}

interface RobotProps {
  type: RobotType;
  status: RobotStatus;
  palette: RobotPalette;
  scale?: number;
  className?: string;
  /** Freeze on one frame (static previews). */
  frame?: number;
}

export function RobotSprite({ type, status, palette, scale = 4, className, frame }: RobotProps) {
  const tick = useFrame();
  const f = frame ?? tick;
  return (
    <PixelCanvas
      grid={renderRobot({ type, status, palette, frame: f })}
      w={ROBOT_W}
      h={ROBOT_H}
      scale={scale}
      className={`robot ${className ?? ''}`}
      label={`${STATUS_LABEL[status]} robot (${STATUS_ANIMATION[status]})`}
      data={{ kind: 'robot', status, type, frame: f }}
    />
  );
}

export function StationSprite({ type, status, palette, scale = 4, className, frame }: RobotProps) {
  const tick = useFrame();
  const f = frame ?? tick;
  return (
    <PixelCanvas
      grid={renderStation({ type, status, palette, frame: f })}
      w={STATION_W}
      h={STATION_H}
      scale={scale}
      className={`station ${className ?? ''}`}
      label="Workstation"
      data={{ kind: 'station', status, type, frame: f }}
    />
  );
}

export function DroneSprite({ status, scale = 3, className }: { status: RobotStatus; scale?: number; className?: string }) {
  const f = useFrame();
  return (
    <PixelCanvas
      grid={renderDrone({ status, frame: f })}
      w={DRONE_W}
      h={DRONE_H}
      scale={scale}
      className={`drone ${className ?? ''}`}
      label="Subagent drone"
      data={{ kind: 'drone', status, frame: f }}
    />
  );
}

interface NookProps {
  kind: NookKind;
  palette: RobotPalette;
  scale?: number;
  /** Which layer: BACK sits behind the robot, FRONT over its lower body. */
  layer: 'back' | 'front';
  frame?: number;
}

/** A lounge furniture layer (couch, coffee corner, arcade). The animation frame moves the furniture only. */
export function NookSprite({ kind, palette, scale = 4, layer, frame }: NookProps) {
  const tick = useFrame();
  const f = frame ?? tick;
  const input = { kind, palette, frame: f };
  return (
    <PixelCanvas
      grid={layer === 'back' ? renderNookBack(input) : renderNookFront(input)}
      w={NOOK_W}
      h={NOOK_H}
      scale={scale}
      className={`nook nook-${layer}`}
      label={`${NOOK_LABEL[kind]} (lounge)`}
      data={{ kind: 'nook', nook: kind, layer, frame: f }}
    />
  );
}
