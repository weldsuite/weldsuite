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
const { parseAlert } = await import('./alerts');
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

describe('create_conversation ticket fields and state', () => {
  it('sets priority and tags, from a list or a comma-separated string', async () => {
    const ctx = makeActionContext({ db });
    const first = (await handleCreateConversation(
      { message: 'Disk full', externalId: 'a-1', priority: 'High', tags: ['alert', 'datadog', 'alert'] },
      ctx,
    )) as Opened & { priority: string };
    expect(first.priority).toBe('high');
    const second = (await handleCreateConversation(
      { message: 'Still full', externalId: 'a-2', priority: 'low', tags: ' ops, disk ,, ops' },
      ctx,
    )) as Opened;
    const rows = await db.select().from(schema.deskConversations);
    const byId = new Map(rows.map((row) => [row.id, row]));
    expect(byId.get(first.conversationId)).toMatchObject({ priority: 'high', tags: ['alert', 'datadog'] });
    expect(byId.get(second.conversationId)).toMatchObject({ priority: 'low', tags: ['ops', 'disk'] });
  });

  it('ignores an unknown priority and state instead of failing the step', async () => {
    const res = (await handleCreateConversation(
      { message: 'Odd', priority: 'blocker', state: 'pending', tags: 5 },
      makeActionContext({ db }),
    )) as Opened;
    expect(res).toMatchObject({ success: true, state: 'open' });
    const [row] = await db.select().from(schema.deskConversations);
    expect(row.priority).toBeNull();
    expect(row.tags).toEqual([]);
  });

  it('follows an alert on one external id: open, escalate, resolve', async () => {
    const ctx = makeActionContext({ db });
    const key = 'grafana:{}:{alertname="HighCPU"}';
    const opened = (await handleCreateConversation(
      { title: 'HighCPU', message: 'CPU is above 80%', externalId: key, priority: 'medium', tags: ['grafana', 'alert'], state: 'open' },
      ctx,
    )) as Opened;
    expect(opened).toMatchObject({ created: true, state: 'open' });

    const escalated = (await handleCreateConversation(
      { title: 'HighCPU', message: 'CPU is above 95%', externalId: key, priority: 'urgent', tags: ['grafana', 'alert'], state: 'open' },
      ctx,
    )) as Opened & { priority: string };
    expect(escalated).toMatchObject({ created: false, conversationId: opened.conversationId, state: 'open', priority: 'urgent' });

    const resolved = (await handleCreateConversation(
      { title: 'HighCPU', message: 'CPU is back to normal', externalId: key, priority: 'urgent', tags: ['grafana', 'alert'], state: 'closed' },
      ctx,
    )) as Opened;
    expect(resolved).toMatchObject({ created: false, conversationId: opened.conversationId, state: 'closed' });

    const rows = await db.select().from(schema.deskConversations);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ state: 'closed', priority: 'urgent', externalId: key });
    const messages = await db.select().from(schema.deskMessages);
    expect(messages.filter((m) => m.kind === 'message').map((m) => m.body)).toEqual([
      'CPU is above 80%',
      'CPU is above 95%',
      'CPU is back to normal',
    ]);

    // A firing alert after the resolve reopens the same ticket.
    const again = (await handleCreateConversation(
      { title: 'HighCPU', message: 'CPU is above 90% again', externalId: key, priority: 'high', state: 'open' },
      ctx,
    )) as Opened;
    expect(again).toMatchObject({ created: false, conversationId: opened.conversationId, state: 'open' });
  });

  describe('a repeat never lowers the priority', () => {
    type Result = Opened & { priority: string | null };
    const send = (ctx: ReturnType<typeof makeActionContext>, key: string, priority: string, state = 'open') =>
      handleCreateConversation({ message: `${priority} ${state}`, externalId: key, priority, state }, ctx) as Promise<Result>;

    it('keeps urgent when a warning follows a critical, and raises when a critical follows a warning', async () => {
      const ctx = makeActionContext({ db });
      expect(await send(ctx, 'p-1', 'urgent')).toMatchObject({ created: true, priority: 'urgent' });
      expect(await send(ctx, 'p-1', 'medium')).toMatchObject({ created: false, priority: 'urgent' });
      expect(await send(ctx, 'p-1', 'low')).toMatchObject({ priority: 'urgent' });
      expect(await send(ctx, 'p-2', 'medium')).toMatchObject({ created: true, priority: 'medium' });
      expect(await send(ctx, 'p-2', 'urgent')).toMatchObject({ created: false, priority: 'urgent' });
      expect(await send(ctx, 'p-2', 'high')).toMatchObject({ priority: 'urgent' });
    });

    it('an equal priority is left alone and a missing one counts as the lowest', async () => {
      const ctx = makeActionContext({ db });
      const none = (await handleCreateConversation({ message: 'no priority', externalId: 'p-3' }, ctx)) as Result;
      expect(none.priority).toBeNull();
      expect(await send(ctx, 'p-3', 'low')).toMatchObject({ created: false, priority: 'low' });
      expect(await send(ctx, 'p-3', 'low')).toMatchObject({ priority: 'low' });
    });

    it('the run that closes the ticket does not change its priority', async () => {
      const ctx = makeActionContext({ db });
      await send(ctx, 'p-4', 'urgent');
      expect(await send(ctx, 'p-4', 'medium', 'closed')).toMatchObject({ state: 'closed', priority: 'urgent' });
      await send(ctx, 'p-5', 'low');
      expect(await send(ctx, 'p-5', 'urgent', 'closed')).toMatchObject({ state: 'closed', priority: 'low' });
    });

    it('a reopened ticket is a new episode and takes the incoming priority', async () => {
      const ctx = makeActionContext({ db });
      await send(ctx, 'p-6', 'urgent');
      await send(ctx, 'p-6', 'medium', 'closed');
      expect(await send(ctx, 'p-6', 'medium')).toMatchObject({ created: false, state: 'open', priority: 'medium' });
    });

    it('a step without an external id or priority is untouched by the rule', async () => {
      const ctx = makeActionContext({ db });
      const a = (await handleCreateConversation({ message: 'x', priority: 'low' }, ctx)) as Result;
      const b = (await handleCreateConversation({ message: 'y', priority: 'urgent' }, ctx)) as Result;
      expect([a.priority, b.priority]).toEqual(['low', 'urgent']);
    });
  });

  it('opens, updates and closes a ticket from parse_alert output as the template wires it', async () => {
    const ctx = makeActionContext({ db });
    const grafana = {
      receiver: 'weldsuite',
      groupKey: '{}:{alertname="Disk"}',
      title: '[FIRING:1] Disk',
      message: 'Disk is full',
      commonLabels: { severity: 'critical' },
      alerts: [{ status: 'firing', labels: { severity: 'critical' }, fingerprint: 'f1' }],
    };
    const send = async (payload: Record<string, unknown>) => {
      const alert = parseAlert(payload);
      if (!alert.success) throw new Error(alert.error);
      return (await handleCreateConversation(
        {
          title: alert.title,
          message: alert.message,
          externalId: alert.externalId,
          priority: alert.priority,
          tags: alert.tags,
          state: alert.state,
        },
        ctx,
      )) as Opened;
    };
    const firing = await send({ ...grafana, status: 'firing' });
    const resolved = await send({ ...grafana, status: 'resolved', title: '[RESOLVED] Disk', message: 'Disk is fine' });
    expect(resolved).toMatchObject({ created: false, conversationId: firing.conversationId, state: 'closed' });
    const [row] = await db.select().from(schema.deskConversations);
    expect(row).toMatchObject({ priority: 'urgent', tags: ['grafana', 'alert'], state: 'closed' });
  });

  it('opens and closes a conversation that a resolved alert is the first sight of', async () => {
    const res = (await handleCreateConversation(
      { message: 'Recovered', externalId: 'dd-1', state: 'closed' },
      makeActionContext({ db }),
    )) as Opened;
    expect(res).toMatchObject({ created: true, state: 'closed' });
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
