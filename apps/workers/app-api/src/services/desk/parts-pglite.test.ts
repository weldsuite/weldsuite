/**
 * pglite-backed service tests for services/desk/parts.ts + conversations.ts.
 *
 * Covers the Phase-1 conversation-core invariants called out in
 * .claude/welddesk-intercom-plan.md §2: waitingSince transitions, the
 * snooze/unsnooze matrix (assignee-own-reply exception), reopen counting,
 * median reply time, assignment preserve/clear semantics, and close→close
 * statistics idempotency.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { createConversation } from './conversations';
import { appendPart, appendReplyPart, maybeTimerUnsnooze } from './parts';
import { createPgliteDb } from '../../test/pglite';
import { schema, type Database } from '../../db';
import { eq } from 'drizzle-orm';

let db: Database;

beforeAll(async () => {
  const handle = await createPgliteDb();
  db = handle.db;
}, 60_000);

async function seedConversation(overrides: { deliveredAs?: 'customer_initiated' | 'admin_initiated' } = {}) {
  const { conversation } = await createConversation(db, {
    channel: 'messenger',
    deliveredAs: overrides.deliveredAs ?? 'admin_initiated',
    body: 'Hello, I need help',
    authorUserId: 'user_admin_1',
  });
  return conversation;
}

describe('desk conversation parts · pglite integration', () => {
  it('waitingSince: set on customer comment, cleared on admin reply', async () => {
    const conv = await seedConversation({ deliveredAs: 'customer_initiated' });
    expect(conv.waitingSince).toBeInstanceOf(Date);

    const { conversation: afterAdminReply } = await appendPart(db, {
      conversationId: conv.id,
      partType: 'comment',
      authorType: 'admin',
      authorId: 'user_admin_1',
      body: 'On it!',
    });
    expect(afterAdminReply.waitingSince).toBeNull();

    const { conversation: afterCustomerReply } = await appendPart(db, {
      conversationId: conv.id,
      partType: 'comment',
      authorType: 'user',
      body: 'Thanks, still broken though',
    });
    expect(afterCustomerReply.waitingSince).toBeInstanceOf(Date);
  });

  it('note never touches waitingSince', async () => {
    const conv = await seedConversation({ deliveredAs: 'customer_initiated' });
    const before = conv.waitingSince;

    const { conversation } = await appendPart(db, {
      conversationId: conv.id,
      partType: 'note',
      authorType: 'admin',
      authorId: 'user_admin_1',
      body: 'internal note',
    });
    expect(conversation.waitingSince?.getTime()).toBe(before?.getTime());
  });

  it('reopen counting: customer comment on a closed conversation reopens + increments countReopens', async () => {
    const conv = await seedConversation();
    const { conversation: closed } = await appendPart(db, {
      conversationId: conv.id,
      partType: 'close',
      authorType: 'admin',
      authorId: 'user_admin_1',
    });
    expect(closed.state).toBe('closed');
    expect(closed.statistics?.countReopens).toBe(0);

    const { conversation: reopened } = await appendPart(db, {
      conversationId: conv.id,
      partType: 'comment',
      authorType: 'user',
      body: 'still broken',
    });
    expect(reopened.state).toBe('open');
    expect(reopened.statistics?.countReopens).toBe(1);
  });

  it('close→close is idempotent on firstCloseAt/timeToFirstClose (one-outcome statistics)', async () => {
    const conv = await seedConversation();
    const { conversation: firstClose } = await appendPart(db, {
      conversationId: conv.id,
      partType: 'close',
      authorType: 'admin',
      authorId: 'user_admin_1',
    });
    const firstCloseAt = firstClose.statistics?.firstCloseAt;
    expect(firstCloseAt).toBeTruthy();

    // Re-open then close again — firstCloseAt must NOT change, only lastCloseAt.
    await appendPart(db, { conversationId: conv.id, partType: 'open', authorType: 'admin', authorId: 'user_admin_1' });
    const { conversation: secondClose } = await appendPart(db, {
      conversationId: conv.id,
      partType: 'close',
      authorType: 'admin',
      authorId: 'user_admin_1',
    });
    expect(secondClose.statistics?.firstCloseAt).toBe(firstCloseAt);
    expect(secondClose.statistics?.lastCloseAt).not.toBe(firstCloseAt);
  });

  it('assignment: teammate-assign preserves team; team-assign clears teammate', async () => {
    const conv = await seedConversation();

    const { conversation: teamAssigned } = await appendPart(db, {
      conversationId: conv.id,
      partType: 'assignment',
      authorType: 'admin',
      authorId: 'user_admin_1',
      assignedToType: 'team',
      assignedToId: 'team_1',
    });
    expect(teamAssigned.teamAssigneeId).toBe('team_1');
    expect(teamAssigned.adminAssigneeId).toBeNull();

    const { conversation: adminAssigned } = await appendPart(db, {
      conversationId: conv.id,
      partType: 'assignment',
      authorType: 'admin',
      authorId: 'user_admin_1',
      assignedToType: 'admin',
      assignedToId: 'user_admin_2',
    });
    // Teammate-assign preserves the existing team assignment.
    expect(adminAssigned.adminAssigneeId).toBe('user_admin_2');
    expect(adminAssigned.teamAssigneeId).toBe('team_1');

    const { conversation: teamAssignedAgain } = await appendPart(db, {
      conversationId: conv.id,
      partType: 'assignment',
      authorType: 'admin',
      authorId: 'user_admin_1',
      assignedToType: 'team',
      assignedToId: 'team_2',
    });
    // Team-assign clears the teammate assignment.
    expect(teamAssignedAgain.teamAssigneeId).toBe('team_2');
    expect(teamAssignedAgain.adminAssigneeId).toBeNull();

    expect(teamAssignedAgain.statistics?.countAssignments).toBe(3);
    expect(teamAssignedAgain.statistics?.firstAssignmentAt).toBeTruthy();
  });

  it('median reply time is recomputed as admin replies accumulate', async () => {
    const conv = await seedConversation({ deliveredAs: 'customer_initiated' });

    // Force a known waitingSince in the past so the reply-time sample is deterministic-ish (>0).
    await db
      .update(schema.deskConversations)
      .set({ waitingSince: new Date(Date.now() - 10_000) })
      .where(eq(schema.deskConversations.id, conv.id));

    const { conversation: afterFirstReply } = await appendPart(db, {
      conversationId: conv.id,
      partType: 'comment',
      authorType: 'admin',
      authorId: 'user_admin_1',
      body: 'reply 1',
    });
    expect(afterFirstReply.statistics?.replyTimes?.length).toBe(1);
    expect(afterFirstReply.statistics?.medianTimeToReply).toBeGreaterThanOrEqual(0);

    await appendPart(db, { conversationId: conv.id, partType: 'comment', authorType: 'user', body: 'again' });
    await db
      .update(schema.deskConversations)
      .set({ waitingSince: new Date(Date.now() - 20_000) })
      .where(eq(schema.deskConversations.id, conv.id));
    const { conversation: afterSecondReply } = await appendPart(db, {
      conversationId: conv.id,
      partType: 'comment',
      authorType: 'admin',
      authorId: 'user_admin_1',
      body: 'reply 2',
    });
    expect(afterSecondReply.statistics?.replyTimes?.length).toBe(2);
    expect(typeof afterSecondReply.statistics?.medianTimeToReply).toBe('number');
  });

  it('snooze/unsnooze matrix: assignee\'s own reply does NOT unsnooze; another teammate\'s reply does', async () => {
    const conv = await seedConversation();
    await appendPart(db, {
      conversationId: conv.id,
      partType: 'assignment',
      authorType: 'admin',
      authorId: 'user_admin_1',
      assignedToType: 'admin',
      assignedToId: 'user_admin_1',
    });
    const { conversation: snoozed } = await appendPart(db, {
      conversationId: conv.id,
      partType: 'snoozed',
      authorType: 'admin',
      authorId: 'user_admin_1',
      snoozedUntil: new Date(Date.now() + 3600_000),
    });
    expect(snoozed.state).toBe('snoozed');

    // The assignee's OWN reply must not unsnooze.
    const { conversation: stillSnoozed } = await appendReplyPart(db, {
      conversationId: conv.id,
      messageType: 'comment',
      authorType: 'admin',
      authorId: 'user_admin_1',
      body: 'still working on it',
    });
    expect(stillSnoozed.state).toBe('snoozed');

    // A DIFFERENT teammate's reply unsnoozes.
    const { conversation: unsnoozed } = await appendReplyPart(db, {
      conversationId: stillSnoozed.id,
      messageType: 'comment',
      authorType: 'admin',
      authorId: 'user_admin_2',
      body: 'let me help',
    });
    expect(unsnoozed.state).toBe('open');
  });

  it('snooze/unsnooze matrix: a customer reply always unsnoozes', async () => {
    const conv = await seedConversation();
    await appendPart(db, {
      conversationId: conv.id,
      partType: 'snoozed',
      authorType: 'admin',
      authorId: 'user_admin_1',
      snoozedUntil: new Date(Date.now() + 3600_000),
    });
    const { conversation } = await appendReplyPart(db, {
      conversationId: conv.id,
      messageType: 'comment',
      authorType: 'user',
      body: 'hello?',
    });
    expect(conversation.state).toBe('open');
  });

  it('notes never unsnooze regardless of author', async () => {
    const conv = await seedConversation();
    await appendPart(db, {
      conversationId: conv.id,
      partType: 'assignment',
      authorType: 'admin',
      authorId: 'user_admin_1',
      assignedToType: 'admin',
      assignedToId: 'user_admin_1',
    });
    await appendPart(db, {
      conversationId: conv.id,
      partType: 'snoozed',
      authorType: 'admin',
      authorId: 'user_admin_1',
      snoozedUntil: new Date(Date.now() + 3600_000),
    });
    const { conversation } = await appendReplyPart(db, {
      conversationId: conv.id,
      messageType: 'note',
      authorType: 'admin',
      authorId: 'user_admin_2',
      body: 'internal note while snoozed',
    });
    expect(conversation.state).toBe('snoozed');
  });

  it('maybeTimerUnsnooze flips state to open once snoozedUntil has passed', async () => {
    const conv = await seedConversation();
    await appendPart(db, {
      conversationId: conv.id,
      partType: 'snoozed',
      authorType: 'admin',
      authorId: 'user_admin_1',
      snoozedUntil: new Date(Date.now() - 1000), // already in the past
    });
    const [row] = await db
      .select()
      .from(schema.deskConversations)
      .where(eq(schema.deskConversations.id, conv.id))
      .limit(1);
    const resolved = await maybeTimerUnsnooze(db, row!);
    expect(resolved.state).toBe('open');
    expect(resolved.snoozedUntil).toBeNull();
  });

  it('maybeTimerUnsnooze is a no-op while snoozedUntil is still in the future', async () => {
    const conv = await seedConversation();
    const { conversation: snoozed } = await appendPart(db, {
      conversationId: conv.id,
      partType: 'snoozed',
      authorType: 'admin',
      authorId: 'user_admin_1',
      snoozedUntil: new Date(Date.now() + 3600_000),
    });
    const resolved = await maybeTimerUnsnooze(db, snoozed);
    expect(resolved.state).toBe('snoozed');
  });
});
