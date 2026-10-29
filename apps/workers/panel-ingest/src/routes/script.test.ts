import { describe, expect, it } from 'vitest';
import stubBundle from '../testing/sdk-bundle-stub';
import { call, makeEnv } from '../testing/fakes';

describe('GET /s.js', () => {
  it('serves the SDK bundle as JavaScript, cacheable for an hour', async () => {
    const res = await call(makeEnv(), { method: 'GET', path: '/s.js' });

    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toContain('application/javascript');
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=3600');
    expect(res.headers.get('ETag')).toMatch(/^"[0-9a-f]{32}"$/);
    expect(await res.text()).toBe(stubBundle);
  });

  it('answers 304 to a matching If-None-Match, with the same cache headers', async () => {
    const testEnv = makeEnv();
    const first = await call(testEnv, { method: 'GET', path: '/s.js' });
    const etag = first.headers.get('ETag')!;

    const res = await call(testEnv, { method: 'GET', path: '/s.js', headers: { 'If-None-Match': etag } });

    expect(res.status).toBe(304);
    expect(res.headers.get('ETag')).toBe(etag);
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=3600');
    expect(await res.text()).toBe('');
  });

  it('treats a weak validator, a list and * as matching', async () => {
    const testEnv = makeEnv();
    const etag = (await call(testEnv, { method: 'GET', path: '/s.js' })).headers.get('ETag')!;

    for (const header of [`W/${etag}`, `"other", ${etag}`, '*']) {
      const res = await call(testEnv, { method: 'GET', path: '/s.js', headers: { 'If-None-Match': header } });
      expect(res.status, header).toBe(304);
    }
  });

  it('sends the bundle again when the validator is stale', async () => {
    const res = await call(makeEnv(), { method: 'GET', path: '/s.js', headers: { 'If-None-Match': '"stale"' } });
    expect(res.status).toBe(200);
  });

  it('needs no project, so it never touches KV', async () => {
    const testEnv = makeEnv();
    await call(testEnv, { method: 'GET', path: '/s.js' });
    expect(testEnv.kv.get).not.toHaveBeenCalled();
  });
});
