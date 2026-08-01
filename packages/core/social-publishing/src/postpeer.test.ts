/**
 * Unit tests for the PostPeer client + webhook signature verifier.
 * Pure (no DB): the client is exercised against a mocked fetch.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  PostPeerClient,
  verifyPostPeerSignature,
  getPostPeerClient,
  getPostPeerAppId,
  toPostPeerSchedule,
} from './postpeer';

function mockFetchOnce(status: number, body: unknown) {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  });
}

async function hmacHex(secret: string, body: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const buf = await crypto.subtle.sign('HMAC', key, enc.encode(body));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('PostPeerClient', () => {
  it('sends the x-access-key header and posts JSON', async () => {
    const fetchMock = mockFetchOnce(200, { postId: 'p1', status: 'published', platforms: [] });
    vi.stubGlobal('fetch', fetchMock);

    const client = new PostPeerClient({ apiKey: 'key_123' });
    const res = await client.createPost({ content: 'hi', platforms: [{ platform: 'twitter', accountId: 'i1' }], publishNow: true });

    expect(res.postId).toBe('p1');
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe('https://api.postpeer.dev/v1/posts');
    expect(init.method).toBe('POST');
    expect(init.headers['x-access-key']).toBe('key_123');
    expect(JSON.parse(init.body).publishNow).toBe(true);
  });

  // PostPeer validates the body with `additionalProperties: false`, so an
  // unknown key is a hard 400 ("body must NOT have additional properties"),
  // not a silently ignored field. Pin the exact wire names.
  it('sends the schedule as scheduledFor + timezone, never scheduledAt', async () => {
    const fetchMock = mockFetchOnce(200, { postId: 'p2', status: 'scheduled', platforms: [] });
    vi.stubGlobal('fetch', fetchMock);

    const client = new PostPeerClient({ apiKey: 'k' });
    await client.createPost({
      content: 'later',
      platforms: [{ platform: 'twitter', accountId: 'i1' }],
      ...toPostPeerSchedule('2030-01-01T09:30:00.000Z'),
    });

    const body = JSON.parse(fetchMock.mock.calls[0]![1].body);
    expect(body.scheduledFor).toBe('2030-01-01T09:30:00');
    expect(body.timezone).toBe('UTC');
    expect(body).not.toHaveProperty('scheduledAt');
  });

  it('builds query params for analytics and unwraps array/data shapes', async () => {
    const fetchMock = mockFetchOnce(200, { data: [{ postId: 'p1', likes: 5 }] });
    vi.stubGlobal('fetch', fetchMock);

    const client = new PostPeerClient({ apiKey: 'k', baseUrl: 'https://api.postpeer.dev/v1/' });
    const res = await client.getAnalytics({ postId: 'p1' });

    expect(res).toEqual([{ postId: 'p1', likes: 5 }]);
    expect(String(fetchMock.mock.calls[0]![0])).toBe('https://api.postpeer.dev/v1/analytics?postId=p1');
  });

  it('throws PostPeerError on non-2xx', async () => {
    vi.stubGlobal('fetch', mockFetchOnce(401, { message: 'bad key' }));
    const client = new PostPeerClient({ apiKey: 'k' });
    await expect(client.healthCheck()).rejects.toThrow('bad key');
  });
});

describe('toPostPeerSchedule', () => {
  it('normalises an instant to a naive UTC wall clock', () => {
    expect(toPostPeerSchedule('2030-06-01T14:00:00.000Z')).toEqual({
      scheduledFor: '2030-06-01T14:00:00',
      timezone: 'UTC',
    });
  });

  // An offset instant must keep the SAME moment — shifting it here would
  // publish at the wrong time.
  it('converts an offset instant to the equivalent UTC wall clock', () => {
    expect(toPostPeerSchedule('2030-06-01T16:00:00+02:00')).toEqual({
      scheduledFor: '2030-06-01T14:00:00',
      timezone: 'UTC',
    });
  });

  it('throws on an unparseable time rather than sending garbage upstream', () => {
    expect(() => toPostPeerSchedule('not a date')).toThrow(/Invalid scheduled time/);
  });

  // `new Date('2030-06-01T14:00:00')` resolves in the RUNTIME's zone, so a
  // timezone-less string denotes a different instant per host. Reject it rather
  // than let the schedule silently depend on where the worker runs.
  it('rejects a timestamp with no explicit UTC offset', () => {
    expect(() => toPostPeerSchedule('2030-06-01T14:00:00')).toThrow(/explicit UTC offset/);
    expect(() => toPostPeerSchedule('2030-06-01')).toThrow(/explicit UTC offset/);
  });

  it('accepts the offset forms our APIs emit', () => {
    expect(() => toPostPeerSchedule('2030-06-01T14:00:00Z')).not.toThrow();
    expect(() => toPostPeerSchedule('2030-06-01T14:00:00.000Z')).not.toThrow();
    expect(() => toPostPeerSchedule('2030-06-01T16:00:00+02:00')).not.toThrow();
    expect(() => toPostPeerSchedule('2030-06-01T16:00:00-0500')).not.toThrow();
  });
});

describe('getPostPeerClient', () => {
  it('returns null when no key configured', () => {
    expect(getPostPeerClient({})).toBeNull();
  });
  it('returns a client when key present', () => {
    expect(getPostPeerClient({ POSTPEER_API_KEY: 'k' })).toBeInstanceOf(PostPeerClient);
  });
});

describe('getConnectUrl · BYOK appId', () => {
  /** Grab the URL the client actually requested. */
  async function connectUrlFor(appId?: string): Promise<URL> {
    const fetchMock = mockFetchOnce(200, { url: 'https://connect.example/x' });
    vi.stubGlobal('fetch', fetchMock);
    const client = new PostPeerClient({ apiKey: 'k' });
    await client.getConnectUrl('twitter', 'prof_1', undefined, appId);
    return new URL(fetchMock.mock.calls[0]![0] as string);
  }

  it('sends appId when one is supplied', async () => {
    const url = await connectUrlFor('app_123');
    expect(url.pathname).toBe('/v1/connect/twitter');
    expect(url.searchParams.get('profileId')).toBe('prof_1');
    expect(url.searchParams.get('appId')).toBe('app_123');
  });

  it('omits appId entirely when none is supplied, so PostPeer uses its system app', async () => {
    const url = await connectUrlFor(undefined);
    expect(url.searchParams.has('appId')).toBe(false);
  });
});

