/**
 * WeldBoard entity events. A board is also a drive file, so creating,
 * renaming and trashing one emits the matching `file` event as well.
 */
export const BOARDS_ENTITY_EVENTS = {
  /**
   * `updated`: its name or its content changed. Content changes are reported
   * when the board's room checkpoints, not once per edit.
   */
  board: ['created', 'updated', 'deleted'],
  /**
   * A saved version of a board (`board_versions`): `created` when someone
   * names one or a restore saves the board as it was, `updated` when it is
   * renamed.
   */
  board_version: ['created', 'updated'],
} as const;
