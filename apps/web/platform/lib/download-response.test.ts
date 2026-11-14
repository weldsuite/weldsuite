import { afterEach, describe, expect, it, vi } from 'vitest';

const saved = vi.hoisted(() => ({ calls: [] as Array<{ blob: Blob; name: string }> }));
vi.mock('@/lib/weldbooks/download', () => ({
  downloadBlob: (blob: Blob, name: string) => saved.calls.push({ blob, name }),
}));

import { fileNameFromResponse, saveResponseAsFile } from './download-response';

const csv = (headers: Record<string, string> = {}) => new Response('a,b\n1,2\n', { headers });

afterEach(() => {
  saved.calls = [];
});

describe('fileNameFromResponse', () => {
  it('reads the quoted name of a Content-Disposition header', () => {
    expect(
      fileNameFromResponse(
        csv({ 'content-disposition': 'attachment; filename="welddesk-overview-last_7_days-2026-11-09.csv"' }),
        'fallback.csv',
      ),
    ).toBe('welddesk-overview-last_7_days-2026-11-09.csv');
  });

  it('falls back when the header is missing, as it is when the API does not expose it cross-origin', () => {
    expect(fileNameFromResponse(csv(), 'fallback.csv')).toBe('fallback.csv');
  });
});

describe('saveResponseAsFile', () => {
  it('saves the body under the header name', async () => {
    const name = await saveResponseAsFile(csv({ 'content-disposition': 'attachment; filename="r.csv"' }), 'fallback.csv');
    expect(name).toBe('r.csv');
    expect(saved.calls).toHaveLength(1);
    expect(saved.calls[0]!.name).toBe('r.csv');
    expect(await saved.calls[0]!.blob.text()).toBe('a,b\n1,2\n');
  });

  it('saves under the fallback when there is no header', async () => {
    expect(await saveResponseAsFile(csv(), 'fallback.csv')).toBe('fallback.csv');
  });
});
