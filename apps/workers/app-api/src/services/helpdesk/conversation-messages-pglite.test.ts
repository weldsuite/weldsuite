/**
 * pglite-backed service tests for services/helpdesk/conversation-messages.ts.
 *
 * This is the surface W5b ported out of api-worker — before it, nothing in
 * app-api read or wrote `helpdesk_conversation_messages` at all. The tests
 * pin the behaviour that lived in the legacy route and would otherwise be
 * easy to lose again: the conversation counter roll-forward, sticky
 * `hasAttachments`, the auto-assign-on-reply rule, and block-response
 * idempotency.
 *
 * Service functions are pure (db in, data out) so they test directly — no Hono
 * context, and therefore none of the `executionCtx` trouble the route-level
 * harness currently has.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  autoAssignOnAgentReply,
  conversationExists,
  createAgentJoinedMessage,
  createAgentMessage,
  listConversationMessages,
  recordBlockResponse,
} from './conversation-messages';
import { createPgliteDb } from '../../test/pglite';
import { schema, type Database } from '../../db';
import { generateId } from '../../lib/id';

let db: Database;

beforeAll(async () => {
  const handle = await createPgliteDb();
  db = handle.db;
}, 60_000);

async function seedConversation(
  overrides: Partial<typeof schema.helpdeskConversations.$inferInsert> = {},
) {
  const id = generateId('conv');
  const now = new Date();
  await db.insert(schema.helpdeskConversations).values({
    id,
    conversationNumber: `CONV-${id.slice(-6)}`,
    subject: 'Printer is on fire',
    customerName: 'Ada Lovelace',
    status: 'active',
    channel: 'email',
    messageCount: 0,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  });
  const [row] = await db
    .select()
    .from(schema.helpdeskConversations)
    .where(eq(schema.helpdeskConversations.id, id))
    .limit(1);
  return row;
}

describe('helpdesk conversation messages · pglite integration', () => {
  it('conversationExists: false for a soft-deleted conversation', async () => {
    const conv = await seedConversation({ deletedAt: new Date() });
    expect(await conversationExists(db, conv.id)).toBe(false);
  });

  it('createAgentMessage: persists the message and rolls the conversation counters forward', async () => {
    const conv = await seedConversation();

    const message = await createAgentMessage(db, {
      conversationId: conv.id,
      authorId: 'user_agent_1',
      authorName: 'Grace',
      content: 'Have you tried turning it off and on again?',
    });

    expect(message.id).toMatch(/^msg_/);
    expect(message.authorType).toBe('agent');
    expect(message.type).toBe('message');
    expect(message.isPublic).toBe(true);
    expect(message.isInternal).toBe(false);

    const [row] = await db
      .select()
      .from(schema.helpdeskConversations)
      .where(eq(schema.helpdeskConversations.id, conv.id))
      .limit(1);

    expect(row.messageCount).toBe(1);
    expect(row.lastMessage).toBe('Have you tried turning it off and on again?');
    expect(row.lastMessageAt).toBeInstanceOf(Date);
    expect(row.lastAgentMessageAt).toBeInstanceOf(Date);
  });

  it('createAgentMessage: an internal note is a private note, not a public message', async () => {
    const conv = await seedConversation();
    const note = await createAgentMessage(db, {
      conversationId: conv.id,
      authorId: 'user_agent_1',
      content: 'Customer has churned twice before — handle gently.',
      isInternal: true,
    });

    expect(note.type).toBe('note');
    expect(note.isInternal).toBe(true);
    expect(note.isPublic).toBe(false);
  });

  it('createAgentMessage: hasAttachments is sticky — a later text-only reply must not clear it', async () => {
    const conv = await seedConversation();

    await createAgentMessage(db, {
      conversationId: conv.id,
      authorId: 'user_agent_1',
      content: 'Here is the invoice',
      attachments: [
        { id: 'att_1', fileName: 'invoice.pdf', fileSize: 1024, mimeType: 'application/pdf', url: 'https://x/y' },
      ],
    });

    let [row] = await db
      .select()
      .from(schema.helpdeskConversations)
      .where(eq(schema.helpdeskConversations.id, conv.id))
      .limit(1);
    expect(row.hasAttachments).toBe(true);

    await createAgentMessage(db, {
      conversationId: conv.id,
      authorId: 'user_agent_1',
      content: 'Let me know if that helps',
    });

    [row] = await db
      .select()
      .from(schema.helpdeskConversations)
      .where(eq(schema.helpdeskConversations.id, conv.id))
      .limit(1);
    expect(row.hasAttachments).toBe(true);
    expect(row.messageCount).toBe(2);
  });

  it('createAgentMessage: an attachment-only message previews as "Sent an attachment"', async () => {
    const conv = await seedConversation();
    await createAgentMessage(db, {
      conversationId: conv.id,
      authorId: 'user_agent_1',
      content: '',
      attachments: [
        { id: 'att_1', fileName: 'shot.png', fileSize: 10, mimeType: 'image/png', url: 'https://x/y' },
      ],
    });

    const [row] = await db
      .select()
      .from(schema.helpdeskConversations)
      .where(eq(schema.helpdeskConversations.id, conv.id))
      .limit(1);
    expect(row.lastMessage).toBe('Sent an attachment');
  });

  it('listConversationMessages: oldest first, soft-deleted excluded', async () => {
    const conv = await seedConversation();
    const first = await createAgentMessage(db, {
      conversationId: conv.id, authorId: 'u1', content: 'first',
    });
    const second = await createAgentMessage(db, {
      conversationId: conv.id, authorId: 'u1', content: 'second',
    });
    const gone = await createAgentMessage(db, {
      conversationId: conv.id, authorId: 'u1', content: 'deleted',
    });
    await db
      .update(schema.helpdeskConversationMessages)
      .set({ deletedAt: new Date() })
      .where(eq(schema.helpdeskConversationMessages.id, gone.id));

    const messages = await listConversationMessages(db, conv.id);
    expect(messages.map((m) => m.id)).toEqual([first.id, second.id]);
    expect(messages.map((m) => m.content)).toEqual(['first', 'second']);
  });

  it('listConversationMessages: surfaces blocks + blockResponses (the legacy projection dropped them)', async () => {
    const conv = await seedConversation();
    const blocks = [{ type: 'button_group', actionId: 'act_1', buttons: [] }];
    const message = await createAgentMessage(db, {
      conversationId: conv.id,
      authorId: 'u1',
      content: 'Pick one',
      blocks: blocks as never,
    });

    const [listed] = await listConversationMessages(db, conv.id);
    expect(listed.id).toBe(message.id);
    expect(listed.blocks).toEqual(blocks);
  });

  describe('autoAssignOnAgentReply', () => {
    it('claims an unassigned conversation for the replying agent', async () => {
      const conv = await seedConversation({ assigneeId: null });
      const assigned = await autoAssignOnAgentReply(db, conv.id, null, 'user_agent_9', 'Grace', false);
      expect(assigned).toBe(true);

      const [row] = await db
        .select()
        .from(schema.helpdeskConversations)
        .where(eq(schema.helpdeskConversations.id, conv.id))
        .limit(1);
      expect(row.assigneeId).toBe('user_agent_9');
      expect(row.assigneeName).toBe('Grace');
    });

    it('takes a conversation over from the AI agent', async () => {
      const conv = await seedConversation({ assigneeId: 'ai-agent' });
      expect(await autoAssignOnAgentReply(db, conv.id, 'ai-agent', 'user_agent_9', 'Grace', false)).toBe(true);
    });

    it('never steals a conversation already assigned to another human', async () => {
      const conv = await seedConversation({ assigneeId: 'user_agent_1' });
      expect(await autoAssignOnAgentReply(db, conv.id, 'user_agent_1', 'user_agent_9', 'Grace', false)).toBe(false);

      const [row] = await db
        .select()
        .from(schema.helpdeskConversations)
        .where(eq(schema.helpdeskConversations.id, conv.id))
        .limit(1);
      expect(row.assigneeId).toBe('user_agent_1');
    });

    it('an internal note does not claim the conversation', async () => {
      const conv = await seedConversation({ assigneeId: null });
      expect(await autoAssignOnAgentReply(db, conv.id, null, 'user_agent_9', 'Grace', true)).toBe(false);
    });
  });

  it('createAgentJoinedMessage: persists a system message so "joined" survives a refresh', async () => {
    const conv = await seedConversation();
    const sys = await createAgentJoinedMessage(db, conv.id, 'user_agent_2', 'Alan');
    expect(sys.content).toBe('Alan has joined the conversation');

    const [row] = await db
      .select()
      .from(schema.helpdeskConversationMessages)
      .where(eq(schema.helpdeskConversationMessages.id, sys.id))
      .limit(1);
    expect(row.authorType).toBe('system');
    expect(row.type).toBe('system');
    expect(row.isRead).toBe(true);
  });

  describe('recordBlockResponse', () => {
    async function seedBlockMessage() {
      const conv = await seedConversation();
      const message = await createAgentMessage(db, {
        conversationId: conv.id,
        authorId: 'u1',
        content: 'Rate us',
        blocks: [{ type: 'rating', actionId: 'act_rating' }] as never,
      });
      return { conv, message };
    }

    it('records the response against its actionId', async () => {
      const { conv, message } = await seedBlockMessage();
      const result = await recordBlockResponse(db, conv.id, message.id, 'act_rating', { rating: 5 });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.blockResponses.act_rating).toMatchObject({
        actionId: 'act_rating',
        type: 'rating',
        value: { rating: 5 },
      });

      const [listed] = await listConversationMessages(db, conv.id);
      expect(listed.blockResponses?.act_rating).toBeDefined();
    });

    it('is idempotent — a second response to the same action is rejected, not overwritten', async () => {
      const { conv, message } = await seedBlockMessage();
      await recordBlockResponse(db, conv.id, message.id, 'act_rating', { rating: 5 });
      const second = await recordBlockResponse(db, conv.id, message.id, 'act_rating', { rating: 1 });

      expect(second).toEqual({ ok: false, reason: 'already_responded' });

      const [listed] = await listConversationMessages(db, conv.id);
      expect(listed.blockResponses?.act_rating).toMatchObject({ value: { rating: 5 } });
    });

    it('rejects an unknown actionId', async () => {
      const { conv, message } = await seedBlockMessage();
      const result = await recordBlockResponse(db, conv.id, message.id, 'act_nope', 'x');
      expect(result).toEqual({ ok: false, reason: 'no_such_action' });
    });

    it('rejects a message that does not belong to the conversation', async () => {
      const { message } = await seedBlockMessage();
      const other = await seedConversation();
      const result = await recordBlockResponse(db, other.id, message.id, 'act_rating', 'x');
      expect(result).toEqual({ ok: false, reason: 'not_found' });
    });
  });
});
