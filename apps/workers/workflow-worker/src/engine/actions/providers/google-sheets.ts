/**
 * Google Sheets outbound actions (`google_sheets.*`).
 *
 * Calls the Sheets v4 values API. Tokens (with refresh) are resolved through
 * the shared integration-token helper.
 */

import type { ActionHandler } from '../../types';
import { getValidIntegrationToken } from './token';

const SHEETS_BASE = 'https://sheets.googleapis.com/v4/spreadsheets';

/** Coerce the `values` input (JSON array, JSON string, or comma list) into a
 *  flat row of cell values. */
function normalizeRow(raw: unknown): unknown[] {
  if (Array.isArray(raw)) return raw;
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (trimmed.startsWith('[')) {
      try {
        const parsed = JSON.parse(trimmed);
        if (Array.isArray(parsed)) return parsed;
      } catch {
        /* fall through to comma split */
      }
    }
    return trimmed.split(',').map((v) => v.trim());
  }
  if (raw == null) return [];
  return [raw];
}

async function sheetsToken(ctx: Parameters<ActionHandler>[1], integrationId: unknown) {
  return getValidIntegrationToken(ctx, {
    type: 'google_sheets',
    integrationId: integrationId ? String(integrationId) : undefined,
  });
}

/** Append a row to the end of a sheet. */
export const handleSheetsAppendRow: ActionHandler = async (inputs, ctx) => {
  const spreadsheetId = String(inputs.spreadsheetId || '');
  if (!spreadsheetId) throw new Error('spreadsheetId is required');
  const sheetName = inputs.sheetName ? String(inputs.sheetName) : 'Sheet1';
  const row = normalizeRow(inputs.values);

  const { accessToken } = await sheetsToken(ctx, inputs.integrationId);
  const range = encodeURIComponent(`${sheetName}!A1`);
  const url = `${SHEETS_BASE}/${spreadsheetId}/values/${range}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`;

  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ values: [row] }),
  });
  if (!res.ok) throw new Error(`Sheets append failed: ${res.status} - ${await res.text()}`);
  const json = (await res.json()) as { updates?: { updatedRange?: string; updatedRows?: number } };
  return { appended: true, updatedRange: json.updates?.updatedRange, updatedRows: json.updates?.updatedRows };
};

/** Overwrite the values of a specific A1 range. */
export const handleSheetsUpdateRow: ActionHandler = async (inputs, ctx) => {
  const spreadsheetId = String(inputs.spreadsheetId || '');
  const range = String(inputs.range || '');
  if (!spreadsheetId) throw new Error('spreadsheetId is required');
  if (!range) throw new Error('range is required');
  const row = normalizeRow(inputs.values);

  const { accessToken } = await sheetsToken(ctx, inputs.integrationId);
  const url = `${SHEETS_BASE}/${spreadsheetId}/values/${encodeURIComponent(range)}?valueInputOption=USER_ENTERED`;

  const res = await fetch(url, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ values: [row] }),
  });
  if (!res.ok) throw new Error(`Sheets update failed: ${res.status} - ${await res.text()}`);
  const json = (await res.json()) as { updatedRange?: string; updatedCells?: number };
  return { updated: true, updatedRange: json.updatedRange, updatedCells: json.updatedCells };
};
