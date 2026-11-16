import { afterEach, describe, expect, it, vi } from 'vitest';
import { basinEndpoint, basinSql } from './basin';

const config = { token: 'tok', accountId: 'acc1', bucket: 'bucket-a' };

afterEach(() => vi.unstubAllGlobals());

describe('basinSql', () => {
  it('posts the query to the bucket endpoint with the bearer token', async () => {
    const fetchMock = vi.fn(async () => Response.json({ result: { rows: [{ n: 1 }], metrics: { bytes_scanned: 1234 } } }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await basinSql(config, 'SELECT 1');

    expect(result).toEqual({ rows: [{ n: 1 }], bytesScanned: 1234 });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(basinEndpoint(config));
    expect(url).toBe('https://api.sql.cloudflarestorage.com/api/v1/accounts/acc1/r2-sql/query/bucket-a');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer tok');
    expect(JSON.parse(init.body as string)).toEqual({ query: 'SELECT 1' });
  });

  it('answers no rows and no byte count when the API sends neither', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({})));
    expect(await basinSql(config, 'SELECT 1')).toEqual({ rows: [], bytesScanned: null });
  });

  it('throws with the API message on an error status', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('bad query', { status: 400 })));
    await expect(basinSql(config, 'SELECT')).rejects.toThrow('R2 SQL API error 400: bad query');
  });
});
