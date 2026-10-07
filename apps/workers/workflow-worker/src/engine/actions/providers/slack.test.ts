import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { handleSlackPostMessage } from './slack';
import { makeActionContext } from '../../../test/ctx';
import { createPgliteDb } from '../../../test/pglite';
import { schema, type Database } from '../../../db';
import { generateId } from '../../../lib/id';
import { NonRetryableStepError } from '../../errors';

function stubFetch(impl: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const mock = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return impl(url, init);
  });
  vi.stubGlobal('fetch', mock);
  return { mock, calls };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('slack.post_message (pglite + stubbed Slack API)', () => {
  let db: Database;

  beforeAll(async () => {
    db = (await createPgliteDb()).db;
    await db.insert(schema.workspaceMembers).values({ id: 'wm_owner_1', userId: 'owner_1' });
    await db.insert(schema.workflowIntegrations).values({
      id: generateId('win'),
      name: 'Team Slack',
      type: 'slack',
      status: 'connected',
      oauthTokens: { accessToken: 'xoxb-test' },
    });
  });

  it('rejects with no channel or text before calling Slack', async () => {
    const { mock } = stubFetch(() => new Response('{}'));
    await expect(handleSlackPostMessage({ text: 'hi' }, makeActionContext({ db }))).rejects.toThrow(
      NonRetryableStepError,
    );
    await expect(handleSlackPostMessage({ channel: 'C1' }, makeActionContext({ db }))).rejects.toThrow(
      NonRetryableStepError,
    );
    expect(mock).not.toHaveBeenCalled();
  });

  it('posts the message and returns { ok, channel, ts, permalink }', async () => {
    const { calls } = stubFetch((url) => {
      if (url.includes('chat.postMessage')) {
        return new Response(JSON.stringify({ ok: true, channel: 'C0123ABC', ts: '1700000000.000100' }), {
          status: 200,
        });
      }
      return new Response(
        JSON.stringify({ ok: true, permalink: 'https://weldsuite.slack.com/archives/C0123ABC/p1700000000000100' }),
        { status: 200 },
      );
    });

    const result = (await handleSlackPostMessage(
      { channel: 'C0123ABC', text: 'The weekly report is ready' },
      makeActionContext({ db }),
    )) as { ok: boolean; channel: string; ts: string; permalink?: string };

    expect(result).toEqual({
      ok: true,
      channel: 'C0123ABC',
      ts: '1700000000.000100',
      permalink: 'https://weldsuite.slack.com/archives/C0123ABC/p1700000000000100',
    });
    expect(calls[0].url).toContain('slack.com/api/chat.postMessage');
    const body = JSON.parse(String(calls[0].init?.body));
    expect(body).toEqual({ channel: 'C0123ABC', text: 'The weekly report is ready' });
    expect(calls[1].url).toContain('chat.getPermalink');
  });

  it('forwards threadTs as thread_ts', async () => {
    const { calls } = stubFetch((url) => {
      if (url.includes('chat.postMessage')) {
        return new Response(JSON.stringify({ ok: true, channel: 'C1', ts: '2.0' }), { status: 200 });
      }
      return new Response(JSON.stringify({ ok: false, error: 'not_found' }), { status: 200 });
    });

    await handleSlackPostMessage(
      { channel: 'C1', text: 'reply', threadTs: '1.0' },
      makeActionContext({ db }),
    );

    const body = JSON.parse(String(calls[0].init?.body));
    expect(body.thread_ts).toBe('1.0');
  });

  it('never fails the step when the permalink lookup errors', async () => {
    const { calls } = stubFetch((url) => {
      if (url.includes('chat.postMessage')) {
        return new Response(JSON.stringify({ ok: true, channel: 'C1', ts: '2.0' }), { status: 200 });
      }
      throw new Error('network blip');
    });

    const result = (await handleSlackPostMessage(
      { channel: 'C1', text: 'hi' },
      makeActionContext({ db }),
    )) as { ok: boolean; permalink?: string };

    expect(result.ok).toBe(true);
    expect(result.permalink).toBeUndefined();
    expect(calls).toHaveLength(2);
  });

  describe('error mapping', () => {
    const nonRetryableCases: Array<[string, RegExp]> = [
      ['channel_not_found', /channel not found/i],
      ['not_in_channel', /invited/i],
      ['invalid_auth', /reconnect/i],
      ['account_inactive', /reconnect/i],
      ['token_revoked', /revoked/i],
    ];

    for (const [code, messageMatch] of nonRetryableCases) {
      it(`maps "${code}" to a clear, non-retryable error`, async () => {
        stubFetch(() => new Response(JSON.stringify({ ok: false, error: code }), { status: 200 }));
        const promise = handleSlackPostMessage({ channel: 'C1', text: 'x' }, makeActionContext({ db }));
        await expect(promise).rejects.toThrow(NonRetryableStepError);
        await expect(promise).rejects.toThrow(messageMatch);
      });
    }

    it('treats an unmapped Slack error code as non-retryable (same as a 4xx)', async () => {
      stubFetch(() => new Response(JSON.stringify({ ok: false, error: 'something_new' }), { status: 200 }));
      await expect(
        handleSlackPostMessage({ channel: 'C1', text: 'x' }, makeActionContext({ db })),
      ).rejects.toThrow(NonRetryableStepError);
    });

    it('treats "ratelimited" in the JSON body as retryable', async () => {
      stubFetch(() => new Response(JSON.stringify({ ok: false, error: 'ratelimited' }), { status: 200 }));
      const promise = handleSlackPostMessage({ channel: 'C1', text: 'x' }, makeActionContext({ db }));
      await expect(promise).rejects.toThrow(/rate-limiting/i);
      await expect(promise).rejects.not.toThrow(NonRetryableStepError);
    });

    it('treats HTTP 429 as retryable and surfaces the Retry-After hint', async () => {
      stubFetch(
        () =>
          new Response(JSON.stringify({ ok: false, error: 'ratelimited' }), {
            status: 429,
            headers: { 'Retry-After': '30' },
          }),
      );
      const promise = handleSlackPostMessage({ channel: 'C1', text: 'x' }, makeActionContext({ db }));
      await expect(promise).rejects.toThrow(/retry after 30s/i);
      await expect(promise).rejects.not.toThrow(NonRetryableStepError);
    });
  });

  describe('owner membership (shared by every provider action via providers/token.ts)', () => {
    it('refuses once the workflow owner has left the workspace', async () => {
      stubFetch(() => new Response(JSON.stringify({ ok: true, channel: 'C1', ts: '1.0' }), { status: 200 }));
      const ctx = makeActionContext({
        db,
        tenant: { workspaceId: 'ws_test', userId: 'user_test', ownerUserId: 'owner_gone' },
      });
      await expect(handleSlackPostMessage({ channel: 'C1', text: 'x' }, ctx)).rejects.toThrow(
        /no longer a member/i,
      );
    });

    it('runs normally when the owner is still a member', async () => {
      stubFetch((url) => {
        if (url.includes('chat.postMessage')) {
          return new Response(JSON.stringify({ ok: true, channel: 'C1', ts: '1.0' }), { status: 200 });
        }
        return new Response(JSON.stringify({ ok: false }), { status: 200 });
      });
      const ctx = makeActionContext({
        db,
        tenant: { workspaceId: 'ws_test', userId: 'user_test', ownerUserId: 'owner_1' },
      });
      const result = (await handleSlackPostMessage({ channel: 'C1', text: 'x' }, ctx)) as { ok: boolean };
      expect(result.ok).toBe(true);
    });

    it('lets runs started before owners were carried through unchanged', async () => {
      stubFetch(() => new Response(JSON.stringify({ ok: true, channel: 'C1', ts: '1.0' }), { status: 200 }));
      // No ownerUserId at all (makeActionContext's default tenant) — same as
      // a run from before WorkflowTenant carried one.
      const result = (await handleSlackPostMessage(
        { channel: 'C1', text: 'x' },
        makeActionContext({ db }),
      )) as { ok: boolean };
      expect(result.ok).toBe(true);
    });
  });
});
