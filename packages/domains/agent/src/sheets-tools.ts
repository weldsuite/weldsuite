/**
 * WeldAgent tools for WeldSheets spreadsheets.
 *
 * A sheet lives in its room (sheets-api's SheetRoom Durable Object), not in
 * the tenant DB, so these tools call sheets-api over its `SheetsInternal`
 * service binding (`SHEETS_INTERNAL`). Every call acts for the person the agent
 * works for: it finds, reads and changes only the sheets their WeldDrive
 * access (and project membership) allows, and a write is an edit everyone in
 * the sheet sees at once.
 */

import { z } from 'zod';
import type { PlatformToolDefinition, ToolContext } from './tools';

const cell = z.union([z.string().max(32_767), z.number(), z.boolean(), z.null()]);
const values = z
  .array(z.array(cell).max(200))
  .min(1)
  .max(5_000)
  .describe('Rows of cell values. Text starting with "=" is a formula in English syntax (e.g. "=SUM(B2:B9)"); null clears a cell.');

const findParams = z.object({
  query: z.string().max(255).optional().describe('Part of the spreadsheet name'),
  limit: z.number().int().min(1).max(50).optional(),
});

const createParams = z.object({
  name: z.string().trim().min(1).max(255),
  values: values.optional().describe('Optional starting values, written from A1 of the first tab'),
});

const sheetParam = z.string().min(1).max(255).describe('The spreadsheet id (from find_spreadsheets or create_spreadsheet)');
const tabParam = z.string().max(200).optional().describe('Tab name or id; default the first visible tab');

const tabsParams = z.object({ spreadsheetId: sheetParam });

const readParams = z.object({
  spreadsheetId: sheetParam,
  tab: tabParam,
  range: z.string().max(200).optional().describe('A1 range such as A1:D20 (or Sheet2!A1:B5); default every used cell of the tab, up to 10,000 cells'),
});

const writeParams = z.object({
  spreadsheetId: sheetParam,
  tab: tabParam,
  range: z.string().max(200).optional().describe('Where to start writing: a cell such as B2 (default A1)'),
  values,
});

/** One call to sheets-api's agent routes, as the person the agent works for. */
async function sheetsCall(ctx: ToolContext, path: string, body: unknown): Promise<{ data?: unknown; error?: string }> {
  const binding = ctx.env?.SHEETS_INTERNAL;
  if (!binding) return { error: 'Spreadsheets are not available to agents here' };
  const res = await binding.fetch(`https://sheets-api.internal/internal/agent/${encodeURIComponent(ctx.workspaceId)}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-weld-user': ctx.actorUserId },
    body: JSON.stringify(body),
  });
  const payload = (await res.json().catch(() => null)) as { data?: unknown; error?: { message?: string } } | null;
  if (!res.ok) return { error: payload?.error?.message ?? `The spreadsheet request failed (${res.status})` };
  return { data: payload?.data };
}

const unwrap = (r: { data?: unknown; error?: string }) => (r.error ? { error: r.error } : r.data);

export const SHEET_TOOLS: PlatformToolDefinition[] = [
  {
    id: 'sheets.find',
    name: 'find_spreadsheets',
    description: 'Find WeldSheets spreadsheets by name (the ones the user can open), most recently changed first.',
    requiredPermissions: ['sheets:read'],
    parameters: findParams,
    async execute(ctx, raw) {
      const args = findParams.parse(raw);
      const r = await sheetsCall(ctx, '/sheets/find', args);
      return r.error ? { error: r.error } : { spreadsheets: r.data };
    },
  },
  {
    id: 'sheets.create',
    name: 'create_spreadsheet',
    description: 'Create a new WeldSheets spreadsheet in the user’s My Drive, optionally filled with values from A1.',
    requiredPermissions: ['sheets:create'],
    parameters: createParams,
    async execute(ctx, raw) {
      return unwrap(await sheetsCall(ctx, '/sheets/create', createParams.parse(raw)));
    },
  },
  {
    id: 'sheets.list_tabs',
    name: 'list_spreadsheet_tabs',
    description: 'List the tabs of a spreadsheet and the block of cells each one uses.',
    requiredPermissions: ['sheets:read'],
    parameters: tabsParams,
    async execute(ctx, raw) {
      const args = tabsParams.parse(raw);
      return unwrap(await sheetsCall(ctx, `/sheets/${encodeURIComponent(args.spreadsheetId)}/tabs`, {}));
    },
  },
  {
    id: 'sheets.read_range',
    name: 'read_spreadsheet_range',
    description: 'Read cell values (and formulas) from a spreadsheet range, as rows. Includes edits others are making right now.',
    requiredPermissions: ['sheets:read'],
    parameters: readParams,
    async execute(ctx, raw) {
      const { spreadsheetId, ...range } = readParams.parse(raw);
      return unwrap(await sheetsCall(ctx, `/sheets/${encodeURIComponent(spreadsheetId)}/read`, range));
    },
  },
  {
    id: 'sheets.write_range',
    name: 'write_spreadsheet_range',
    description: 'Write values or formulas into a spreadsheet from a starting cell. Everyone with the sheet open sees the change at once; it can be undone from version history.',
    requiredPermissions: ['sheets:update'],
    parameters: writeParams,
    async execute(ctx, raw) {
      const { spreadsheetId, ...write } = writeParams.parse(raw);
      return unwrap(await sheetsCall(ctx, `/sheets/${encodeURIComponent(spreadsheetId)}/write`, write));
    },
  },
];
