/**
 * What a send hands to the realtime fan-out and the mention notification:
 * attachments ride along in the live `message` event, and previews read
 * "@Name" instead of the raw `<@userId>` token.
 */

import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';

const rtCalls: Array<{ method: string; args: unknown[] }> = [];
vi.mock('@weldsuite/realtime/server', () => ({
  RealtimePublisher: class {
    constructor() {
      // Record every publish, whatever the method.
      return new Proxy(this, {
        get: (_target, method) => (...args: unknown[]) => {
          rtCalls.push({ method: String(method), args });
          return Promise.resolve();
        },
      });
    }
  },
}));

const mentionPushes: Array<{ mentionedUserId: unknown; preview: unknown }> = [];
vi.mock('@weldsuite/notifications', () => ({
  sendChatMentionNotification: vi.fn(async (params: { mentionedUserId: unknown; preview: unknown }) => {
    mentionPushes.push({ mentionedUserId: params.mentionedUserId, preview: params.preview });
    return 'notif_1';
  }),
  sendChatThreadReplyNotification: vi.fn(async () => 'notif_2'),
  sendChatDmNotification: vi.fn(async () => 'notif_3'),
}));

const { postChatMessage } = await import('./post-message');

let db: Database;

beforeAll(async () => {
  db = (await createPgliteDb()).db;
  await db.insert(schema.chatChannels).values({ id: 'chan_1', name: 'general', slug: 'general', type: 'public' });
  await db.insert(schema.chatChannelMembers).values([
    { id: 'cmb_1', channelId: 'chan_1', userId: 'user_author', role: 'member' },
    { id: 'cmb_2', channelId: 'chan_1', userId: 'user_ann', role: 'member' },
  ]);
  await db.insert(schema.workspaceMembers).values([
    { id: 'wm_1', userId: 'user_author', name: 'Author' },
    { id: 'wm_2', userId: 'user_ann', name: 'Ann' },
  ]);
}, 60_000);

beforeEach(() => {
  rtCalls.length = 0;
  mentionPushes.length = 0;
});

function ctx() {
  return {
    db,
    env: { REALTIME: {} } as never,
    orgId: 'org_1',
    channelId: 'chan_1',
    authorUserId: 'user_author',
  };
}

describe('postChatMessage realtime + notification payloads', () => {
  it('sends the attachments with the live message event, in the event shape', async () => {
    await postChatMessage(ctx(), {
      content: '',
      attachments: [
        {
          id: 'file_1',
          fileName: 'voice_1.m4a',
          fileSize: 1234,
          mimeType: 'audio/mp4',
          url: 'https://storage.test/voice_1.m4a',
        },
      ],
    });

    const event = rtCalls.find((c) => c.method === 'chatMessage');
    expect(event?.args[0]).toBe('chan_1');
    expect((event?.args[1] as { attachments?: unknown }).attachments).toEqual([
      { id: 'file_1', name: 'voice_1.m4a', url: 'https://storage.test/voice_1.m4a', type: 'audio/mp4', size: 1234 },
    ]);
  });

  it('leaves attachments out of a plain text event', async () => {
    await postChatMessage(ctx(), { content: 'hello' });
    const event = rtCalls.find((c) => c.method === 'chatMessage');
    expect((event?.args[1] as { attachments?: unknown }).attachments).toBeUndefined();
  });

  it('pushes a mention with the name, not the user id', async () => {
    await postChatMessage(ctx(), { content: 'hey <@user_ann> can you check?' });

    expect(mentionPushes).toEqual([{ mentionedUserId: 'user_ann', preview: 'hey @Ann can you check?' }]);
    const [channel] = await db
      .select({ preview: schema.chatChannels.lastMessagePreview })
      .from(schema.chatChannels);
    expect(channel.preview).toBe('hey @Ann can you check?');
  });
});

describe('postChatMessage record references', () => {
  const userMentionPings = () => rtCalls.filter((c) => c.method === 'chatUserMention').map((c) => c.args[1]);

  it('stores a sheet token as a record reference, never as a user mention', async () => {
    const message = await postChatMessage(ctx(), { content: 'numbers are in <@sheet:sht_1|Budget 2026>' });

    // `entity:<type>:<id>`, not a "user" named `sheet` (which would also be pinged).
    expect(message.mentions).toEqual(['entity:sheet:sht_1']);
    expect(mentionPushes).toEqual([]);
    expect(userMentionPings()).toEqual([]);
  });

  it('tells a person from a sheet in the same message, and only pings the person', async () => {
    const message = await postChatMessage(ctx(), {
      content: 'hey <@user_ann> see <@sheet:sht_1|Budget 2026> and <@ticket:tkt_1|Broken pump>',
    });

    expect(message.mentions).toEqual(['user_ann', 'entity:sheet:sht_1', 'entity:ticket:tkt_1']);
    expect(mentionPushes).toEqual([
      { mentionedUserId: 'user_ann', preview: 'hey @Ann see @Budget 2026 and @Broken pump' },
    ]);
    expect(userMentionPings()).toEqual(['user_ann']);
  });
});
