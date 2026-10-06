import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';

// Only the fields a test asserts on are captured — never the full params bag
// (it carries the live `db`/`env` handles, which a deep `toEqual` against
// that array would try to walk).
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

const { postSystemChatMessage } = await import('./post-system-message');

let db: Database;

beforeAll(async () => {
  db = (await createPgliteDb()).db;
  await db.insert(schema.chatChannels).values({
    id: 'chan_1',
    name: 'general',
    slug: 'general',
    type: 'public',
  });
  await db.insert(schema.chatChannelMembers).values([
    { id: 'cmb_1', channelId: 'chan_1', userId: 'member_1', role: 'member' },
    { id: 'cmb_2', channelId: 'chan_1', userId: 'member_2', role: 'member' },
    { id: 'cmb_agent', channelId: 'chan_1', userId: 'agt_1', memberType: 'agent', role: 'member' },
  ]);
}, 60_000);

beforeEach(() => {
  notified.length = 0;
  rtCalls.length = 0;
});

function ctx(env: Record<string, unknown> = { REALTIME: {} }) {
  return {
    db,
    env: env as never,
    orgId: 'org_1',
    channelId: 'chan_1',
    authorId: 'workflow:wf_1',
    authorName: 'Weekly Digest',
    invokerUserId: 'owner_1',
  };
}

describe('postSystemChatMessage', () => {
  it('inserts a system-authored message and bumps the channel denorm fields', async () => {
    const message = await postSystemChatMessage(ctx(), { content: 'Report is ready' });

    expect(message.authorId).toBe('workflow:wf_1');
    expect(message.authorName).toBe('Weekly Digest');
    expect(message.authorType).toBe('system');
    expect(message.content).toBe('Report is ready');

    const [channel] = await db.select().from(schema.chatChannels).where(eq(schema.chatChannels.id, 'chan_1'));
    expect(channel.lastMessagePreview).toBe('Report is ready');
    expect(channel.messageCount).toBeGreaterThan(0);
  });

  it('broadcasts over realtime as authorType system and fans out unread counts to human members only', async () => {
    await postSystemChatMessage(ctx(), { content: 'Hello team' });

    const messageCall = rtCalls.find((c) => c.method === 'chatMessage');
    expect(messageCall?.args[1]).toMatchObject({ senderId: 'workflow:wf_1', authorType: 'system' });

    const unreadCalls = rtCalls.filter((c) => c.method === 'chatUserUnreadUpdate');
    const notifiedUserIds = unreadCalls.map((c) => c.args[1]);
    expect(notifiedUserIds).toEqual(expect.arrayContaining(['member_1', 'member_2']));
    expect(notifiedUserIds).not.toContain('agt_1');
  });

  it('extracts mentions, bumps the mention counter and notifies the mentioned member', async () => {
    await postSystemChatMessage(ctx(), { content: 'Heads up <@member_2>, check this out' });

    const [membership] = await db
      .select()
      .from(schema.chatChannelMembers)
      .where(eq(schema.chatChannelMembers.id, 'cmb_2'));
    expect(membership.unreadMentionCount).toBeGreaterThan(0);

    expect(notified).toEqual([
      expect.objectContaining({ mentionedUserId: 'member_2', authorUserId: 'owner_1', authorName: 'Weekly Digest' }),
    ]);
    expect(rtCalls.some((c) => c.method === 'chatUserMention' && c.args[1] === 'member_2')).toBe(true);
  });

  it('does not notify @everyone, entity tags or agent mentions', async () => {
    await postSystemChatMessage(ctx(), { content: 'FYI <@everyone> <@entity:ticket:tic_1> <@agt_1>' });
    expect(notified).toEqual([]);
  });

  it('still posts the message when REALTIME is not bound', async () => {
    const message = await postSystemChatMessage(ctx({}), { content: 'No realtime here' });
    expect(message.id).toBeTruthy();
    expect(rtCalls).toEqual([]);
  });
});
