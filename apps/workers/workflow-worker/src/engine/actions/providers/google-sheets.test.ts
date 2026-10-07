import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { handleSheetsAppendRow, handleSheetsUpdateRow, __test__ } from './google-sheets';
import { makeActionContext } from '../../../test/ctx';
import { createPgliteDb } from '../../../test/pglite';
import { schema, type Database } from '../../../db';
import { generateId } from '../../../lib/id';
import { NonRetryableStepError } from '../../errors';

const { columnLetterToIndex, indexToColumnLetter, columnMappingToRow } = __test__;

function stubFetch(impl: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const mock = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return impl(url, init);
  });
  vi.stubGlobal('fetch', mock);
  return { mock, calls };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('column letter helpers', () => {
  it('converts letters to indices and back', () => {
    expect(columnLetterToIndex('A')).toBe(0);
    expect(columnLetterToIndex('Z')).toBe(25);
    expect(columnLetterToIndex('AA')).toBe(26);
    expect(indexToColumnLetter(0)).toBe('A');
    expect(indexToColumnLetter(25)).toBe('Z');
    expect(indexToColumnLetter(26)).toBe('AA');
  });

  it('rejects a non-letter column', () => {
    expect(() => columnLetterToIndex('1')).toThrow(NonRetryableStepError);
    expect(() => columnLetterToIndex('A1')).toThrow(NonRetryableStepError);
  });

  it('turns a sparse column mapping into a row, filling gaps with blanks', () => {
    expect(columnMappingToRow({ A: 'Jane', C: 'jane@acme.com' })).toEqual(['Jane', '', 'jane@acme.com']);
  });

  it('rejects an empty or non-object columnMapping', () => {
    expect(() => columnMappingToRow(undefined)).toThrow(NonRetryableStepError);
    expect(() => columnMappingToRow({})).toThrow(NonRetryableStepError);
    expect(() => columnMappingToRow(['a', 'b'])).toThrow(NonRetryableStepError);
  });

  it('accepts a JSON-string columnMapping (same as the raw-JSON step editor fallback)', () => {
    expect(columnMappingToRow('{"A": "x"}')).toEqual(['x']);
  });
});

