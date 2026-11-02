/**
 * Workflows on the WeldDesk inbox (pglite): create_conversation and a ticket
 * from create_record open inbox conversations with external-id dedup, and the
 * conversation actions act on inbox conversations.
 */

import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { createDeskConversation } from '@weldsuite/db/lib/desk';
import { makeActionContext } from '../../test/ctx';
import { createPgliteDb } from '../../test/pglite';
import { schema, type Database } from '../../db';

vi.mock('@weldsuite/notifications', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createAndDeliverNotification: vi.fn(async () => 'ntf'),
  sendTicketAssignedNotification: vi.fn(async () => 'ntf'),
}));

const { handleCreateConversation } = await import('./desk');
const { handleCreateRecord } = await import('./data');
const {
  handleAddInternalNote,
  handleAssignConversation,
  handleChangeConversationStatus,
  handleChangePriority,
  handleSendReply,
  handleTagConversation,
} = await import('./helpdesk');

let db: Database;

beforeAll(async () => {
  db = (await createPgliteDb()).db;
}, 90_000);

beforeEach(async () => {
  await db.delete(schema.deskMessages);
  await db.delete(schema.deskConversations);
  await db.delete(schema.deskVisitors);
});

type Opened = { success: boolean; created: boolean; conversationId: string; state: string };

describe('create_conversation', () => {
  it('opens an inbox conversation and keeps a repeat of the same key on it', async () => {
    const ctx = makeActionContext({ db });
    const first = (await handleCreateConversation(
      { title: 'Payment failed', message: 'Card declined for order 7', email: 'jo@example.com', externalId: 'order-7' },
      ctx,
    )) as Opened;
    expect(first).toMatchObject({ success: true, created: true, state: 'open' });

    const again = (await handleCreateConversation(
      { title: 'Payment failed', message: 'Declined again', externalId: 'order-7' },
      ctx,
    )) as Opened;
    expect(again).toMatchObject({ created: false, conversationId: first.conversationId });

    const [row] = await db.select().from(schema.deskConversations);
    expect(row).toMatchObject({ channel: 'api', email: 'jo@example.com', externalId: 'order-7' });
    const messages = await db.select().from(schema.deskMessages);
    expect(messages.map((m) => m.metadata?.via)).toEqual(['workflow', 'workflow']);
  });

  it('fails the step without a message', async () => {
    await expect(handleCreateConversation({ externalId: 'x' }, makeActionContext({ db }))).rejects.toThrow(
      'needs a message',
    );
  });
});

describe('create_record for a ticket', () => {
  it('opens an inbox conversation instead of a helpdesk_tickets row', async () => {
    const res = (await handleCreateRecord(
      {
        entity: 'ticket',
        data: { subject: 'Cannot log in', description: 'Reset link expired', customerEmail: 'a@b.c' },
      },
      makeActionContext({ db }),
    )) as Opened;

    expect(res).toMatchObject({ success: true, created: true });
    const [row] = await db
      .select()
      .from(schema.deskConversations)
      .where(eq(schema.deskConversations.id, res.conversationId));
    expect(row).toMatchObject({ title: 'Cannot log in', email: 'a@b.c' });
    expect(await db.select().from(schema.helpdeskTickets)).toHaveLength(0);
  });
});

describe('conversation actions on an inbox conversation', () => {
  async function opened() {
    const ctx = makeActionContext({ db });
    const res = (await handleCreateConversation({ message: 'Help please' }, ctx)) as Opened;
    return makeActionContext({
      db,
      triggerData: { entityType: 'desk_conversation', entityId: res.conversationId },
    });
  }

  it('notes, replies, assigns and closes through the inbox timeline', async () => {
    const ctx = await opened();
    expect(await handleAddInternalNote({ content: 'Looked at it' }, ctx)).toMatchObject({ success: true });
    expect(await handleSendReply({ message: 'On it' }, ctx)).toMatchObject({ success: true });
    expect(await handleAssignConversation({ strategy: 'specific_agent', agentId: 'user_ann' }, ctx)).toMatchObject({
      success: true,
      assigneeId: 'user_ann',
    });
    expect(await handleChangeConversationStatus({ status: 'resolved' }, ctx)).toMatchObject({
      success: true,
      status: 'closed',
    });

    const messages = await db.select().from(schema.deskMessages);
    expect(messages.map((m) => [m.kind, m.authorType])).toEqual([
      ['message', 'visitor'],
      ['note', 'bot'],
      ['message', 'bot'],
      ['event', 'bot'],
      ['event', 'bot'],
    ]);
  });

  it('tags and prioritises as ticket fields, and says plainly what the inbox does not have', async () => {
    const ctx = await opened();
    expect(await handleTagConversation({ tags: ['vip', 'billing'] }, ctx)).toMatchObject({
      success: true,
      tags: ['vip', 'billing'],
    });
    expect(await handleTagConversation({ mode: 'remove', tags: ['VIP'] }, ctx)).toMatchObject({ tags: ['billing'] });
    expect(await handleChangePriority({ priority: 'critical' }, ctx)).toMatchObject({ success: true, priority: 'urgent' });
    expect(await handleChangePriority({ priority: 'someday' }, ctx)).toMatchObject({ success: false });
    expect(await handleChangeConversationStatus({ status: 'snoozed' }, ctx)).toMatchObject({ success: false });
  });

  it('refuses a reply on an email conversation the workflow cannot email', async () => {
    const { conversation } = await createDeskConversation(db, {
      generateId: (p) => `${p}_${Math.random().toString(36).slice(2)}`,
      channel: 'email',
      visitorId: null,
      email: 'a@b.c',
      body: 'Hello',
    });
    const ctx = makeActionContext({ db, triggerData: { entityType: 'desk_conversation', entityId: conversation.id } });
    expect(await handleSendReply({ message: 'Hi' }, ctx)).toMatchObject({ success: false });
  });
});
