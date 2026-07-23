/**
 * pglite-backed tests for the Phase-2 listConversations filters:
 * `createdById` ("created by you" inbox) and `mentionedUserId` (note
 * @mentions stored in part.metadata.mentionUserIds).
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { createConversation, listConversations } from './conversations';
import { appendReplyPart } from './parts';
import { createPgliteDb } from '../../test/pglite';
import type { Database } from '../../db';

let db: Database;

beforeAll(async () => {
  const handle = await createPgliteDb();
  db = handle.db;
}, 60_000);

describe('listConversations · createdById / mentionedUserId filters', () => {
  it('createdById returns only admin-initiated conversations authored by that user', async () => {
    const { conversation: mine } = await createConversation(db, {
      channel: 'messenger',
      deliveredAs: 'admin_initiated',
      body: 'Created by me',
      authorUserId: 'user_creator_a',
    });
    await createConversation(db, {
      channel: 'messenger',
      deliveredAs: 'admin_initiated',
      body: 'Created by someone else',
      authorUserId: 'user_creator_b',
    });
    // Customer-initiated conversations must never match createdById even if
    // authorId happens to collide (authorType='user', not 'admin').
    await createConversation(db, {
      channel: 'email',
      deliveredAs: 'customer_initiated',
      body: 'Customer wrote in',
      authorUserId: 'user_creator_a',
    });

    const result = await listConversations(db, { createdById: 'user_creator_a', limit: 25 });
    expect(result.data.some((c) => c.id === mine.id)).toBe(true);
    expect(result.data.every((c) => c.source.authorType === 'admin' && c.source.authorId === 'user_creator_a')).toBe(
      true,
    );
  });

  it('mentionedUserId returns conversations with a note part mentioning that user', async () => {
    const { conversation: mentioned } = await createConversation(db, {
      channel: 'messenger',
      deliveredAs: 'admin_initiated',
      body: 'Please review',
      authorUserId: 'user_admin_1',
    });
    await appendReplyPart(db, {
      conversationId: mentioned.id,
      messageType: 'note',
      authorType: 'admin',
      authorId: 'user_admin_1',
      body: 'Hey @bob can you check this?',
      metadata: { mentionUserIds: ['user_bob'] },
    });

    const { conversation: notMentioned } = await createConversation(db, {
      channel: 'messenger',
      deliveredAs: 'admin_initiated',
      body: 'Unrelated',
      authorUserId: 'user_admin_1',
    });
    await appendReplyPart(db, {
      conversationId: notMentioned.id,
      messageType: 'note',
      authorType: 'admin',
      authorId: 'user_admin_1',
      body: 'No mentions here',
    });

    const result = await listConversations(db, { mentionedUserId: 'user_bob', limit: 25 });
    expect(result.data.some((c) => c.id === mentioned.id)).toBe(true);
    expect(result.data.some((c) => c.id === notMentioned.id)).toBe(false);
  });

  it('mentionedUserId does not match a comment (only notes carry mentionUserIds)', async () => {
    const { conversation } = await createConversation(db, {
      channel: 'messenger',
      deliveredAs: 'customer_initiated',
      body: 'Customer message',
      authorUserId: 'user_customer_1',
    });
    // A plain comment reply — mentionUserIds is a note-only concept, so this
    // metadata (if ever present) must not satisfy the filter for comments.
    await appendReplyPart(db, {
      conversationId: conversation.id,
      messageType: 'comment',
      authorType: 'admin',
      authorId: 'user_admin_1',
      body: 'Reply to customer',
    });

    const result = await listConversations(db, { mentionedUserId: 'user_bob', limit: 25 });
    expect(result.data.some((c) => c.id === conversation.id)).toBe(false);
  });
});

describe('listConversations · cursor pagination', () => {
  it('pages through the full result set without overlap or gaps', async () => {
    const created: string[] = [];
    for (let i = 0; i < 5; i++) {
      const { conversation } = await createConversation(db, {
        channel: 'messenger',
        deliveredAs: 'admin_initiated',
        body: `Paged conversation ${i}`,
        authorUserId: 'user_pager',
      });
      created.push(conversation.id);
    }

    const seen: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const page = await listConversations(db, {
        createdById: 'user_pager',
        sort: 'oldest',
        limit: 2,
        cursor,
      });
      seen.push(...page.data.map((c) => c.id));
      cursor = page.cursor ?? undefined;
      pages++;
      expect(page.totalCount).toBe(5);
    } while (cursor && pages < 10);

    expect(pages).toBe(3);
    expect(seen).toHaveLength(5);
    expect(new Set(seen).size).toBe(5);
    expect(seen).toEqual(created); // oldest sort → creation order
  });

  it('ignores malformed cursors and starts from the top', async () => {
    const page = await listConversations(db, {
      createdById: 'user_pager',
      sort: 'oldest',
      limit: 2,
      cursor: 'garbage',
    });
    expect(page.data).toHaveLength(2);
    expect(page.cursor).toBe('o:2');
  });
});
