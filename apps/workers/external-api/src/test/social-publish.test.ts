/**
 * Coverage for POST /v1/social-posts/:id/publish and /schedule.
 *
 * These two routes are the only ones in external-api that delegate to another
 * worker, so the interesting behaviour is at the seam: the local existence
 * check, the payload handed to app-api, and how upstream statuses come back.
 * `fetch` is stubbed throughout — nothing here talks to a real app-api.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { createExternalTestApp } from './harness';
import type { Database } from '../db';
import type { Env } from '../types';

const POST_ID = 'spo_test_publish';

/**
 * Minimal stand-in for the single lookup these routes make
 * (`select().from().where().limit()`), so the suite exercises the proxy seam
 * without a real Postgres. Deliberately not pglite: the DB-backed suites here
 * currently can't build a schema locally (the vector-search migration needs the
 * `vector` extension), and none of the behaviour under test is DB behaviour.
 */
function stubDb(rows: Array<{ id: string }>): Database {
  const chain = {
    select: () => chain,
    from: () => chain,
    where: () => chain,
    limit: async () => rows,
  };
  return chain as unknown as Database;
}

const existingPost = () => stubDb([{ id: POST_ID }]);

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Env with the internal secret present so routes get past the config guard. */
const configuredEnv: Partial<Env> = {
  INTERNAL_API_SECRET: 'test-secret',
  APP_API_INTERNAL_URL: 'https://app-api.test',
};

/** Stub `fetch`, capturing the outbound request for assertions. */
function stubFetch(status: number, body: unknown) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
      });
    }),
  );
  return calls;
}

describe('external-api · social publish/schedule', () => {
  const app = (env: Partial<Env> = configuredEnv, scopes = ['*'], tenantDb: Database = existingPost()) =>
    createExternalTestApp({ scopes, tenantDb, env }).request;

  it('POST /:id/publish → 200 and forwards the upstream payload', async () => {
    const calls = stubFetch(200, { data: { status: 'published', postpeerPostId: 'pp_1' } });

    const res = await app()(`/v1/social-posts/${POST_ID}/publish`, { method: 'POST' });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { status: string; postpeerPostId: string } };
    expect(body.data.status).toBe('published');
    expect(body.data.postpeerPostId).toBe('pp_1');

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://app-api.test/api/internal/social-posts/publish');
    const sent = JSON.parse(String(calls[0]!.init.body)) as Record<string, unknown>;
    // The internal endpoint keys the workspace off the master `workspaces.id`,
    // which is what the API-key session carries.
    expect(sent).toMatchObject({ workspaceId: 'ws_test', postId: POST_ID, actorUserId: 'user_test' });
    expect((calls[0]!.init.headers as Record<string, string>).Authorization).toBe('Bearer test-secret');
  });

  it('POST /:id/schedule → forwards scheduledAt and timezone', async () => {
    const calls = stubFetch(200, { data: { status: 'scheduled', postpeerPostId: 'pp_2' } });

    const res = await app()(`/v1/social-posts/${POST_ID}/schedule`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scheduledAt: '2030-01-01T09:30:00+02:00', timezone: 'Europe/Amsterdam' }),
    });

    expect(res.status).toBe(200);
    expect(calls[0]!.url).toBe('https://app-api.test/api/internal/social-posts/schedule');
    const sent = JSON.parse(String(calls[0]!.init.body)) as Record<string, unknown>;
    expect(sent.scheduledAt).toBe('2030-01-01T09:30:00+02:00');
    expect(sent.timezone).toBe('Europe/Amsterdam');
  });

  it('POST /:id/schedule → 400 on a non-ISO scheduledAt, without calling upstream', async () => {
    const calls = stubFetch(200, { data: {} });

    const res = await app()(`/v1/social-posts/${POST_ID}/schedule`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scheduledAt: 'next tuesday' }),
    });

    expect(res.status).toBe(400);
    expect(calls).toHaveLength(0);
  });

  it('404s an unknown post locally, without calling upstream', async () => {
    const calls = stubFetch(200, { data: {} });

    const res = await app(configuredEnv, ['*'], stubDb([]))('/v1/social-posts/spo_missing/publish', {
      method: 'POST',
    });

    expect(res.status).toBe(404);
    expect(calls).toHaveLength(0);
  });

  it('forwards upstream 409 conflict verbatim', async () => {
    stubFetch(409, { error: { code: 'CONFLICT', message: 'Post is already published' } });

    const res = await app()(`/v1/social-posts/${POST_ID}/publish`, { method: 'POST' });

    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe('CONFLICT');
    expect(body.error.message).toBe('Post is already published');
  });

  it('forwards upstream 402 insufficient credits, including details', async () => {
    stubFetch(402, {
      error: {
        code: 'INSUFFICIENT_CREDITS',
        message: 'Insufficient credits',
        details: { currentBalance: 1, required: 5, shortfall: 4 },
      },
    });

    const res = await app()(`/v1/social-posts/${POST_ID}/publish`, { method: 'POST' });

    expect(res.status).toBe(402);
    const body = (await res.json()) as { error: { code: string; details: { shortfall: number } } };
    expect(body.error.code).toBe('INSUFFICIENT_CREDITS');
    expect(body.error.details.shortfall).toBe(4);
  });

  it('503s when INTERNAL_API_SECRET is unset, without calling upstream', async () => {
    const calls = stubFetch(200, { data: {} });

    const res = await app({})(`/v1/social-posts/${POST_ID}/publish`, { method: 'POST' });

    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('INTERNAL_AUTH_NOT_CONFIGURED');
    expect(calls).toHaveLength(0);
  });

  it('502s when app-api is unreachable', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('connection refused');
      }),
    );

    const res = await app()(`/v1/social-posts/${POST_ID}/publish`, { method: 'POST' });

    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('UPSTREAM_UNAVAILABLE');
  });

  it('403s without the social_posts:write scope', async () => {
    const calls = stubFetch(200, { data: {} });

    const res = await app(configuredEnv, ['social_posts:read'])(
      `/v1/social-posts/${POST_ID}/publish`,
      { method: 'POST' },
    );

    expect(res.status).toBe(403);
    expect(calls).toHaveLength(0);
  });
});
