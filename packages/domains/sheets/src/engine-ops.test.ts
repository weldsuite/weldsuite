import { describe, expect, it, vi } from 'vitest';
import { Sheet, Workbook, type WorkbookSnapshot } from '@weldsuite/sheets-engine';
import type { DriveFileRef } from '@weldsuite/core-domain/drive-access';
import type { Env } from './types';
import { checkpoint, sheetEngine, sheetEngineFor, sheetEngineNamespace, type DataTableSource } from './engine-ops';

const refresh = vi.hoisted(() => ({ calls: [] as unknown[][] }));
vi.mock('@weldsuite/worker-kit/db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@weldsuite/worker-kit/db')>()),
  getTenantDbForWorkspace: async (_env: unknown, workspaceId: string) => ({ workspaceId }),
}));
vi.mock('./services/data-sources/refresh', () => ({
  buildRefresh: async (...args: unknown[]) => {
    refresh.calls.push(args);
    return { ok: true, write: { id: 'ds_1', header: ['Name'], rows: [['Acme']] }, rowCount: 1 };
  },
}));

async function gunzip(bytes: Uint8Array): Promise<{ revision: number; workbook: WorkbookSnapshot }> {
  const stream = new Blob([new Uint8Array(bytes)]).stream().pipeThrough(new DecompressionStream('gzip'));
  return JSON.parse(await new Response(stream).text()) as { revision: number; workbook: WorkbookSnapshot };
}

const csv = (text: string) => new TextEncoder().encode(text);
const tabs = (workbook: WorkbookSnapshot) => workbook.sheets.map((s) => s.name);

describe('sheetEngine.newSheet', () => {
  it('starts a workbook with one empty tab', async () => {
    const { workbook, revision } = await gunzip((await sheetEngine.newSheet()).checkpoint);
    expect(revision).toBe(0);
    expect(tabs(workbook)).toEqual(['Sheet1']);
    expect(workbook.sheets[0]!.id).toMatch(/^sh_[0-9a-f]{16}$/);
    expect(tabs((await gunzip((await sheetEngine.newSheet('Budget')).checkpoint)).workbook)).toEqual(['Budget']);
  });

  it('copies another workbook without its connected tables', async () => {
    const source = new Workbook();
    source.sheets.push(new Sheet('sh_a', 'Leads'));
    const json = source.toJSON();
    const copied = { ...json, sheets: json.sheets.map((s) => ({ ...s, dataTables: [{ id: 'ds_1' }] })) };
    const { workbook } = await gunzip((await sheetEngine.newSheet(null, JSON.stringify(copied))).checkpoint);
    expect(tabs(workbook)).toEqual(['Leads']);
    expect(workbook.sheets[0]).not.toHaveProperty('dataTables');
  });
});

describe('sheetEngine.importFile', () => {
  it('reads a CSV into a workbook, in the file’s locale', async () => {
    const result = await sheetEngine.importFile('prices.csv', csv('Item;Price\nTea;2,50\n'), 'nl');
    if (!result.ok) throw new Error(result.message);
    const { workbook } = await gunzip(result.checkpoint);
    expect(tabs(workbook)).toEqual(['prices']);
    expect(workbook.sheets[0]!.cells.length).toBeGreaterThan(0);
    expect((await sheetEngine.importFile('list.csv', csv('a,b\n1,2\n'))).ok).toBe(true);
  });

  it('refuses a file it cannot open, saying why', async () => {
    expect(await sheetEngine.importFile('notes.pdf', csv('%PDF-1.7'))).toEqual({ ok: false, message: 'WeldSheets opens .xlsx, .csv and .tsv files', reason: 'unsupported' });
  });
});

describe('sheetEngine.convertLegacy', () => {
  it('opens an old project sheet with no or unreadable bytes as an empty workbook', async () => {
    const none = await sheetEngine.convertLegacy('Tasks.xlsx', null, 'Tasks');
    if (!none.ok) throw new Error(none.message);
    expect(tabs((await gunzip(none.checkpoint)).workbook)).toEqual(['Tasks']);
    const garbage = await sheetEngine.convertLegacy('Tasks.xlsx', csv('not a zip'), 'Tasks');
    expect(garbage.ok).toBe(true);
  });

  it('refuses one too big to open', async () => {
    const big = csv(`${'1,'.repeat(499)}1\n`.repeat(501));
    expect(await sheetEngine.convertLegacy('Tasks.csv', big, 'Tasks')).toMatchObject({ ok: false, reason: 'too_large' });
  });
});

describe('sheetEngine.exportWorkbook', () => {
  it('writes a stored workbook as an .xlsx file', async () => {
    const source = new Workbook();
    source.sheets.push(new Sheet('sh_a', 'Leads'));
    const bytes = await sheetEngine.exportWorkbook(JSON.stringify(source.toJSON()), 'nl');
    expect(String.fromCharCode(bytes[0]!, bytes[1]!)).toBe('PK');
    expect((await sheetEngine.exportWorkbook(JSON.stringify(source.toJSON()))).length).toBeGreaterThan(0);
  });
});

describe('checkpoint', () => {
  it('writes a new sheet’s checkpoint at revision 0', async () => {
    const workbook = new Workbook().toJSON();
    expect(await gunzip(await checkpoint(workbook))).toEqual({ revision: 0, workbook });
  });
});

describe('sheetEngineFor', () => {
  it('lists a connected table from the workspace’s database', async () => {
    const source = { id: 'ds_1', objectType: 'companies', definition: {}, createdById: 'alice' } as unknown as DataTableSource;
    const file = { id: 'fil_1' } as DriveFileRef;
    const listed = await sheetEngineFor({} as Env).listDataTable('org_1', source, file);
    expect(listed).toMatchObject({ ok: true, rowCount: 1 });
    expect(refresh.calls.at(-1)).toEqual([{ workspaceId: 'org_1' }, source, file]);
  });

  it('is a namespace binding with every engine function', () => {
    const ns = sheetEngineNamespace();
    expect(ns.idFromName('sht_1')).toEqual({ name: 'sht_1' });
    expect(Object.keys(ns.get()).sort()).toEqual(['convertLegacy', 'exportWorkbook', 'importFile', 'listDataTable', 'newSheet']);
  });
});
