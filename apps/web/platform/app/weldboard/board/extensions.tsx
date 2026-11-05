import type { LiveBoardProps } from './live-board';

/**
 * Panels and controls added to a live board: comments, version history,
 * facilitation, WeldSuite records and AI. Kept apart from LiveBoard so the
 * WeldFlow project page mounts the same board with the same extras.
 */
export function useBoardExtensions(): LiveBoardProps['extend'] {
  return undefined;
}
