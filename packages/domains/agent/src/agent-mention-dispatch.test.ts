import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';

const notified: string[] = [];
vi.mock('@weldsuite/notifications', () => ({
  sendChatMentionNotification: vi.fn(async (params: { mentionedUserId: string }) => {
    notified.push(params.mentionedUserId);
    return 'notif_1';
  }),
}));

/** Every realtime publish in order: typing frames and posted messages. */
const timeline: string[] = [];
// agent-domain reaches the publisher only through chat-domain, so mock the source file.
vi.mock('../../../core/realtime/src/server/index.ts', () => ({
  RealtimePublisher: class {
    async chatPublish(_channelId: string, payload: { type: string; userId: string; isTyping: boolean }) {
      timeline.push(`${payload.userId}:${payload.isTyping ? 'working' : 'idle'}`);
    }
    async chatMessage(_channelId: string, message: { senderId: string }) {
      timeline.push(`${message.senderId}:message`);
    }
    async chatUserMention() {}
    async chatUserUnreadUpdate() {}
  },
}));

vi.mock('./actor-permissions', () => ({ resolveActorPermissions: vi.fn(async () => ['tickets:read']) }));

const runAgentOnce = vi.fn();
vi.mock('./executor', () => ({ runAgentOnce: (...args: unknown[]) => runAgentOnce(...args) }));

const { dispatchAgentMentions, roomFailureReply } = await import('./agent-mention-dispatch');

const env = { REALTIME: { fetch: async () => new Response('ok') } };
let db: Database;

const reply = (text: string) => ({
  text,
  modelId: 'claude-opus-5-5',
  finishReason: 'end_turn',
  usage: { inputTokens: 10, outputTokens: 5 },
  creditsUsed: 1,
  toolInvocations: [],
  steps: 1,
});

beforeAll(async () => {
  db = (await createPgliteDb()).db;
  await db.insert(schema.chatChannels).values({ id: 'chan_room', name: 'ops', slug: 'ops', type: 'private' });
  await db.insert(schema.chatChannelMembers).values([
    { id: 'cmb_ann', channelId: 'chan_room', userId: 'user_ann', role: 'member' },
    { id: 'cmb_a', channelId: 'chan_room', userId: 'agt_a', memberType: 'agent', role: 'member' },
    { id: 'cmb_b', channelId: 'chan_room', userId: 'agt_b', memberType: 'agent', role: 'member' },
  ]);
  await db.insert(schema.weldagentAgents).values([
    { id: 'agt_a', name: 'Alpha', status: 'active', icon: '🅰️' },
    { id: 'agt_b', name: 'Beta', status: 'active' },
  ]);
}, 60_000);

beforeEach(() => {
  notified.length = 0;
  timeline.length = 0;
  runAgentOnce.mockReset();
});

let seq = 0;
async function post(content: string, opts: { parentId?: string; authorId?: string } = {}): Promise<string> {
  seq += 1;
  const id = `msg_${seq}`;
  await db.insert(schema.chatMessages).values({
    id,
    channelId: 'chan_room',
    authorId: opts.authorId ?? 'user_ann',
    authorName: 'Ann',
    authorType: 'user',
    content,
    parentId: opts.parentId ?? null,
    createdAt: new Date(Date.now() + seq),
    updatedAt: new Date(),
  });
  return id;
}

async function dispatch(messageId: string, content: string, agentMentionIds: string[]) {
  await dispatchAgentMentions(
    { db, env: env as never, orgId: 'org_1', invokerUserId: 'user_ann' },
    { agentMentionIds, channelId: 'chan_room', messageId, messageContent: content },
  );
}

async function agentReplies(agentId: string) {
  return db.select().from(schema.chatMessages).where(eq(schema.chatMessages.authorId, agentId));
}

describe('dispatchAgentMentions', () => {
  it('works in the background, then replies quoting the ask and pings the asker', async () => {
    runAgentOnce.mockResolvedValueOnce(reply('3 tickets are open.'));
    const ask = await post('<@agt_a> how many tickets are open?');
    await dispatch(ask, '<@agt_a> how many tickets are open?', ['agt_a']);

    const [answer] = await agentReplies('agt_a');
    expect(answer.content).toBe('3 tickets are open.');
    expect(answer.mentions).toEqual(['user_ann']);
    expect((answer.metadata as { replyTo: { messageId: string } }).replyTo.messageId).toBe(ask);
    expect(notified).toEqual(['user_ann']);
    // "working" is shown first and cleared before the reply lands.
    expect(timeline[0]).toBe('agt_a:working');
    expect(timeline.slice(-2)).toEqual(['agt_a:idle', 'agt_a:message']);

    const [run] = await db.select().from(schema.weldagentAgentRuns).where(eq(schema.weldagentAgentRuns.agentId, 'agt_a'));
    expect(run.status).toBe('completed');
  });

  it('answers with what went wrong when the turn fails', async () => {
    runAgentOnce.mockRejectedValueOnce(new Error('Out of credits'));
    const ask = await post('<@agt_b> draft the weekly report');
    await dispatch(ask, '<@agt_b> draft the weekly report', ['agt_b']);

    const [answer] = await agentReplies('agt_b');
    expect(answer.content).toBe(roomFailureReply(new Error('Out of credits')));
    expect((answer.metadata as { failed?: boolean }).failed).toBe(true);
    expect(notified).toEqual(['user_ann']);
    expect(timeline).toContain('agt_b:idle');

    const [run] = await db.select().from(schema.weldagentAgentRuns).where(eq(schema.weldagentAgentRuns.agentId, 'agt_b'));
    expect(run.status).toBe('failed');
    await db.delete(schema.chatMessages).where(eq(schema.chatMessages.authorId, 'agt_b'));
  });

  it('runs every tagged agent at the same time', async () => {
    let started = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    runAgentOnce.mockImplementation(async () => {
      started += 1;
      if (started === 2) release();
      await gate;
      return reply('On it.');
    });

    const ask = await post('<@agt_a> <@agt_b> split the backlog');
    await dispatch(ask, '<@agt_a> <@agt_b> split the backlog', ['agt_a', 'agt_b']);

    // Sequential runs would wait on the gate forever; both started.
    expect(started).toBe(2);
  });

  it('reads only the thread it was asked in', async () => {
    runAgentOnce.mockResolvedValueOnce(reply('Noted.'));
    await post('unrelated chatter in the room');
    const root = await post('Release checklist');
    await post('step one is done', { parentId: root });
    const ask = await post('<@agt_a> what is left?', { parentId: root });
    await dispatch(ask, '<@agt_a> what is left?', ['agt_a']);

    const { messages } = runAgentOnce.mock.calls[0][0] as { messages: Array<{ content: string }> };
    const contents = messages.map((m) => m.content);
    expect(contents).toEqual(['[Ann]: Release checklist', '[Ann]: step one is done', '[Ann]: <@agt_a> what is left?']);

    const answers = await agentReplies('agt_a');
    expect(answers.at(-1)?.parentId).toBe(root);
  });
});
