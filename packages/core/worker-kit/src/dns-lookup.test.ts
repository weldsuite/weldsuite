import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { lookupRecord, lookupTxt } from './dns-lookup';

const fetchMock = vi.fn();
const originalFetch = globalThis.fetch;

beforeEach(() => {
  fetchMock.mockReset();
  globalThis.fetch = fetchMock as unknown as typeof fetch;
});

afterAll(() => {
  globalThis.fetch = originalFetch;
});

function dohResponse(answers: Array<{ type: number; data: string; name?: string; TTL?: number }>) {
  return {
    ok: true,
    json: async () => ({
      Status: 0,
      Answer: answers.map((a) => ({
        name: a.name ?? 'example.com.',
        type: a.type,
        TTL: a.TTL ?? 300,
        data: a.data,
      })),
    }),
  } as unknown as Response;
}

describe('lookupRecord', () => {
  it('throws when the DoH endpoint returns a non-ok response', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 500 } as Response);
    await expect(lookupRecord('example.com', 'A')).rejects.toThrow(
      /DNS lookup failed with status 500/,
    );
  });

  it('returns an empty array when DoH responds with no Answer', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ Status: 0 }),
    } as Response);
    expect(await lookupRecord('example.com', 'A')).toEqual([]);
  });

  it('parses A records — strips trailing dots from name', async () => {
    fetchMock.mockResolvedValueOnce(
      dohResponse([{ type: 1, data: '93.184.216.34', name: 'example.com.' }]),
    );
    const records = await lookupRecord('example.com', 'A');
    expect(records).toEqual([
      { name: 'example.com', type: 'A', value: '93.184.216.34', ttl: 300 },
    ]);
  });

  it('parses MX records — splits priority + target, strips trailing dot', async () => {
    fetchMock.mockResolvedValueOnce(
      dohResponse([{ type: 15, data: '10 mail.example.com.' }]),
    );
    const records = await lookupRecord('example.com', 'MX');
    expect(records[0]).toMatchObject({
      type: 'MX',
      value: 'mail.example.com',
      priority: 10,
    });
  });

  it('filters out records whose type does not match the request', async () => {
    fetchMock.mockResolvedValueOnce(
      dohResponse([
        { type: 1, data: '1.2.3.4' }, // A
        { type: 28, data: '::1' }, // AAAA
      ]),
    );
    const a = await lookupRecord('example.com', 'A');
    expect(a).toHaveLength(1);
    expect(a[0]?.value).toBe('1.2.3.4');
  });

  it('parses CNAME records — strips trailing dot from value', async () => {
    fetchMock.mockResolvedValueOnce(
      dohResponse([{ type: 5, data: 'target.example.com.' }]),
    );
    const records = await lookupRecord('www.example.com', 'CNAME');
    expect(records[0]?.value).toBe('target.example.com');
  });
});

describe('lookupTxt', () => {
  it('unwraps the quoted-chunk encoding DoH uses for TXT records', async () => {
    // DoH returns TXT data with each fragment as a quoted string;
    // the parser concatenates the chunks into the canonical value.
    fetchMock.mockResolvedValueOnce(
      dohResponse([{ type: 16, data: '"v=DMARC1; p=reject"' }]),
    );
    const txts = await lookupTxt('_dmarc.example.com');
    expect(txts).toEqual(['v=DMARC1; p=reject']);
  });

  it('joins multi-string TXT records into one string', async () => {
    fetchMock.mockResolvedValueOnce(
      dohResponse([{ type: 16, data: '"part1" "part2"' }]),
    );
    const txts = await lookupTxt('example.com');
    expect(txts).toEqual(['part1part2']);
  });
});

