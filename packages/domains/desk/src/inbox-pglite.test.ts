/**
 * The live inbox for writers outside it (public API, MCP, WeldAgent,
 * workflows) on pglite: external-id dedup, reopening, auto-assignment, the
 * entity events and who gets notified.
 */

import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { generateId } from '@weldsuite/worker-kit/id';
import { createDeskConversation, listDeskConversations, DeskExternalIdTakenError } from '@weldsuite/db/lib/desk';
import { saveDeskAssignmentSettings } from '@weldsuite/db/lib/desk-assignment';

const notifications = vi.hoisted(() => ({
  team: vi.fn(async (_params: { userId: string; title: string }) => 'ntf'),
  assigned: vi.fn(async (_params: { assigneeId: string }) => 'ntf'),
}));

vi.mock('@weldsuite/notifications', () => ({
  createAndDeliverNotification: notifications.team,
  sendTicketAssignedNotification: notifications.assigned,
  helpdeskPreview: (text: string | null | undefined) => (text ?? '').trim(),
}));

const {
  addDeskConversationMessageFromApi,
  autoAssignDeskConversationFromApi,
  openDeskApiConversation,
  shouldNotifyDeskTeam,
  updateDeskConversationFromApi,
  DeskConversationNotFoundError,
  DeskEmptyUpdateError,
  DeskReplyChannelError,
} = await import('./inbox');
type DeskInboxEvent = import('./inbox').DeskInboxEvent;

let db: Database;
let events: DeskInboxEvent[];

const deps = () => ({
  db,
  env: {},
  clerkOrgId: 'org_test',
  generateId,
  emit: (event: DeskInboxEvent) => {
    events.push(event);
  },
});

const bot = { authorType: 'bot' as const, authorId: 'wsk_key' };

beforeAll(async () => {
  db = (await createPgliteDb()).db;
  await db.insert(schema.workspaceMembers).values([
    { id: generateId('wm'), userId: 'user_ann', name: 'Ann' },
    { id: generateId('wm'), userId: 'user_viewer', name: 'Vic', role: 'VIEWER' },
  ]);
}, 60_000);

beforeEach(async () => {
  events = [];
  notifications.team.mockClear();
  notifications.assigned.mockClear();
  await db.delete(schema.deskMessages);
  await db.delete(schema.deskConversations);
  await db.delete(schema.deskVisitors);
  await db.delete(schema.helpdeskSettings);
});

const kinds = () => events.map((e) => `${e.entityType}.${e.action}`);

