/**
 * Widget-side desk events reach the entity-events hub, not only the realtime
 * channels: an auto-assignment publishes `desk_conversation:assigned` (the same
 * event the mail path publishes) and a rating publishes `desk_conversation:updated`.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../index';
import type { DeskConversation, DeskMessage } from '@weldsuite/db/lib/desk';

const mocks = vi.hoisted(() => ({
  publishEntityEventRaw: vi.fn(() => Promise.resolve()),
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

import { autoAssignConversation, publishVisitorEvent } from './desk-live';

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
