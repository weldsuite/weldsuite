import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';

// Only the fields a test asserts on are captured, never the live db/env handles.
const notified: Array<{ mentionedUserId: unknown; authorUserId: unknown; authorName: unknown }> = [];
vi.mock('@weldsuite/notifications', () => ({
  sendChatMentionNotification: vi.fn(
    async (params: { mentionedUserId: unknown; authorUserId: unknown; authorName: unknown }) => {
      notified.push({
        mentionedUserId: params.mentionedUserId,
        authorUserId: params.authorUserId,
        authorName: params.authorName,
      });
      return 'notif_1';
    },
  ),
}));

const rtCalls: Array<{ method: string; args: unknown[] }> = [];
vi.mock('@weldsuite/realtime/server', () => ({
  RealtimePublisher: class {
    async chatPublish(...args: unknown[]) {
      rtCalls.push({ method: 'chatPublish', args });
    }
    async chatMessage(...args: unknown[]) {
      rtCalls.push({ method: 'chatMessage', args });
    }
    async chatUserMention(...args: unknown[]) {
      rtCalls.push({ method: 'chatUserMention', args });
    }
    async chatUserUnreadUpdate(...args: unknown[]) {
      rtCalls.push({ method: 'chatUserUnreadUpdate', args });
    }
  },
}));

const { postAgentChatMessage, startAgentWorkingIndicator } = await import('./post-agent-message');

const env = { REALTIME: { fetch: async () => new Response('ok') } };
let db: Database;

const ctx = () => ({
  db,
  env,
  orgId: 'org_1',
  channelId: 'chan_agents',
  agentId: 'agt_helper',
  agentName: 'Helper',
  agentIcon: '🤖',
  invokerUserId: 'member_1',
});

const replyTo = {
  messageId: 'msg_ask',
  rootId: 'msg_ask',
  depth: 1,
  authorId: 'member_1',
  authorName: 'Ann',
  authorAvatar: null,
  content: 'Can you summarise the open tickets?',
  hasAttachments: false,
};

beforeAll(async () => {
  db = (await createPgliteDb()).db;
  await db.insert(schema.chatChannels).values({
    id: 'chan_agents',
    name: 'support',
    slug: 'support',
    type: 'private',
  });
  await db.insert(schema.chatChannelMembers).values([
    { id: 'cmb_1', channelId: 'chan_agents', userId: 'member_1', role: 'member' },
    { id: 'cmb_2', channelId: 'chan_agents', userId: 'member_2', role: 'member' },
    { id: 'cmb_agent', channelId: 'chan_agents', userId: 'agt_helper', memberType: 'agent', role: 'member' },
  ]);
}, 60_000);

beforeEach(() => {
  notified.length = 0;
  rtCalls.length = 0;
});

describe('postAgentChatMessage', () => {
  it('quotes the message it answers and pings whoever asked', async () => {
    const message = await postAgentChatMessage(ctx(), {
      content: 'There are 3 open tickets.',
      replyTo,
      notifyUserIds: ['member_1'],
    });

    expect(message.authorType).toBe('agent');
    expect(message.mentions).toEqual(['member_1']);
    expect((message.metadata as { replyTo?: unknown }).replyTo).toEqual(replyTo);

    const published = rtCalls.find((c) => c.method === 'chatMessage');
    expect(published?.args[1]).toMatchObject({ authorType: 'agent', replyTo });

    expect(notified).toEqual([{ mentionedUserId: 'member_1', authorUserId: 'agt_helper', authorName: 'Helper' }]);
    const [asker] = await db
      .select({ count: schema.chatChannelMembers.unreadMentionCount })
      .from(schema.chatChannelMembers)
      .where(eq(schema.chatChannelMembers.id, 'cmb_1'));
    expect(asker.count).toBe(1);
  });

  it('notifies people it mentions, but never someone outside the room', async () => {
    await postAgentChatMessage(ctx(), {
      content: 'Looping in <@member_2> and <@outsider_9>, and asking <@agt_other>.',
    });

    expect(notified.map((n) => n.mentionedUserId)).toEqual(['member_2']);
    expect(rtCalls.filter((c) => c.method === 'chatUserMention')).toHaveLength(1);
  });

  it('sends no notification when the reply is for nobody', async () => {
    await postAgentChatMessage(ctx(), { content: 'Done.' });
    expect(notified).toEqual([]);
  });
});

describe('startAgentWorkingIndicator', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const typing = () =>
    rtCalls
      .filter((c) => c.method === 'chatPublish')
      .map((c) => (c.args[1] as { isTyping: boolean; userId: string }).isTyping);

  it('repeats "working" until stopped, then clears it once', async () => {
    const stop = startAgentWorkingIndicator(env, 'chan_agents', { id: 'agt_helper', name: 'Helper' }, 1000);
    await vi.advanceTimersByTimeAsync(2500);
    expect(typing()).toEqual([true, true, true]);
    expect(rtCalls[0].args[0]).toBe('chan_agents');
    expect(rtCalls[0].args[1]).toMatchObject({ type: 'typing', userId: 'agt_helper', userName: 'Helper' });

    await stop();
    await stop();
    await vi.advanceTimersByTimeAsync(5000);
    expect(typing()).toEqual([true, true, true, false]);
  });

  it('does nothing without a realtime binding', async () => {
    const stop = startAgentWorkingIndicator({}, 'chan_agents', { id: 'agt_helper', name: 'Helper' });
    await vi.advanceTimersByTimeAsync(10_000);
    await stop();
    expect(rtCalls).toEqual([]);
  });
});
