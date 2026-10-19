import { afterEach, describe, expect, it, vi } from 'vitest';
import { NeonDbError } from '@neondatabase/serverless';
import { DrizzleQueryError } from 'drizzle-orm/errors';
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

describe('createModuleApi · a database that moved under the request', () => {
  afterEach(() => vi.restoreAllMocks());

  /** An app whose route throws `err`, as a tenant query would; the Clerk org is set as clerkMiddleware does. */
  function appThatThrows(err: unknown, orgId: string | null = 'org_1') {
    const app = createModuleApi({ service: 'pass-api' });
    app.use('*', async (c, next) => {
      c.set('orgId', orgId);
      await next();
    });
    app.get('/api/things', () => {
      throw err;
    });
    app.post('/api/things', () => {
      throw err;
    });
    return app;
  }

  function kvEnv(del: () => Promise<void> = async () => {}) {
    const kv = { delete: vi.fn(del) };
    return { env: { ENVIRONMENT: 'test', WORKSPACE_CACHE: kv }, kv };
  }

  /** The error neon-http + drizzle produce: the driver error (empty code) under a DrizzleQueryError. */
  const passwordRotated = () =>
    new DrizzleQueryError('select "id" from "things"', [], new NeonDbError(`password authentication failed for user 'tenant_role'`));
  const readOnlySource = () =>
    new DrizzleQueryError(
      'insert into "things" ("name") values ($1)',
      ['x'],
      Object.assign(new NeonDbError('cannot execute INSERT in a read-only transaction'), { code: '25006' }),
    );

  const movingBody = {
    error: {
      code: 'WORKSPACE_MOVING',
      message: 'This workspace is being moved to a new database. Try again in a minute.',
    },
  };

  it('answers a read-only source (25006) with 503 WORKSPACE_MOVING and Retry-After', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { env: e, kv } = kvEnv();
    const res = await appThatThrows(readOnlySource()).request('/api/things', { method: 'POST' }, e);
    expect(res.status).toBe(503);
    expect(res.headers.get('Retry-After')).toBe('30');
    expect(await res.json()).toEqual(movingBody);
    // The URL is still good, so the cached entry stays.
    expect(kv.delete).not.toHaveBeenCalled();
  });

  it('matches the read-only message when the code is empty', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const err = new DrizzleQueryError('update "things" set "name" = $1', ['x'], new NeonDbError('cannot execute UPDATE in a read-only transaction'));
    const res = await appThatThrows(err).request('/api/things', { method: 'POST' }, kvEnv().env);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual(movingBody);
  });

  it('answers a rotated password with 503 WORKSPACE_MOVING and drops the workspace cache entry', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { env: e, kv } = kvEnv();
    const res = await appThatThrows(passwordRotated()).request('/api/things', {}, e);
    expect(res.status).toBe(503);
    expect(res.headers.get('Retry-After')).toBe('30');
    expect(await res.json()).toEqual(movingBody);
    expect(kv.delete).toHaveBeenCalledTimes(1);
    expect(kv.delete).toHaveBeenCalledWith('ws:org_1');
  });

  it('matches SQLSTATE 28P01 on its own', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { env: e, kv } = kvEnv();
    const err = new DrizzleQueryError('select 1', [], Object.assign(new NeonDbError('boom'), { code: '28P01' }));
    const res = await appThatThrows(err).request('/api/things', {}, e);
    expect(res.status).toBe(503);
    expect(kv.delete).toHaveBeenCalledWith('ws:org_1');
  });

  it('skips the cache purge without an org id, and still answers 503', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { env: e, kv } = kvEnv();
    const res = await appThatThrows(passwordRotated(), null).request('/api/things', {}, e);
    expect(res.status).toBe(503);
    expect(kv.delete).not.toHaveBeenCalled();
  });

  it('skips the cache purge without a KV binding, and still answers 503', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const res = await appThatThrows(passwordRotated()).request('/api/things', {}, env);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual(movingBody);
  });

  it('still answers 503 when the cache purge itself fails', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { env: e, kv } = kvEnv(() => Promise.reject(new Error('kv down')));
    const res = await appThatThrows(passwordRotated()).request('/api/things', {}, e);
    expect(res.status).toBe(503);
    expect(kv.delete).toHaveBeenCalled();
  });

  it('does not log the error: its message can carry a connection string', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const err = new Error(
      `password authentication failed for user 'tenant_role' (postgres://tenant_role:s3cret-pass@ep-x.neon.tech/db)`,
    );
    await appThatThrows(err).request('/api/things', {}, kvEnv().env);
    const logged = JSON.stringify([...warn.mock.calls, ...error.mock.calls]);
    expect(logged).not.toContain('s3cret-pass');
    expect(logged).not.toContain('postgres://');
    // One line saying what happened, and for which org.
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('org_1'));
  });

  it('leaves every other error a 500, and the cache alone', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { env: e, kv } = kvEnv();
    const unique = new DrizzleQueryError('insert into "things" ("name") values ($1)', ['x'], Object.assign(new NeonDbError('duplicate key'), { code: '23505' }));
    for (const err of [new Error('boom'), unique]) {
      const res = await appThatThrows(err).request('/api/things', { method: 'POST' }, e);
      expect(res.status).toBe(500);
      expect(res.headers.get('Retry-After')).toBeNull();
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe('INTERNAL_ERROR');
    }
    expect(kv.delete).not.toHaveBeenCalled();
  });

  it('does not take query params for a rotated password', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const err = new DrizzleQueryError(
      'insert into "notes" ("body") values ($1)',
      ['password authentication failed'],
      Object.assign(new NeonDbError('duplicate key value violates unique constraint'), { code: '23505' }),
    );
    const { env: e, kv } = kvEnv();
    const res = await appThatThrows(err).request('/api/things', { method: 'POST' }, e);
    expect(res.status).toBe(500);
    expect(kv.delete).not.toHaveBeenCalled();
  });

  it('exposes Retry-After to browsers, so a client can back off', async () => {
    const app = createModuleApi({ service: 'pass-api' });
    app.get('/api/things', (c) => c.json({ ok: true }));
    const res = await app.request('/api/things', { headers: { Origin: 'https://app.weldsuite.org' } }, env);
    expect(res.headers.get('Access-Control-Expose-Headers')).toContain('Retry-After');
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
