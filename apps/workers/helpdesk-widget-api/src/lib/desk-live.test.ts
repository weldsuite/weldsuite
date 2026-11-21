/**
 * Widget-side desk events reach the entity-events hub, not only the realtime
 * channels: an auto-assignment publishes `desk_conversation:assigned` (the same
 * event the mail path publishes) and a rating publishes `desk_conversation:updated`.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../index';
import type { DeskConversation, DeskMessage } from '@weldsuite/db/lib/desk';

const mocks = vi.hoisted(() => ({
  publishEntityEventRaw: vi.fn((_event: Record<string, unknown>) => Promise.resolve()),
  autoAssignDeskConversation: vi.fn(),
}));

vi.mock('@weldsuite/entity-events', () => ({ publishEntityEventRaw: mocks.publishEntityEventRaw }));
vi.mock('@weldsuite/db/lib/desk-assignment', () => ({
  autoAssignDeskConversation: mocks.autoAssignDeskConversation,
  deskAssignmentRouterPicker: vi.fn(),
}));
vi.mock('@weldsuite/notifications', () => ({ createAndDeliverNotification: vi.fn() }));
vi.mock('@weldsuite/realtime/server', () => ({ RealtimePublisher: vi.fn() }));
vi.mock('../db', () => ({ schema: { workspaceMembers: {} } }));

import { autoAssignConversation, deskCreatedChanges, publishVisitorEvent, publishVisitorMessage } from './desk-live';

const ORG = 'org_1';
const env = { ENTITY_EVENTS: {} } as unknown as Env;
const open = { id: 'dconv_1', state: 'open', assigneeId: null } as unknown as DeskConversation;
const assigned = { ...open, assigneeId: 'user_ann' } as DeskConversation;
const message = { id: 'dmsg_1' } as DeskMessage;

/** A db whose assignee lookup finds nobody: authors only feed the live payloads. */
const db = { select: () => ({ from: () => ({ where: () => Promise.resolve([]) }) }) } as never;

beforeEach(() => {
  vi.clearAllMocks();
});

describe('autoAssignConversation', () => {
  it('publishes desk_conversation:assigned to the hub', async () => {
    mocks.autoAssignDeskConversation.mockResolvedValue({ conversation: assigned, message });
    expect(await autoAssignConversation(env, db, ORG, open)).toBe(assigned);
    expect(mocks.publishEntityEventRaw).toHaveBeenCalledTimes(1);
    expect(mocks.publishEntityEventRaw).toHaveBeenCalledWith(
      expect.objectContaining({
        env,
        workspaceId: ORG,
        entityType: 'desk_conversation',
        action: 'assigned',
        entityId: 'dconv_1',
        data: assigned,
      }),
    );
  });

  it('publishes nothing when nobody was assigned', async () => {
    mocks.autoAssignDeskConversation.mockResolvedValue(null);
    expect(await autoAssignConversation(env, db, ORG, open)).toBe(open);
    expect(mocks.publishEntityEventRaw).not.toHaveBeenCalled();
  });
});

describe('publishVisitorEvent', () => {
  it('publishes desk_conversation:updated for a rating, even without a realtime binding', async () => {
    await publishVisitorEvent(env, ORG, assigned, message, new Map());
    expect(mocks.publishEntityEventRaw).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: ORG, entityType: 'desk_conversation', action: 'updated', entityId: 'dconv_1' }),
    );
  });
});

describe('deskCreatedChanges', () => {
  it('lists the attributes a conversation starts with, from null, like an agent attribute change', () => {
    const request = { ...open, ticketTypeId: 'ttyp_1', priority: 'urgent', departmentId: 'dept_1', tags: [] } as unknown as DeskConversation;
    expect(deskCreatedChanges(request)).toEqual({
      ticketTypeId: { old: null, new: 'ttyp_1' },
      priority: { old: null, new: 'urgent' },
      departmentId: { old: null, new: 'dept_1' },
    });
  });

  it('is undefined when it starts with none', () => {
    expect(deskCreatedChanges({ ...open, ticketTypeId: null, priority: null, departmentId: null, tags: [] } as unknown as DeskConversation)).toBeUndefined();
  });
});

describe('publishVisitorMessage', () => {
  const request = { ...open, ticketTypeId: 'ttyp_1', priority: 'high' } as unknown as DeskConversation;
  const changes = { ticketTypeId: { old: null, new: 'ttyp_1' }, priority: { old: null, new: 'high' } };

  it('puts the changes on the created event of a new conversation', async () => {
    await publishVisitorMessage({ ...env, REALTIME: undefined } as unknown as Env, ORG, request, message, 'Sam', 'created', changes);
    expect(mocks.publishEntityEventRaw).toHaveBeenCalledWith(
      expect.objectContaining({ entityType: 'desk_conversation', action: 'created', entityId: 'dconv_1', changes }),
    );
  });

  it('sends no changes on a reply, or when none were given', async () => {
    await publishVisitorMessage({ ...env, REALTIME: undefined } as unknown as Env, ORG, request, message, 'Sam', 'updated', changes);
    await publishVisitorMessage({ ...env, REALTIME: undefined } as unknown as Env, ORG, request, message, 'Sam', 'created');
    const conversationEvents = mocks.publishEntityEventRaw.mock.calls
      .map(([event]) => event)
      .filter((event) => event.entityType === 'desk_conversation');
    expect(conversationEvents).toHaveLength(1);
    expect(conversationEvents[0]).not.toHaveProperty('changes');
  });
});
