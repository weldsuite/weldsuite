/**
 * Google Sheets outbound actions (`google_sheets.*`) — see "Provider pattern"
 * in docs/plans/weldconnect.md.
 *
 * Calls the Sheets v4 values API. Tokens (with refresh) are resolved through
 * the shared integration-token helper (./token.ts); errors are classified by
 * ./google-errors.ts, shared with gmail.ts and google-calendar.ts.
 */

import type { ActionHandler } from '../../types';
import { NonRetryableStepError } from '../../errors';
import { getValidIntegrationToken } from './token';
import { throwGoogleApiError } from './google-errors';
import { asText } from '@weldsuite/text';

const SHEETS_BASE = 'https://sheets.googleapis.com/v4/spreadsheets';

/** Column letter ('A', 'B', ..., 'Z', 'AA', ...) -> 0-indexed position. Throws on anything else. */
function columnLetterToIndex(letter: string): number {
  const trimmed = letter.trim().toUpperCase();
  if (!/^[A-Z]+$/.test(trimmed)) throw new NonRetryableStepError(`Invalid column letter: "${letter}"`);
  let index = 0;
  for (const ch of trimmed) index = index * 26 + (ch.charCodeAt(0) - 64);
  return index - 1;
}

/** 0-indexed position -> column letter. */
function indexToColumnLetter(index: number): string {
  let n = index + 1;
  let letters = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    letters = String.fromCharCode(65 + rem) + letters;
    n = Math.floor((n - 1) / 26);
  }
  return letters;
}

function parseColumnMapping(raw: unknown): Record<string, unknown> {
  if (raw == null) throw new NonRetryableStepError('columnMapping is required');
  let obj: unknown = raw;
  if (typeof raw === 'string') {
    try {
      obj = JSON.parse(raw);
    } catch {
      throw new NonRetryableStepError('columnMapping is not valid JSON');
    }
  }
  if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) {
    throw new NonRetryableStepError(
      'columnMapping must be a JSON object of column letter to value, e.g. {"A": "Jane"}',
    );
  }
  const entries = Object.entries(obj as Record<string, unknown>);
  if (entries.length === 0) throw new NonRetryableStepError('columnMapping has no columns');
  return obj as Record<string, unknown>;
}

/** A `{ "A": "...", "C": "..." }` map into an ordered row array (A..highest key), gaps filled with ''. */
function columnMappingToRow(raw: unknown): unknown[] {
  const mapping = parseColumnMapping(raw);
  let maxIndex = -1;
  const byIndex = new Map<number, unknown>();
  for (const [key, value] of Object.entries(mapping)) {
    const index = columnLetterToIndex(key);
    byIndex.set(index, value);
    if (index > maxIndex) maxIndex = index;
  }
  const row: unknown[] = [];
  for (let i = 0; i <= maxIndex; i++) row.push(byIndex.has(i) ? byIndex.get(i) : '');
  return row;
}

async function sheetsToken(ctx: Parameters<ActionHandler>[1], integrationId: unknown) {
  return getValidIntegrationToken(ctx, {
    type: 'google_sheets',
    integrationId: integrationId ? asText(integrationId) : undefined,
  });
}

/** Append a row to the end of a sheet. */
export const handleSheetsAppendRow: ActionHandler = async (inputs, ctx) => {
  const spreadsheetId = asText(inputs.spreadsheetId || '').trim();
  if (!spreadsheetId) throw new NonRetryableStepError('spreadsheetId is required');
  const sheetName = inputs.sheetName ? asText(inputs.sheetName).trim() : 'Sheet1';
  const row = columnMappingToRow(inputs.columnMapping);

  const { accessToken } = await sheetsToken(ctx, inputs.integrationId);
  const range = encodeURIComponent(`${sheetName}!A1`);
  const url = `${SHEETS_BASE}/${encodeURIComponent(spreadsheetId)}/values/${range}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`;

  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ values: [row] }),
  });
  if (!res.ok) await throwGoogleApiError(res, 'Sheets append row');
  const json = (await res.json()) as { updates?: { updatedRange?: string; updatedRows?: number } };
  return { ok: true, updatedRange: json.updates?.updatedRange, updatedRows: json.updates?.updatedRows };
};

