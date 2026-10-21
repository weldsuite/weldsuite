/**
 * /publish/* authentication, exercised through the real worker (`src/index.ts`).
 *
 * Every publish route takes caller-supplied workspace / room / user ids and
 * pushes the event to whoever is connected there, so a request reaching one
 * without the shared secret would be cross-tenant event injection. The secret is
 * required on every request, whether or not Cloudflare's edge added a
 * `cf-connecting-ip` header, and an unconfigured secret refuses everything.
 */

import { describe, expect, it, vi } from 'vitest';
import { RealtimePublisher } from '@weldsuite/realtime/server';
import worker from './index';

const SECRET = 'realtime-internal-secret';

/** A Durable Object namespace whose stubs record the request they receive. */
function namespace(received: Request[]) {
  return {
    idFromName: (name: string) => name,
    get: () => ({
      fetch: vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        received.push(new Request(input, init));
        return new Response('delivered', { status: 200 });
      }),
    }),
  };
}

function makeEnv(overrides: Record<string, unknown> = {}) {
  const received: Request[] = [];
  const env = {
    WORKSPACE_HUB: namespace(received),
    CONVERSATION_ROOM: namespace(received),
    CHAT_ROOM: namespace(received),
    WHITEBOARD_ROOM: namespace(received),
    DOCUMENT_ROOM: namespace(received),
    SUPPORT_ROOM: namespace(received),
    REALTIME_INTERNAL_SECRET: SECRET,
    ...overrides,
  };
  return { env, received };
}

const PUBLISH_ROUTES: Array<[string, string, unknown]> = [
  ['workspace', '/publish/workspace', { workspaceId: 'org_victim', topic: 'helpdesk', event: 'x', data: {}, userId: 'u' }],
  ['conversation', '/publish/conversation/conv_victim', { type: 'message' }],
  ['chat', '/publish/chat/chan_victim', { type: 'message' }],
  ['whiteboard', '/publish/whiteboard/proj_victim', { type: 'x' }],
  ['document', '/publish/document/doc_victim', { type: 'x' }],
  ['support', '/publish/support/org_victim', { type: 'x' }],
];

const publish = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  new Request(`https://realtime.test${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });

describe.each(PUBLISH_ROUTES)('POST %s publish route', (_name, path, body) => {
  it('refuses a request without the secret, even without cf-connecting-ip', async () => {
    const { env, received } = makeEnv();
    // No cf-connecting-ip and no secret: how a service-binding caller looks.
    const res = await worker.fetch(publish(path, body), env as never);
    expect(res.status).toBe(403);
    expect(received).toHaveLength(0);
  });

  it('refuses a request without the secret when cf-connecting-ip is present', async () => {
    const { env, received } = makeEnv();
    const res = await worker.fetch(publish(path, body, { 'cf-connecting-ip': '203.0.113.7' }), env as never);
    expect(res.status).toBe(403);
    expect(received).toHaveLength(0);
  });

  it('refuses a wrong secret', async () => {
    const { env, received } = makeEnv();
    for (const wrong of ['wrong', `${SECRET}x`, SECRET.slice(0, -1), '']) {
      const res = await worker.fetch(publish(path, body, { 'x-internal-secret': wrong }), env as never);
      expect(res.status, JSON.stringify(wrong)).toBe(403);
    }
    expect(received).toHaveLength(0);
  });

  it('refuses everything when no secret is configured, whatever the caller sends', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    for (const configured of [undefined, '']) {
      const { env, received } = makeEnv({ REALTIME_INTERNAL_SECRET: configured });
      const attempts: Array<Record<string, string>> = [{}, { 'x-internal-secret': '' }, { 'x-internal-secret': 'anything' }];
      for (const headers of attempts) {
        const res = await worker.fetch(publish(path, body, headers), env as never);
        expect(res.status).toBe(403);
      }
      expect(received).toHaveLength(0);
    }
    expect(error).toHaveBeenCalledWith(expect.stringContaining('REALTIME_INTERNAL_SECRET'));
    error.mockRestore();
  });

  it('delivers the event when the secret matches, with or without cf-connecting-ip', async () => {
    const edgeHeaders: Array<Record<string, string>> = [{}, { 'cf-connecting-ip': '203.0.113.7' }];
    for (const edge of edgeHeaders) {
      const { env, received } = makeEnv();
      const res = await worker.fetch(publish(path, body, { 'x-internal-secret': SECRET, ...edge }), env as never);
      expect(res.status).toBe(200);
      expect(received).toHaveLength(1);
    }
  });
});

describe('everything else is unchanged', () => {
  it('keeps /health open', async () => {
    const { env } = makeEnv({ REALTIME_INTERNAL_SECRET: undefined });
    const res = await worker.fetch(new Request('https://realtime.test/health'), env as never);
    expect(res.status).toBe(200);
  });

  it('leaves the WebSocket routes to their own (Clerk / ticket) authentication', async () => {
    const { env } = makeEnv();
    const res = await worker.fetch(new Request('https://realtime.test/ws'), env as never);
    // 426: asks for an upgrade first, never the publish 403.
    expect(res.status).toBe(426);
  });
});

describe('RealtimePublisher against the worker', () => {
  /** A `REALTIME` service binding that dispatches into the real worker. */
  const bindingTo = (env: object) => ({
    fetch: async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> =>
      worker.fetch(new Request(input, init), env as never),
  });

  it('publishes to every room type when it is given the secret', async () => {
    const { env, received } = makeEnv();
    const rt = new RealtimePublisher(bindingTo(env), { internalSecret: SECRET });

    await rt.publish('org_1', 'helpdesk', 'created', { id: 1 }, 'u1');
    await rt.conversationPublish('conv_1', { type: 'message' });
    await rt.chatPublish('chan_1', { type: 'message' });
    await rt.supportPublish('org_1', { type: 'x' });

    expect(received).toHaveLength(4);
  });

  it('is refused, loudly, when it has no secret', async () => {
    const { env, received } = makeEnv();
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const rt = new RealtimePublisher(bindingTo(env), { internalSecret: undefined });

    await expect(rt.publish('org_1', 'helpdesk', 'created', {}, 'u1')).rejects.toThrow(/403/);
    // The room publishes don't throw; the rejection is logged instead of vanishing.
    await rt.chatPublish('chan_1', { type: 'message' });
    expect(error).toHaveBeenCalledWith(expect.stringContaining('403'));
    expect(received).toHaveLength(0);
    error.mockRestore();
  });
});
