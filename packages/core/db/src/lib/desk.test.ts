/**
 * appendDeskMessage writes the conversation's owner back only for an event that
 * changes it. Auto-assignment claims the owner in the background right after a
 * visitor message, so any other append that wrote back the owner it read first
 * would put the old (empty) value over that claim.
 */

import { describe, expect, it } from 'vitest';
import { appendDeskMessage, type DeskConversation } from './desk';

/** Just enough of the query builder: one stored conversation, and the columns each update sets. */
function fakeDb(current: Partial<DeskConversation>) {
  const updates: Array<Record<string, unknown>> = [];
  const db = {
    select: () => ({ from: () => ({ where: () => ({ limit: async () => [current] }) }) }),
    insert: () => ({ values: (row: Record<string, unknown>) => ({ returning: async () => [row] }) }),
    update: () => ({
      set: (values: Record<string, unknown>) => {
        updates.push(values);
        return { where: () => ({ returning: async () => [{ ...current, ...values }] }) };
      },
    }),
  };
  return { db: db as unknown as Parameters<typeof appendDeskMessage>[0], updates };
}

const generateId = (prefix: string) => `${prefix}_1`;
const stored = { id: 'dconv_1', state: 'open', assigneeId: null, waitingSince: null } as Partial<DeskConversation>;

describe('appendDeskMessage owner write-back', () => {
  it.each([
    ['visitor', 'visitor'],
    ['agent', 'agent'],
    ['bot', 'bot'],
  ] as const)('leaves the owner alone for a %s message', async (_label, authorType) => {
    const { db, updates } = fakeDb(stored);
    await appendDeskMessage(db, { generateId, conversationId: 'dconv_1', kind: 'message', authorType, body: 'hi' });
    expect(updates).toHaveLength(1);
    expect(updates[0]).not.toHaveProperty('assigneeId');
    expect(updates[0]).toHaveProperty('lastMessagePreview', 'hi');
  });

  it.each(['closed', 'reopened', 'rated'] as const)('leaves the owner alone for a %s event', async (eventType) => {
    const { db, updates } = fakeDb({ ...stored, state: 'closed' });
    await appendDeskMessage(db, {
      generateId,
      conversationId: 'dconv_1',
      kind: 'event',
      authorType: 'agent',
      metadata: { eventType },
    });
    expect(updates[0]).not.toHaveProperty('assigneeId');
  });

  it('writes the owner for an assigned event', async () => {
    const { db, updates } = fakeDb(stored);
    const { conversation } = await appendDeskMessage(db, {
      generateId,
      conversationId: 'dconv_1',
      kind: 'event',
      authorType: 'system',
      metadata: { eventType: 'assigned', assigneeId: 'user_ann', auto: true },
      assigneeId: 'user_ann',
    });
    expect(updates[0]).toHaveProperty('assigneeId', 'user_ann');
    expect(conversation.assigneeId).toBe('user_ann');
  });

  it('clears the owner for an unassigned event', async () => {
    const { db, updates } = fakeDb({ ...stored, assigneeId: 'user_ann' });
    await appendDeskMessage(db, {
      generateId,
      conversationId: 'dconv_1',
      kind: 'event',
      authorType: 'agent',
      metadata: { eventType: 'unassigned' },
    });
    expect(updates[0]).toHaveProperty('assigneeId', null);
  });
});
