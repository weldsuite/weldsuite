import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { app } from './index';
import { NOW, TOKEN, call, makeEnv, resetIsolateState, wireBatch } from './testing/fakes';

describe('panel-ingest', () => {
  beforeEach(() => {
    resetIsolateState();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
  });
  afterEach(() => vi.useRealTimers());

  it('answers the health check', async () => {
    const res = await app.request('/health', {}, { ENVIRONMENT: 'test' });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, service: 'panel-ingest', environment: 'test' });
  });

  it('does not know other paths', async () => {
    const res = await call(makeEnv(), { method: 'GET', path: '/v1/track' });
    expect(res.status).toBe(404);
  });

  describe('CORS', () => {
    it('echoes the requesting origin, without credentials', async () => {
      const res = await call(makeEnv(), { method: 'GET', path: `/c/${TOKEN}`, headers: { Origin: 'https://shop.example.com' } });

      expect(res.headers.get('Access-Control-Allow-Origin')).toBe('https://shop.example.com');
      expect(res.headers.get('Vary')).toContain('Origin');
      expect(res.headers.get('Access-Control-Allow-Credentials')).toBeNull();
    });

    it('answers * to a request without an Origin', async () => {
      const res = await app.request('/health', {}, { ENVIRONMENT: 'test' });
      expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
    });

    it('answers a preflight with 204 and what a batch needs', async () => {
      const res = await call(makeEnv(), {
        method: 'OPTIONS',
        path: '/e',
        headers: {
          Origin: 'https://shop.example.com',
          'Access-Control-Request-Method': 'POST',
          'Access-Control-Request-Headers': 'content-type',
        },
      });

      expect(res.status).toBe(204);
      expect(res.headers.get('Access-Control-Allow-Origin')).toBe('https://shop.example.com');
      expect(res.headers.get('Access-Control-Allow-Methods')).toContain('POST');
      expect(res.headers.get('Access-Control-Allow-Headers')).toBe('Content-Type');
      expect(res.headers.get('Access-Control-Max-Age')).toBe('86400');
    });

    it('is on error answers too, so the browser can read them', async () => {
      const res = await call(makeEnv(), { body: '{nope', headers: { Origin: 'https://shop.example.com' } });

      expect(res.status).toBe(400);
      expect(res.headers.get('Access-Control-Allow-Origin')).toBe('https://shop.example.com');
    });

    it('is on a 500 as well', async () => {
      const testEnv = makeEnv();
      vi.mocked(testEnv.kv.get as unknown as (key: string) => Promise<string | null>).mockRejectedValue(new Error('kv down'));
      const log = vi.spyOn(console, 'error').mockImplementation(() => {});

      const res = await call(testEnv, { body: wireBatch(), headers: { Origin: 'https://shop.example.com' } });

      expect(res.status).toBe(500);
      expect(res.headers.get('Access-Control-Allow-Origin')).toBe('https://shop.example.com');
      expect(await res.json()).toEqual({ error: { code: 'internal_error', message: 'Something went wrong' } });
      log.mockRestore();
    });
  });
});
