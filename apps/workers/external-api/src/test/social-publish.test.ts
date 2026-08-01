/**
 * Coverage for POST /v1/social-posts/:id/publish and /schedule.
 *
 * These routes publish through `@weldsuite/social-publishing` directly. The
 * package's own behaviour (the atomic claim, credit metering, the PostPeer
 * calls) is tested where it lives; what matters here is the route seam — the
 * tenant-scoped existence check, the workspace-id translation, and how the
 * package's errors map onto the v1 error envelope.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { createExternalTestApp } from './harness';
import type { Database } from '../db';
import type { Env } from '../types';

const POST_ID = 'spo_test_publish';
const ORG_ID = 'org_test';

const publishPost = vi.fn();
const resolveClerkOrgId = vi.fn(async () => ORG_ID as string | null);

// Real error classes — the route branches on `instanceof`, so the mock has to
// hand back the genuine constructors.
vi.mock('@weldsuite/social-publishing', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@weldsuite/social-publishing')>();
  return { ...actual, publishPost: (...args: unknown[]) => publishPost(...args) };
});

vi.mock('../lib/social-context', () => ({
  socialContext: () => ({ POSTPEER_API_KEY: 'k', masterDb: () => ({}) }),
  resolveClerkOrgId: (...args: unknown[]) => resolveClerkOrgId(...(args as [])),
}));

const {
  PostPeerNotConfiguredError,
  SocialPublishConflictError,
  SocialInsufficientCreditsError,
} = await import('@weldsuite/social-publishing');

/** Stand-in for the single existence lookup the routes make. */
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
  vi.clearAllMocks();
  resolveClerkOrgId.mockResolvedValue(ORG_ID);
});

describe('external-api · social publish/schedule', () => {
  const app = (scopes = ['*'], tenantDb: Database = existingPost(), env: Partial<Env> = {}) =>
    createExternalTestApp({ scopes, tenantDb, env }).request;

  it('POST /:id/publish → 200, publishing under the workspace\'s Clerk org', async () => {
    publishPost.mockResolvedValue({ postId: POST_ID, status: 'published', postpeerPostId: 'pp_1' });

    const res = await app()(`/v1/social-posts/${POST_ID}/publish`, { method: 'POST' });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { status: string; postpeerPostId: string } };
    expect(body.data.status).toBe('published');
    expect(body.data.postpeerPostId).toBe('pp_1');

    // The session carries the INTERNAL workspace id; the package keys on the
    // Clerk org id, so the route must translate before calling through.
    const [, , orgId, postId, options] = publishPost.mock.calls[0]!;
    expect(orgId).toBe(ORG_ID);
    expect(postId).toBe(POST_ID);
    expect(options).toEqual({ now: true });
  });

  it('POST /:id/schedule → passes scheduledAt and timezone through', async () => {
    publishPost.mockResolvedValue({ postId: POST_ID, status: 'scheduled', postpeerPostId: 'pp_2' });

    const res = await app()(`/v1/social-posts/${POST_ID}/schedule`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scheduledAt: '2030-01-01T09:30:00+02:00', timezone: 'Europe/Amsterdam' }),
    });

    expect(res.status).toBe(200);
    const [, , , , options] = publishPost.mock.calls[0]!;
    expect(options).toEqual({
      now: false,
      scheduledAt: '2030-01-01T09:30:00+02:00',
      timezone: 'Europe/Amsterdam',
    });
  });

  it('POST /:id/schedule → 400 on a non-ISO scheduledAt, without publishing', async () => {
    const res = await app()(`/v1/social-posts/${POST_ID}/schedule`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scheduledAt: 'next tuesday' }),
    });

    expect(res.status).toBe(400);
    expect(publishPost).not.toHaveBeenCalled();
  });

  it('404s an unknown post without publishing', async () => {
    const res = await app(['*'], stubDb([]))('/v1/social-posts/spo_missing/publish', {
      method: 'POST',
    });

    expect(res.status).toBe(404);
    expect(publishPost).not.toHaveBeenCalled();
  });

  it('500s when the workspace has no Clerk org, without publishing', async () => {
    resolveClerkOrgId.mockResolvedValue(null);

    const res = await app()(`/v1/social-posts/${POST_ID}/publish`, { method: 'POST' });

    expect(res.status).toBe(500);
    expect(publishPost).not.toHaveBeenCalled();
  });

  it('maps a publish conflict to 409', async () => {
    publishPost.mockRejectedValue(new SocialPublishConflictError('Post is already published'));

    const res = await app()(`/v1/social-posts/${POST_ID}/publish`, { method: 'POST' });

    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toBe('Post is already published');
  });

  it('maps insufficient credits to 402, including the shortfall', async () => {
    publishPost.mockRejectedValue(new SocialInsufficientCreditsError(1, 5));

    const res = await app()(`/v1/social-posts/${POST_ID}/publish`, { method: 'POST' });

    expect(res.status).toBe(402);
    const body = (await res.json()) as { error: { code: string; details: { shortfall: number } } };
    expect(body.error.code).toBe('INSUFFICIENT_CREDITS');
    expect(body.error.details.shortfall).toBe(4);
  });

  it('maps an unconfigured PostPeer key to 503', async () => {
    publishPost.mockRejectedValue(new PostPeerNotConfiguredError());

    const res = await app()(`/v1/social-posts/${POST_ID}/publish`, { method: 'POST' });

    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('SOCIAL_PUBLISHING_NOT_CONFIGURED');
  });

  it('maps a post with no connected accounts to 400, not 500', async () => {
    publishPost.mockRejectedValue(new Error('No PostPeer-connected accounts among the post targets'));

    const res = await app()(`/v1/social-posts/${POST_ID}/publish`, { method: 'POST' });

    expect(res.status).toBe(400);
  });

  it('403s without the social_posts:write scope', async () => {
    const res = await app(['social_posts:read'])(`/v1/social-posts/${POST_ID}/publish`, {
      method: 'POST',
    });

    expect(res.status).toBe(403);
    expect(publishPost).not.toHaveBeenCalled();
  });
});
