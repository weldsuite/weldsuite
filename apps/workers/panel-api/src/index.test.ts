/**
 * The whole worker (`src/index.ts`): its 404 envelope and the session every
 * `/api/*` request needs. The worker sits behind one catch-all, so the
 * request is answered as the deployed worker answers it (`createTestApp`
 * mounts a router into its own app, which keeps the router's routes and
 * middleware but not its `notFound` handler), and in conformance mode the
 * Rust server gets no test session either (`userId: null`): its own session
 * check answers, as `apiAuth()` does without a bearer token.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { createTestApp } from '@weldsuite/worker-kit/testing';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import type { Database } from '@weldsuite/worker-kit/db';
import worker from './index';

const env = { ENVIRONMENT: 'test' };

let db: Database;

beforeAll(async () => {
  db = (await createPgliteDb()).db;
}, 120_000);

function deployed() {
  const passthrough = new Hono();
  passthrough.all('*', (c) => worker.fetch(c.req.raw, c.env as never));
  return createTestApp('/', passthrough as never, { context: { tenantDb: db, userId: null as never }, env: env as never });
}

describe('panel-api', () => {
  it('answers unknown paths with the JSON error envelope', async () => {
    const res = await deployed().request('/nope');
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: { code: 'NOT_FOUND', message: '/nope not found' } });
  });

  it('requires a bearer token on /api/*', async () => {
    const res = await deployed().request('/api/anything');
    expect(res.status).toBe(401);
  });
});
