/**
 * A stand-in for PostPeer's API (`https://api.postpeer.dev/v1`): profiles,
 * the connect URL, integrations, posts and analytics. It answers by method,
 * URL and body only, never by call order, so the same stub answers both
 * backends in conformance mode (the Rust server's calls reach it through the
 * harness's outbound bridge).
 *
 * Every other URL (the harness's own loopback calls) goes to the real fetch.
 */

import { vi } from 'vitest';

export const POSTPEER = 'https://api.postpeer.dev/v1';

/** The worker env that turns PostPeer on. */
export const POSTPEER_ENV = {
  POSTPEER_API_KEY: 'pp-key',
  POSTPEER_APP_IDS: '{"twitter":"app_tw","linkedin":""}',
  POSTPEER_WEBHOOK_SECRET: 'whsec-test',
};

/** Profiles PostPeer already has: one named after the default test org. */
const PROFILES = [
  { id: 'pp_prof_default', name: 'org_test_default' },
  { id: 'pp_prof_stray', name: 'org_test_default' },
  { id: 'pp_prof_other', name: 'org_someone_else' },
];

/** Integrations per profile. */
const INTEGRATIONS: Record<string, unknown[]> = {
  pp_prof_default: [
    { id: 'int_tw_new', platform: 'twitter', platformUserId: 'tw_1', name: 'Acme on X', username: 'acme', profileId: 'pp_prof_default' },
    { id: 'int_li', platform: 'LinkedIn', platformUserId: 'li_1', username: 'acme-li', avatarUrl: 'https://cdn.test/li.png', profileId: 'pp_prof_default' },
    // Not ours: another profile, or none.
    { id: 'int_foreign', platform: 'twitter', platformUserId: 'tw_9', profileId: 'pp_prof_other' },
    { id: 'int_orphan', platform: 'twitter', platformUserId: 'tw_8', profileId: null },
    // A platform WeldSocial doesn't model.
    { id: 'int_yt', platform: 'youtube', platformUserId: 'yt_1', profileId: 'pp_prof_default' },
  ],
  pp_prof_stray: [{ id: 'int_x2', platform: 'x', platformUserId: 'tw_2', name: 'Second X', profileId: 'pp_prof_stray' }],
};

/** What PostPeer reports per post, by the post's content. */
function createdPost(body: { content?: string; platforms?: Array<{ platform: string; accountId: string }>; publishNow?: boolean }): Response {
  const content = body.content ?? '';
  if (content.includes('[reject]')) return json({ message: 'Invalid media type' }, 422);
  if (content.includes('[boom]')) return json({ error: 'Upstream exploded' }, 500);
  const id = `pp_post_${content.toLowerCase().replaceAll(/[^a-z0-9]+/g, '_').slice(0, 40)}`;
  const platforms = (body.platforms ?? []).map((p, i) => {
    const failed = content.includes('[fail-all]') || (content.includes('[fail-second]') && i === 1);
    return {
      platform: p.platform,
      // The schedule path doesn't echo the account.
      ...(body.publishNow ? { accountId: p.accountId } : {}),
      success: !failed,
      ...(failed ? { error: 'Token expired' } : { platformPostUrl: `https://social.test/${p.accountId}/${i}` }),
    };
  });
  return json({ postId: id, status: body.publishNow ? 'published' : 'scheduled', platforms });
}

const ANALYTICS: Record<string, unknown[]> = {
  pp_post_metrics: [
    { postId: 'remote_1', accountId: 'int_tw', impressions: 1000, reach: 800, likes: 10, comments: 2, shares: 3, saves: 1, clicks: 7, views: 5 },
    { accountId: 'int_li', impressions: 0, engagement: 4 },
    { accountId: 'int_unknown', impressions: 50 },
  ],
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function urlOf(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  return input instanceof URL ? input.href : input.url;
}

/** `GET /connect/<platform>`: the hosted OAuth URL, or PostPeer's refusal. */
function connectUrl(platform: string, url: URL): Response {
  if (platform === 'tiktok') return json({ message: 'Platform not enabled' }, 400);
  return json({ url: `https://connect.postpeer.test/${platform}?${url.searchParams.toString()}` });
}

/** `DELETE /posts/<id>`: gone, stuck, or deleted. */
function deletedPost(id: string): Response {
  if (id.includes('gone')) return json({ message: 'Post not found' }, 404);
  if (id.includes('stuck')) return json({ message: 'Temporarily unavailable' }, 503);
  return new Response(null, { status: 204 });
}

/** The fixed answers, by `METHOD path`. */
const ROUTES: Record<string, (url: URL, body: unknown) => Response> = {
  'GET /profiles': () => json({ profiles: PROFILES }),
  'POST /profiles': (_url, body) => {
    const name = (body as { name?: string }).name ?? '';
    return json({ id: `pp_prof_${name}`, name });
  },
  'GET /connect/integrations': (url) => json({ data: INTEGRATIONS[url.searchParams.get('profileId') ?? ''] ?? [] }),
  'POST /posts': (_url, body) => createdPost(body as never),
  'GET /analytics': (url) => json({ data: ANALYTICS[url.searchParams.get('postId') ?? ''] ?? [] }),
};

function answer(method: string, url: URL, body: unknown): Response {
  const path = url.pathname.replace(/^\/v1/, '');
  const fixed = ROUTES[`${method} ${path}`];
  if (fixed) return fixed(url, body);
  const connect = /^\/connect\/([a-z]+)$/.exec(path);
  if (method === 'GET' && connect) return connectUrl(connect[1]!, url);
  const post = /^\/posts\/(.+)$/.exec(path);
  if (method === 'DELETE' && post) return deletedPost(decodeURIComponent(post[1]!));
  return json({ message: 'Not found' }, 404);
}

/** The fetch stub; install it with `vi.stubGlobal('fetch', stub)`. */
export function createPostPeerFetchStub() {
  const realFetch = globalThis.fetch;
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = urlOf(input);
    if (!url.startsWith(`${POSTPEER}/`)) return realFetch(input, init);
    const method = (init?.method ?? 'GET').toUpperCase();
    const text = typeof init?.body === 'string' ? init.body : '';
    return answer(method, new URL(url), text ? (JSON.parse(text) as unknown) : undefined);
  });
}

/** The PostPeer calls a stub saw since `from`, each once (both backends call it in conformance mode). */
export function postpeerCallsSince(stub: ReturnType<typeof createPostPeerFetchStub>, from: number): string[] {
  const calls = stub.mock.calls
    .slice(from)
    .map(([input, init]) => `${(init?.method ?? 'GET').toUpperCase()} ${urlOf(input).replace(POSTPEER, '')}`)
    .filter((call) => !call.includes('127.0.0.1'));
  return [...new Set(calls)].sort((a, b) => a.localeCompare(b));
}
