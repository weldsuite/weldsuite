/**
 * Google Sheets integration definition (reference integration #2; see
 * "Provider pattern" in docs/plans/weldconnect.md).
 *
 * Auth: shared Google OAuth (see ./google). Actions call the Sheets v4 API.
 * The `new_row` trigger is poll-based (Sheets has no usable push channel) and
 * is driven by a Trigger.dev schedule that diffs against a cursor stored in the
 * connection's `settings`. Not unlocked this phase (only the two actions are).
 *
 * `columnMapping` replaces the old flat `values` array (dead scaffolding —
 * never reachable from the editor, so free to redesign): a JSON object keyed
 * by column letter (`{"A": "{{trigger.record.name}}", "B": "..."}`), each
 * value resolved for `{{variables}}` like any other string input. The engine
 * turns it into an ordered row from column A up to the highest key present.
 * `update_row` targets a row either directly (`rowNumber`) or by looking up a
 * value in a column (`lookupColumn` + `lookupValue`) — see
 * `workflow-worker/src/engine/actions/providers/google-sheets.ts`.
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
        { key: 'integrationId', label: 'Connection', type: 'string', description: 'Which connected Google account to use, when more than one is connected.' },
        { key: 'spreadsheetId', label: 'Spreadsheet', type: 'string', required: true },
        { key: 'sheetName', label: 'Sheet', type: 'string', required: false, placeholder: 'Sheet1' },
        { key: 'columnMapping', label: 'Column values', type: 'json', required: true, description: 'JSON object of column letter to value, e.g. {"A": "Jane", "B": "jane@acme.com"}. Values support {{variables}}.' },
      ],
    },
    {
      id: 'google_sheets.update_row',
      name: 'Update Row',
      description: 'Overwrite one row, found by row number or by looking up a column value.',
      inputs: [
        { key: 'integrationId', label: 'Connection', type: 'string', description: 'Which connected Google account to use, when more than one is connected.' },
        { key: 'spreadsheetId', label: 'Spreadsheet', type: 'string', required: true },
        { key: 'sheetName', label: 'Sheet', type: 'string', required: false, placeholder: 'Sheet1' },
        { key: 'rowNumber', label: 'Row number', type: 'number', required: false, description: 'The exact row to update (including the header row in the count). Leave blank to look up the row by a column value instead.' },
        { key: 'lookupColumn', label: 'Lookup column', type: 'string', required: false, placeholder: 'A', description: 'Column letter to search for lookupValue, when rowNumber is blank.' },
        { key: 'lookupValue', label: 'Lookup value', type: 'string', required: false, description: 'The value to find in lookupColumn. The first matching row is updated.' },
        { key: 'columnMapping', label: 'Column values', type: 'json', required: true, description: 'JSON object of column letter to value, e.g. {"C": "Updated"}. Values support {{variables}}.' },
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