describe('google_sheets.append_row / update_row (pglite + stubbed Sheets API)', () => {
  let db: Database;

  beforeAll(async () => {
    db = (await createPgliteDb()).db;
    await db.insert(schema.workspaceMembers).values({ id: 'wm_owner_1', userId: 'owner_1' });
    await db.insert(schema.workflowIntegrations).values({
      id: generateId('win'),
      name: 'Google Sheets',
      type: 'google_sheets',
      status: 'connected',
      oauthTokens: { accessToken: 'ya29-test' },
    });
  });

  describe('append_row', () => {
    it('rejects without spreadsheetId or columnMapping before calling Sheets', async () => {
      const { mock } = stubFetch(() => new Response('{}'));
      await expect(
        handleSheetsAppendRow({ columnMapping: { A: 'x' } }, makeActionContext({ db })),
      ).rejects.toThrow(NonRetryableStepError);
      await expect(
        handleSheetsAppendRow({ spreadsheetId: 'sheet1' }, makeActionContext({ db })),
      ).rejects.toThrow(NonRetryableStepError);
      expect(mock).not.toHaveBeenCalled();
    });

    it('appends the row built from columnMapping and returns { ok, updatedRange, updatedRows }', async () => {
      const { calls } = stubFetch(() =>
        new Response(
          JSON.stringify({ updates: { updatedRange: 'Sheet1!A2:B2', updatedRows: 1 } }),
          { status: 200 },
        ),
      );
      const result = await handleSheetsAppendRow(
        { spreadsheetId: 'sheet1', columnMapping: { A: 'Jane', B: 'jane@acme.com' } },
        makeActionContext({ db }),
      );
      expect(result).toEqual({ ok: true, updatedRange: 'Sheet1!A2:B2', updatedRows: 1 });
      expect(decodeURIComponent(calls[0].url)).toContain('/sheet1/values/Sheet1!A1:append');
      const body = JSON.parse(String(calls[0].init?.body));
      expect(body).toEqual({ values: [['Jane', 'jane@acme.com']] });
    });

    it('defaults sheetName to Sheet1', async () => {
      const { calls } = stubFetch(() => new Response(JSON.stringify({}), { status: 200 }));
      await handleSheetsAppendRow(
        { spreadsheetId: 'sheet1', columnMapping: { A: 'x' } },
        makeActionContext({ db }),
      );
      expect(decodeURIComponent(calls[0].url)).toContain('Sheet1!A1');
    });

    it('maps a 404 (bad spreadsheetId) to a non-retryable error', async () => {
      stubFetch(() => new Response(JSON.stringify({ error: { message: 'Requested entity was not found.' } }), { status: 404 }));
      await expect(
        handleSheetsAppendRow({ spreadsheetId: 'missing', columnMapping: { A: 'x' } }, makeActionContext({ db })),
      ).rejects.toThrow(NonRetryableStepError);
    });

    it('maps a 429 to a retryable error', async () => {
      stubFetch(() => new Response(JSON.stringify({ error: { message: 'Rate limit exceeded' } }), { status: 429 }));
      const promise = handleSheetsAppendRow({ spreadsheetId: 'sheet1', columnMapping: { A: 'x' } }, makeActionContext({ db }));
      await expect(promise).rejects.not.toThrow(NonRetryableStepError);
    });

    it('maps a 500 to a retryable error', async () => {
      stubFetch(() => new Response('oops', { status: 500 }));
      const promise = handleSheetsAppendRow({ spreadsheetId: 'sheet1', columnMapping: { A: 'x' } }, makeActionContext({ db }));
      await expect(promise).rejects.not.toThrow(NonRetryableStepError);
    });
  });

  describe('update_row', () => {
    it('rejects without rowNumber or lookupColumn/lookupValue', async () => {
      const { mock } = stubFetch(() => new Response('{}'));
      await expect(
        handleSheetsUpdateRow({ spreadsheetId: 'sheet1', columnMapping: { A: 'x' } }, makeActionContext({ db })),
      ).rejects.toThrow(/rowNumber.*lookupColumn/i);
      expect(mock).not.toHaveBeenCalled();
    });

    it('updates by explicit rowNumber via batchUpdate, one range per column', async () => {
      const { calls } = stubFetch(() =>
        new Response(JSON.stringify({ totalUpdatedCells: 2 }), { status: 200 }),
      );
      const result = await handleSheetsUpdateRow(
        { spreadsheetId: 'sheet1', rowNumber: 5, columnMapping: { A: 'Jane', C: 'Updated' } },
        makeActionContext({ db }),
      );
      expect(result).toEqual({ ok: true, row: 5, updatedCells: 2 });
      expect(calls).toHaveLength(1);
      expect(calls[0].url).toContain(':batchUpdate');
      const body = JSON.parse(String(calls[0].init?.body));
      expect(body).toEqual({
        valueInputOption: 'USER_ENTERED',
        data: [
          { range: 'Sheet1!A5', values: [['Jane']] },
          { range: 'Sheet1!C5', values: [['Updated']] },
        ],
      });
    });

    it('rejects a non-positive or non-integer rowNumber', async () => {
      await expect(
        handleSheetsUpdateRow({ spreadsheetId: 'sheet1', rowNumber: 0, columnMapping: { A: 'x' } }, makeActionContext({ db })),
      ).rejects.toThrow(NonRetryableStepError);
      await expect(
        handleSheetsUpdateRow({ spreadsheetId: 'sheet1', rowNumber: 1.5, columnMapping: { A: 'x' } }, makeActionContext({ db })),
      ).rejects.toThrow(NonRetryableStepError);
    });

    it('resolves the row via lookupColumn/lookupValue first, then updates it', async () => {
      let call = 0;
      const { calls } = stubFetch((url) => {
        call += 1;
        if (call === 1) {
          expect(decodeURIComponent(url)).toContain('Sheet1!B:B');
          return new Response(JSON.stringify({ values: [['header'], ['no'], ['jane@acme.com']] }), { status: 200 });
        }
        return new Response(JSON.stringify({ totalUpdatedCells: 1 }), { status: 200 });
      });

      const result = await handleSheetsUpdateRow(
        { spreadsheetId: 'sheet1', lookupColumn: 'B', lookupValue: 'jane@acme.com', columnMapping: { C: 'Contacted' } },
        makeActionContext({ db }),
      );
      expect(result).toEqual({ ok: true, row: 3, updatedCells: 1 });
      expect(calls).toHaveLength(2);
      const body = JSON.parse(String(calls[1].init?.body));
      expect(body.data).toEqual([{ range: 'Sheet1!C3', values: [['Contacted']] }]);
    });

    it('fails clearly when no row matches the lookup', async () => {
      stubFetch(() => new Response(JSON.stringify({ values: [['no'], ['nope']] }), { status: 200 }));
      await expect(
        handleSheetsUpdateRow(
          { spreadsheetId: 'sheet1', lookupColumn: 'A', lookupValue: 'missing', columnMapping: { B: 'x' } },
          makeActionContext({ db }),
        ),
      ).rejects.toThrow(/No row found/);
    });
  });
});