/**
 * Resolve the 1-indexed sheet row `update_row` targets: directly via
 * `rowNumber`, or by finding the first row whose `lookupColumn` cell equals
 * `lookupValue`. Exactly one of the two must be supplied.
 */
async function resolveTargetRow(
  accessToken: string,
  spreadsheetId: string,
  sheetName: string,
  inputs: Record<string, unknown>,
): Promise<number> {
  const rowNumberRaw = inputs.rowNumber;
  const hasRowNumber = rowNumberRaw !== undefined && rowNumberRaw !== null && asText(rowNumberRaw).trim() !== '';
  if (hasRowNumber) {
    const n = Number(rowNumberRaw);
    if (!Number.isInteger(n) || n < 1) throw new NonRetryableStepError('rowNumber must be a positive integer');
    return n;
  }

  const lookupColumn = inputs.lookupColumn ? asText(inputs.lookupColumn).trim() : '';
  const lookupValueRaw = inputs.lookupValue;
  const hasLookupValue = lookupValueRaw !== undefined && lookupValueRaw !== null && asText(lookupValueRaw).trim() !== '';
  if (!lookupColumn || !hasLookupValue) {
    throw new NonRetryableStepError('Provide either rowNumber, or both lookupColumn and lookupValue');
  }
  columnLetterToIndex(lookupColumn); // validates the letter, raises a clear error otherwise

  const range = encodeURIComponent(`${sheetName}!${lookupColumn}:${lookupColumn}`);
  const res = await fetch(`${SHEETS_BASE}/${encodeURIComponent(spreadsheetId)}/values/${range}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) await throwGoogleApiError(res, 'Sheets lookup row');
  const json = (await res.json()) as { values?: string[][] };
  const column = json.values ?? [];
  const target = asText(lookupValueRaw).trim();
  const rowIndex = column.findIndex((cell) => asText(cell?.[0] ?? '').trim() === target);
  if (rowIndex === -1) {
    throw new NonRetryableStepError(`No row found where column ${lookupColumn} = "${target}"`);
  }
  return rowIndex + 1; // 1-indexed, and the lookup range itself starts at row 1.
}

/**
 * Overwrite one row, found by row number or by a column lookup. Writes one
 * cell per `columnMapping` entry via `values:batchUpdate` instead of a single
 * contiguous range, so a sparse mapping (e.g. only column C) never clobbers
 * the columns it didn't mention.
 */
export const handleSheetsUpdateRow: ActionHandler = async (inputs, ctx) => {
  const spreadsheetId = asText(inputs.spreadsheetId || '').trim();
  if (!spreadsheetId) throw new NonRetryableStepError('spreadsheetId is required');
  const sheetName = inputs.sheetName ? asText(inputs.sheetName).trim() : 'Sheet1';
  const mapping = parseColumnMapping(inputs.columnMapping);

  const { accessToken } = await sheetsToken(ctx, inputs.integrationId);
  const targetRow = await resolveTargetRow(accessToken, spreadsheetId, sheetName, inputs);

  const data = Object.entries(mapping).map(([column, value]) => {
    columnLetterToIndex(column); // validates
    return { range: `${sheetName}!${column.toUpperCase()}${targetRow}`, values: [[value]] };
  });

  const res = await fetch(`${SHEETS_BASE}/${encodeURIComponent(spreadsheetId)}/values:batchUpdate`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ valueInputOption: 'USER_ENTERED', data }),
  });
  if (!res.ok) await throwGoogleApiError(res, 'Sheets update row');
  const json = (await res.json()) as { totalUpdatedCells?: number; totalUpdatedRows?: number };
  return { ok: true, row: targetRow, updatedCells: json.totalUpdatedCells };
};

// Exported for tests only.
export const __test__ = { columnLetterToIndex, indexToColumnLetter, columnMappingToRow };
