/**
 * Google Sheets integration definition (reference integration #2).
 *
 * Auth: shared Google OAuth (see ./google). Actions call the Sheets v4 API.
 * The `new_row` trigger is poll-based (Sheets has no usable push channel) and
 * is driven by a Trigger.dev schedule that diffs against a cursor stored in the
 * connection's `settings`.
 */

import type { IntegrationDef } from '../types';
import { googleAuth, GOOGLE_SCOPES } from './google';

export const googleSheets: IntegrationDef = {
  id: 'google_sheets',
  type: 'google_sheets',
  label: 'Google Sheets',
  description: 'Append and update rows, and start workflows when a new row is added.',
  category: 'productivity',
  icon: 'sheet',
  auth: googleAuth(GOOGLE_SCOPES.sheets),
  actions: [
    {
      id: 'google_sheets.append_row',
      name: 'Append Row',
      description: 'Append a row of values to a sheet.',
      inputs: [
        { key: 'spreadsheetId', label: 'Spreadsheet ID', type: 'string', required: true },
        { key: 'sheetName', label: 'Sheet name', type: 'string', required: false, placeholder: 'Sheet1' },
        { key: 'values', label: 'Row values (array)', type: 'json', required: true, description: 'JSON array of cell values, e.g. ["Jane", "jane@acme.com"]' },
      ],
    },
    {
      id: 'google_sheets.update_row',
      name: 'Update Row',
      description: 'Overwrite the values of a specific range.',
      inputs: [
        { key: 'spreadsheetId', label: 'Spreadsheet ID', type: 'string', required: true },
        { key: 'range', label: 'Range (A1 notation)', type: 'string', required: true, placeholder: 'Sheet1!A2:C2' },
        { key: 'values', label: 'Row values (array)', type: 'json', required: true },
      ],
    },
  ],
  triggers: [
    {
      id: 'google_sheets.new_row',
      name: 'New Row',
      description: 'Triggers when a new row is added to a watched sheet.',
      kind: 'poll',
      outputFields: ['rowNumber', 'values'],
    },
  ],
};