describe('openDeskApiConversation', () => {
  it('opens an api conversation that waits on the team and tells everyone who can work the inbox', async () => {
    const result = await openDeskApiConversation(deps(), {
      via: 'api',
      title: 'Disk full on db-1',
      body: '/var is at 98%',
      name: 'Datadog',
    });

    expect(result.created).toBe(true);
    expect(result.conversation).toMatchObject({
      channel: 'api',
      state: 'open',
      title: 'Disk full on db-1',
      name: 'Datadog',
      visitorId: null,
      externalId: null,
    });
    expect(result.conversation.waitingSince).not.toBeNull();
    expect(result.message).toMatchObject({ authorType: 'visitor', body: '/var is at 98%' });
    expect(result.message.metadata).toMatchObject({ via: 'api' });
    expect(kinds()).toEqual(['desk_conversation.created', 'desk_message.created']);
    expect(notifications.team.mock.calls.map(([p]) => p.userId)).toEqual(['user_ann']);
    expect(notifications.team.mock.calls[0]![0].title).toBe('New conversation from Datadog');
  });

  it('adds a repeat of the same alert to the one conversation and does not notify again', async () => {
    const first = await openDeskApiConversation(deps(), { via: 'api', externalId: 'dd-42', body: 'CPU 95%' });
    notifications.team.mockClear();
    events = [];
    const second = await openDeskApiConversation(deps(), { via: 'api', externalId: ' dd-42 ', body: 'CPU 99%' });

    expect(second.created).toBe(false);
    expect(second.conversation.id).toBe(first.conversation.id);
    expect(second.conversation.externalId).toBe('dd-42');
    const rows = await db.select().from(schema.deskConversations);
    expect(rows).toHaveLength(1);
    const messages = await db
      .select()
      .from(schema.deskMessages)
      .where(eq(schema.deskMessages.conversationId, first.conversation.id));
    expect(messages.map((m) => m.body).sort()).toEqual(['CPU 95%', 'CPU 99%']);
    expect(kinds()).toEqual(['desk_conversation.updated', 'desk_message.created']);
    expect(notifications.team).not.toHaveBeenCalled();
  });

  it('reopens a closed conversation when the alert comes back, and tells the team', async () => {
    const first = await openDeskApiConversation(deps(), { via: 'workflow', externalId: 'order-7', body: 'Payment failed' });
    await updateDeskConversationFromApi(deps(), { conversationId: first.conversation.id, state: 'closed', actor: bot });
    notifications.team.mockClear();
    events = [];

    const again = await openDeskApiConversation(deps(), { via: 'workflow', externalId: 'order-7', body: 'Payment failed again' });

    expect(again.created).toBe(false);
    expect(again.prior?.state).toBe('closed');
    expect(again.conversation.state).toBe('open');
    expect(kinds()).toEqual(['desk_conversation.state_changed', 'desk_message.created']);
    expect(notifications.team).toHaveBeenCalledTimes(1);
  });

  it('keeps one conversation when two deliveries of the same alert race', async () => {
    const [a, b] = await Promise.all([
      openDeskApiConversation(deps(), { via: 'api', externalId: 'race-1', body: 'one' }),
      openDeskApiConversation(deps(), { via: 'api', externalId: 'race-1', body: 'two' }),
    ]);

    expect(a.conversation.id).toBe(b.conversation.id);
    expect([a.created, b.created].sort()).toEqual([false, true]);
    const listed = await listDeskConversations(db, { externalId: 'race-1' });
    expect(listed.totalCount).toBe(1);
  });

  it('reads the unique-index refusal through the driver error, whatever wraps it', async () => {
    await createDeskConversation(db, { generateId, visitorId: null, body: 'a', externalId: 'dup-1' });
    await expect(
      createDeskConversation(db, { generateId, visitorId: null, body: 'b', externalId: 'dup-1' }),
    ).rejects.toBeInstanceOf(DeskExternalIdTakenError);
  });

  it('files a customer email under their desk visitor, so the inbox finds their other conversations', async () => {
    const result = await openDeskApiConversation(deps(), {
      via: 'agent',
      title: 'Refund request',
      body: 'Customer wants a refund for order 12',
      name: 'Jo Customer',
      email: 'Jo@Example.com',
    });

    expect(result.conversation.email).toBe('jo@example.com');
    expect(result.conversation.visitorId).toMatch(/^dvis_/);
    const listed = await listDeskConversations(db, { email: 'jo@example.com' });
    expect(listed.data.map((c) => c.id)).toEqual([result.conversation.id]);
  });

  it('hands the conversation to a teammate when auto-assignment is on, and notifies only them', async () => {
    await saveDeskAssignmentSettings(db, generateId, { mode: 'round_robin', memberIds: ['user_ann'] });

    const result = await openDeskApiConversation(deps(), { via: 'mcp', body: 'Printer on fire' });

    expect(result.conversation.assigneeId).toBe('user_ann');
    expect(kinds()).toEqual([
      'desk_conversation.created',
      'desk_message.created',
      'desk_conversation.assigned',
      'desk_message.created',
    ]);
    expect(notifications.team.mock.calls.map(([p]) => p.userId)).toEqual(['user_ann']);
  });

  it('asks the AssignmentRouter when the worker has it (ADR DESK-005)', async () => {
    await saveDeskAssignmentSettings(db, generateId, { mode: 'round_robin', memberIds: ['user_ann'] });
    const router = vi.fn(async (_url: string, _init?: RequestInit) => Response.json({ userId: 'user_ann' }));

    const result = await openDeskApiConversation(
      { ...deps(), env: { HELPDESK_WORKFLOW: { fetch: router } } },
      { via: 'api', body: 'Disk full' },
    );

    expect(result.conversation.assigneeId).toBe('user_ann');
    expect(router).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(router.mock.calls[0]![1]?.body))).toMatchObject({ workspaceId: 'org_test' });
  });

  it('auto-assigns on request (a workflow) with the timeline event', async () => {
    const { conversation } = await openDeskApiConversation(deps(), { via: 'workflow', body: 'Help' });
    await saveDeskAssignmentSettings(db, generateId, { mode: 'round_robin', memberIds: ['user_ann'] });
    events = [];

    const assigned = await autoAssignDeskConversationFromApi(deps(), conversation.id);

    expect(assigned?.assigneeId).toBe('user_ann');
    expect(kinds()).toEqual(['desk_conversation.assigned', 'desk_message.created']);
    expect(await autoAssignDeskConversationFromApi(deps(), conversation.id)).toBeNull();
  });

  it('hands the conversation to the named teammate instead of auto-assignment, and tells them', async () => {
    await saveDeskAssignmentSettings(db, generateId, { mode: 'round_robin', memberIds: ['user_ann'] });

    const result = await openDeskApiConversation(deps(), {
      via: 'api',
      body: 'Invoice wrong',
      assigneeId: 'user_bob',
      actor: bot,
    });

    expect(result.conversation.assigneeId).toBe('user_bob');
    expect(kinds().slice(2)).toEqual(['desk_conversation.assigned', 'desk_message.created']);
    const assigned = events[3]!.data as { authorType: string; authorId: string };
    expect(assigned).toMatchObject({ authorType: 'bot', authorId: 'wsk_key' });
    expect(notifications.team.mock.calls.map(([p]) => p.userId)).toEqual(['user_bob']);
  });
});

