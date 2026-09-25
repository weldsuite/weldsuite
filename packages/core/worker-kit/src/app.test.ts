import { describe, expect, it } from 'vitest';
import { createModuleApi } from './app';
import { CORS_MAX_AGE_SECONDS, resolveCorsOrigin } from './cors';

const env = { ENVIRONMENT: 'test' };

describe('createModuleApi', () => {
  it('answers unknown paths with the JSON error envelope', async () => {
    const app = createModuleApi({ service: 'pass-api' });
    const res = await app.request('/api/nope', {}, env);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: { code: 'NOT_FOUND', message: '/api/nope not found' } });
  });

  it('turns thrown errors into a 500 envelope', async () => {
    const app = createModuleApi({ service: 'pass-api' });
    app.get('/boom', () => {
      throw new Error('boom');
    });
    const original = console.error;
    console.error = () => {};
    const res = await app.request('/boom', {}, env);
    console.error = original;
    expect(res.status).toBe(500);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('INTERNAL_ERROR');
  });

  it('sets a request id and caches CORS preflights for first-party origins', async () => {
    const app = createModuleApi({ service: 'pass-api' });
    const res = await app.request(
      '/api/weldpass',
      {
        method: 'OPTIONS',
        headers: {
          Origin: 'https://app.weldsuite.org',
          'Access-Control-Request-Method': 'POST',
        },
      },
      env,
    );
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('https://app.weldsuite.org');
    expect(res.headers.get('Access-Control-Max-Age')).toBe(String(CORS_MAX_AGE_SECONDS));
    expect(res.headers.get('X-Request-Id')).toBeTruthy();
  });

  it('serves robots.txt', async () => {
    const app = createModuleApi({ service: 'pass-api' });
    expect(await (await app.request('/robots.txt', {}, env)).text()).toContain('Disallow: /');
  });
});

describe('resolveCorsOrigin', () => {
  it('echoes first-party and welddesk origins, denies the rest', () => {
    expect(resolveCorsOrigin('http://localhost:3000')).toBe('http://localhost:3000');
    expect(resolveCorsOrigin('https://acme.welddesk.org')).toBe('https://acme.welddesk.org');
    expect(resolveCorsOrigin('https://evil.example.com')).toBeNull();
    expect(resolveCorsOrigin(undefined)).toBeNull();
  });
});
