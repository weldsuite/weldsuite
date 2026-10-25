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
  /**
   * A saved version of a spreadsheet (`sheet_versions`): `created` when
   * someone names one or a restore saves the sheet as it was, `updated` when
   * it is renamed.
   */
  sheet_version: ['created', 'updated'],
  /**
   * A connected table of WeldSuite data in a spreadsheet
   * (`sheet_data_sources`): `updated` when its definition or schedule
   * changes. Its refreshes change the sheet, reported as `sheet` updates.
   */
  sheet_data_source: ['created', 'updated', 'deleted'],
} as const;
