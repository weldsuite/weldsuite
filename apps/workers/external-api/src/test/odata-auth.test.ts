/**
 * Key extraction for the OData feed: HTTP Basic (the password is the API key)
 * is read on `/v1/odata` only, and a missing or bad key there answers 401 with
 * a Basic challenge so Power BI prompts. Everything else keeps Bearer and
 * `X-Api-Key`.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { authMiddleware, extractApiKey, isODataPath } from '../middleware/auth';
import type { HonoEnv } from '../types';

const basic = (user: string, password: string) =>
  `Basic ${btoa(String.fromCharCode(...new TextEncoder().encode(`${user}:${password}`)))}`;

function ctx(path: string, headers: Record<string, string>) {
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return { req: { path, header: (name: string) => lower[name.toLowerCase()] } };
}

const KEY = 'wsk_0123456789abcdef';

describe('extractApiKey', () => {
  it('still reads Bearer and X-Api-Key everywhere, including the feed', () => {
    for (const path of ['/v1/people', '/v1/odata', '/v1/odata/Conversations']) {
      expect(extractApiKey(ctx(path, { Authorization: `Bearer ${KEY}` }))).toBe(KEY);
      expect(extractApiKey(ctx(path, { 'X-Api-Key': KEY }))).toBe(KEY);
    }
    expect(extractApiKey(ctx('/v1/people', { Authorization: 'Bearer nope' }))).toBeNull();
    expect(extractApiKey(ctx('/v1/people', {}))).toBeNull();
  });

  it('reads the Basic password as the key on the feed, whatever the username', () => {
    for (const path of ['/v1/odata', '/v1/odata/', '/v1/odata/$metadata', '/v1/odata/Conversations']) {
      expect(extractApiKey(ctx(path, { Authorization: basic('anything', KEY) })), path).toBe(KEY);
    }
    expect(extractApiKey(ctx('/v1/odata', { Authorization: basic('', KEY) }))).toBe(KEY);
    expect(extractApiKey(ctx('/v1/odata', { Authorization: basic('Jan Müller', KEY) }))).toBe(KEY);
    // only the first colon splits user from password
    expect(extractApiKey(ctx('/v1/odata', { Authorization: basic('a:b', KEY) }))).toBeNull();
    expect(extractApiKey(ctx('/v1/odata', { Authorization: basic('a', `${KEY}:x`) }))).toBe(`${KEY}:x`);
    expect(extractApiKey(ctx('/v1/odata', { Authorization: basic('u', 'wsat_abc123') }))).toBe('wsat_abc123');
  });

  it('refuses Basic anywhere else, and lookalike paths', () => {
    for (const path of ['/v1/people', '/v1/audit-logs', '/v1', '/v1/odatax', '/v1/odata-evil', '/v2/odata', '/odata', '/v1/people/odata']) {
      expect(extractApiKey(ctx(path, { Authorization: basic('u', KEY) })), path).toBeNull();
      expect(isODataPath(path), path).toBe(false);
    }
    expect(isODataPath('/v1/odata')).toBe(true);
    expect(isODataPath('/v1/odata/Teams')).toBe(true);
  });

  it('refuses a Basic credential that is not a wsk_ key or is malformed', () => {
    for (const header of [
      basic('u', 'password'),
      basic('u', ''),
      basic('u', `x${KEY}`),
      `Basic ${btoa('no-colon-here')}`,
      'Basic !!!not-base64!!!',
      'Basic ',
      'Basic',
      `basic ${btoa(`u:${KEY}`)}`,
      `Digest ${KEY}`,
    ]) {
      expect(extractApiKey(ctx('/v1/odata', { Authorization: header })), header).toBeNull();
    }
  });
});

describe('authMiddleware on the feed', () => {
  afterEach(() => vi.restoreAllMocks());

  const app = new Hono<HonoEnv>();
  app.use('/v1/*', authMiddleware);
  app.get('/v1/*', (c) => c.text('reached'));
  // A cache that fails reads as "key not found": no database is needed to see the 401.
  const env = {
    API_CACHE: { get: () => Promise.reject(new Error('no cache')) },
    HYPERDRIVE_MASTER: { connectionString: 'postgres://u:p@127.0.0.1:1/db' },
    NEON_API_KEY: 'x',
  };
  const call = (path: string, headers: Record<string, string> = {}) => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    return app.request(path, { headers }, env);
  };

  it('challenges with Basic when there is no key', async () => {
    const res = await call('/v1/odata/Conversations');
    expect(res.status).toBe(401);
    expect(res.headers.get('WWW-Authenticate')).toBe('Basic realm="WeldSuite"');
    expect(await res.json()).toMatchObject({ error: { code: 'UNAUTHORIZED' } });
    expect((await call('/v1/odata')).headers.get('WWW-Authenticate')).toBe('Basic realm="WeldSuite"');
  });

  it('challenges when the key (Basic or header) is wrong', async () => {
    const attempts: Record<string, string>[] = [{ Authorization: basic('u', KEY) }, { 'X-Api-Key': KEY }, { Authorization: basic('u', 'nope') }];
    for (const headers of attempts) {
      const res = await call('/v1/odata/Teams', headers);
      expect(res.status).toBe(401);
      expect(res.headers.get('WWW-Authenticate')).toBe('Basic realm="WeldSuite"');
    }
  });

  it('does not challenge, nor read Basic, outside the feed', async () => {
    const attempts: Record<string, string>[] = [{}, { Authorization: basic('u', KEY) }];
    for (const headers of attempts) {
      const res = await call('/v1/audit-logs', headers);
      expect(res.status).toBe(401);
      expect(res.headers.get('WWW-Authenticate')).toBeNull();
    }
  });
});
