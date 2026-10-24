/**
 * WeldSheets entity events. A spreadsheet is also a drive file, so creating,
 * renaming and trashing one emits the matching `file` event as well.
 */
export const SHEETS_ENTITY_EVENTS = {
  /**
   * `updated`: its name or its content changed. Content changes are reported
   * when the sheet's room checkpoints the workbook, not once per edit.
   */
  sheet: ['created', 'updated', 'deleted'],
} as const;
