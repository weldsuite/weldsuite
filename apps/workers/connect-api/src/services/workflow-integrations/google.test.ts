import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  testGoogleAuth,
  parseSpreadsheetId,
  getGoogleSpreadsheet,
  listGoogleCalendars,
} from './google';

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

describe('testGoogleAuth', () => {
  it('reports success with the account email', async () => {
    stubFetch(() => new Response(JSON.stringify({ email: 'jane@acme.com' }), { status: 200 }));
    const result = await testGoogleAuth('token');
    expect(result).toEqual({ ok: true, message: 'Connected as jane@acme.com' });
  });

  it('reports failure on a non-2xx response', async () => {
    stubFetch(() => new Response('', { status: 401 }));
    const result = await testGoogleAuth('token');
    expect(result).toEqual({ ok: false, message: 'userinfo returned 401' });
  });
});

describe('parseSpreadsheetId', () => {
  it('passes a bare id through unchanged', () => {
    expect(parseSpreadsheetId('abc123')).toBe('abc123');
  });

  it('extracts the id from a full Sheets URL', () => {
    expect(parseSpreadsheetId('https://docs.google.com/spreadsheets/d/abc123/edit#gid=0')).toBe('abc123');
  });

  it('trims surrounding whitespace', () => {
    expect(parseSpreadsheetId('  abc123  ')).toBe('abc123');
  });
});

describe('getGoogleSpreadsheet', () => {
  it('returns the title, url and sheet tabs, skipping tabs with no title', async () => {
    const { calls } = stubFetch(() =>
      new Response(
        JSON.stringify({
          properties: { title: 'Leads' },
          spreadsheetUrl: 'https://docs.google.com/spreadsheets/d/abc123/edit',
          sheets: [{ properties: { sheetId: 0, title: 'Sheet1' } }, { properties: { sheetId: 1 } }],
        }),
        { status: 200 },
      ),
    );
    const info = await getGoogleSpreadsheet('token', 'abc123');
    expect(info).toEqual({
      spreadsheetId: 'abc123',
      title: 'Leads',
      url: 'https://docs.google.com/spreadsheets/d/abc123/edit',
      sheets: [{ sheetId: 0, title: 'Sheet1' }],
    });
    expect(calls[0].url).toContain('/spreadsheets/abc123?');
  });

  it('throws when the Sheets API responds with an error', async () => {
    stubFetch(() => new Response('not found', { status: 404 }));
    await expect(getGoogleSpreadsheet('token', 'missing')).rejects.toThrow(/404/);
  });
});

describe('listGoogleCalendars', () => {
  it('paginates through nextPageToken and caps at MAX_CALENDARS pages', async () => {
    let call = 0;
    const { calls } = stubFetch(() => {
      call += 1;
      if (call === 1) {
        return new Response(
          JSON.stringify({ items: [{ id: 'primary', summary: 'Jane', primary: true, accessRole: 'owner' }], nextPageToken: 'p2' }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({ items: [{ id: 'team@acme.com', accessRole: 'writer' }] }), { status: 200 });
    });
    const calendars = await listGoogleCalendars('token');
    expect(calendars).toEqual([
      { id: 'primary', summary: 'Jane', primary: true, accessRole: 'owner' },
      { id: 'team@acme.com', summary: 'team@acme.com', primary: false, accessRole: 'writer' },
    ]);
    expect(calls).toHaveLength(2);
    expect(calls[0].url).toContain('minAccessRole=writer');
  });

  it('throws when the Calendar API responds with an error', async () => {
    stubFetch(() => new Response('forbidden', { status: 403 }));
    await expect(listGoogleCalendars('token')).rejects.toThrow(/403/);
  });
});
