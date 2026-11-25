import { STATUS_COLOR, type RobotStatus } from '@qavo/shared';

/**
 * The colour to use for a status WRITTEN AS TEXT. STATUS_COLOR is also the colour of lights and dots, where a dark grey
 * "powered off" is right, but as text on a dark panel it is unreadable (about 2:1). A disconnected status is therefore
 * written in the muted text colour; every other status colour already reads well (5:1 or better).
 */
export const statusTextColor = (status: RobotStatus): string => (status === 'disconnected' ? 'var(--muted)' : STATUS_COLOR[status]);