describe('shouldNotifyDeskTeam', () => {
  it('notifies for a new conversation or when the ball moves back, not while it already waits', () => {
    expect(shouldNotifyDeskTeam({ created: true, prior: null })).toBe(true);
    expect(
      shouldNotifyDeskTeam({ created: false, prior: { state: 'open', waitingSince: new Date(), assigneeId: null } }),
    ).toBe(false);
    expect(
      shouldNotifyDeskTeam({ created: false, prior: { state: 'open', waitingSince: null, assigneeId: null } }),
    ).toBe(true);
    expect(
      shouldNotifyDeskTeam({ created: false, prior: { state: 'closed', waitingSince: null, assigneeId: null } }),
    ).toBe(true);
  });
});

describe('updateDeskConversationFromApi', () => {
  it('assigns and closes as timeline events, and notifies the new assignee', async () => {
    const { conversation } = await openDeskApiConversation(deps(), { via: 'api', body: 'Help' });
    events = [];

    const result = await updateDeskConversationFromApi(deps(), {
      conversationId: conversation.id,
      assigneeId: 'user_ann',
      state: 'closed',
      actor: { authorType: 'agent', authorId: 'user_bob' },
    });

    expect(result.conversation).toMatchObject({ assigneeId: 'user_ann', state: 'closed' });
    expect(result.messages.map((m) => m.metadata?.eventType)).toEqual(['assigned', 'closed']);
    expect(kinds()).toEqual([
      'desk_conversation.assigned',
      'desk_message.created',
      'desk_conversation.state_changed',
      'desk_message.created',
    ]);
    expect(notifications.assigned).toHaveBeenCalledWith(
      expect.objectContaining({ assigneeId: 'user_ann', assignedByUserId: 'user_bob', kind: 'conversation' }),
    );
  });

  it('writes nothing for a change to what already holds', async () => {
    const { conversation } = await openDeskApiConversation(deps(), { via: 'api', body: 'Help' });
    events = [];

    const result = await updateDeskConversationFromApi(deps(), {
      conversationId: conversation.id,
      state: 'open',
      assigneeId: null,
      actor: bot,
    });

    expect(result.messages).toEqual([]);
    expect(events).toEqual([]);
  });

  it('refuses an empty change and an unknown conversation', async () => {
    await expect(
      updateDeskConversationFromApi(deps(), { conversationId: 'dconv_x', actor: bot }),
    ).rejects.toBeInstanceOf(DeskEmptyUpdateError);
    await expect(
      updateDeskConversationFromApi(deps(), { conversationId: 'dconv_x', state: 'closed', actor: bot }),
    ).rejects.toBeInstanceOf(DeskConversationNotFoundError);
  });
});

describe('addDeskConversationMessageFromApi', () => {
  it('replies on an api conversation, which hands the ball to the customer', async () => {
    const { conversation } = await openDeskApiConversation(deps(), { via: 'api', body: 'Help' });

    const result = await addDeskConversationMessageFromApi(deps(), {
      conversationId: conversation.id,
      kind: 'message',
      body: 'Looking into it',
      actor: bot,
    });

    expect(result.message).toMatchObject({ kind: 'message', authorType: 'bot', body: 'Looking into it' });
    expect(result.conversation.waitingSince).toBeNull();
  });

  it("pushes a reply and a close to the conversation's room, where the widget listens, but never a note", async () => {
    const { conversation } = await openDeskApiConversation(deps(), { via: 'api', body: 'Help' });
    const room = vi.fn(async (_conversationId: string, _payload: unknown) => {});
    const withRoom = { ...deps(), publishRoom: room };

    await addDeskConversationMessageFromApi(withRoom, {
      conversationId: conversation.id,
      kind: 'note',
      body: 'Internal only',
      actor: bot,
    });
    expect(room).not.toHaveBeenCalled();

    await addDeskConversationMessageFromApi(withRoom, {
      conversationId: conversation.id,
      kind: 'message',
      body: 'Looking into it',
      actor: { authorType: 'agent', authorId: 'user_ann' },
    });
    expect(room).toHaveBeenLastCalledWith(
      conversation.id,
      expect.objectContaining({ type: 'message', content: 'Looking into it', senderName: 'Ann' }),
    );

    await updateDeskConversationFromApi(withRoom, { conversationId: conversation.id, state: 'closed', actor: bot });
    expect(room).toHaveBeenLastCalledWith(
      conversation.id,
      expect.objectContaining({ type: 'system', event: 'closed', data: expect.objectContaining({ state: 'closed' }) }),
    );
  });

  it('takes a note on an email conversation but refuses a reply that would never be emailed', async () => {
    const { conversation } = await createDeskConversation(db, {
      generateId,
      channel: 'email',
      visitorId: null,
      email: 'a@b.c',
      body: 'Hello',
    });

    const note = await addDeskConversationMessageFromApi(deps(), {
      conversationId: conversation.id,
      kind: 'note',
      body: 'Checked the logs',
      actor: bot,
    });
    expect(note.message.kind).toBe('note');

    await expect(
      addDeskConversationMessageFromApi(deps(), {
        conversationId: conversation.id,
        kind: 'message',
        body: 'Hi there',
        actor: bot,
      }),
    ).rejects.toBeInstanceOf(DeskReplyChannelError);
  });
});