describe('getPostPeerAppId', () => {
  it('returns the id mapped to the platform', () => {
    const env = { POSTPEER_APP_IDS: '{"twitter":"app_123","linkedin":"app_456"}' };
    expect(getPostPeerAppId(env, 'twitter')).toBe('app_123');
    expect(getPostPeerAppId(env, 'linkedin')).toBe('app_456');
  });

  it('returns undefined for a platform not in the map, so it keeps the system app', () => {
    expect(getPostPeerAppId({ POSTPEER_APP_IDS: '{"twitter":"app_123"}' }, 'tiktok')).toBeUndefined();
  });

  it('returns undefined when unset', () => {
    expect(getPostPeerAppId({}, 'twitter')).toBeUndefined();
  });

  // Malformed config must not take the connect flow down — it falls back to the
  // previous behaviour and logs loudly.
  it('falls back and logs on invalid JSON', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(getPostPeerAppId({ POSTPEER_APP_IDS: 'not json' }, 'twitter')).toBeUndefined();
    expect(err).toHaveBeenCalled();
  });

  it('falls back and logs when the JSON is not an object', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(getPostPeerAppId({ POSTPEER_APP_IDS: '["app_123"]' }, 'twitter')).toBeUndefined();
    expect(err).toHaveBeenCalled();
  });

  it('falls back and logs when the mapped value is not a non-empty string', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(getPostPeerAppId({ POSTPEER_APP_IDS: '{"twitter":""}' }, 'twitter')).toBeUndefined();
    expect(getPostPeerAppId({ POSTPEER_APP_IDS: '{"twitter":123}' }, 'twitter')).toBeUndefined();
    expect(err).toHaveBeenCalledTimes(2);
  });
});

describe('verifyPostPeerSignature', () => {
  const body = JSON.stringify({ event: 'post.published', data: { postId: 'p1' } });

  it('accepts a valid signature (bare hex)', async () => {
    const sig = await hmacHex('whsec', body);
    expect(await verifyPostPeerSignature('whsec', body, sig)).toBe(true);
  });

  it('accepts a sha256= prefixed signature', async () => {
    const sig = await hmacHex('whsec', body);
    expect(await verifyPostPeerSignature('whsec', body, `sha256=${sig}`)).toBe(true);
  });

  it('rejects a tampered signature', async () => {
    const sig = await hmacHex('whsec', body);
    const bad = sig.slice(0, -1) + (sig.endsWith('a') ? 'b' : 'a');
    expect(await verifyPostPeerSignature('whsec', body, bad)).toBe(false);
  });

  it('rejects when signature header is missing but a secret is set', async () => {
    expect(await verifyPostPeerSignature('whsec', body, null)).toBe(false);
  });

  it('fails closed (returns false) when no secret configured', async () => {
    expect(await verifyPostPeerSignature('whsec', body, null)).toBe(false);
    // No secret → reject rather than accept, since the endpoint is public.
    expect(await verifyPostPeerSignature(undefined, body, 'anything')).toBe(false);
  });
});
