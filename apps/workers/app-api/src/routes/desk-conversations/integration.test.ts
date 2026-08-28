/**
 * DB-backed integration tests for /api/desk/conversations and /api/desk/widget.
 *
 * Inbox and chat-widget settings hit these exact paths; a SQL mismatch
 * (missing column, bad ORDER BY) is a 500 in the platform SPA.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { deskConversationsRoutes } from './index';
import { deskWidgetRoutes } from '../desk-widget';
import { createTestApp, permissions } from '../../test/harness';
import { createPgliteDb } from '../../test/pglite';
import { schema, type Database } from '../../db';
import { createDeskConversation, ingestDeskEmail } from '@weldsuite/db/lib/desk';
import { generateId } from '../../lib/id';

let db: Database;

beforeAll(async () => {
  const handle = await createPgliteDb();
  db = handle.db;
}, 60_000);

describe('/api/desk/conversations · pglite integration', () => {
  it('GET /?state=open&sort=newest returns 200 against an empty tenant', async () => {
    const { request } = createTestApp('/api/desk/conversations', deskConversationsRoutes, {
      context: { permissions: permissions('conversations:read'), tenantDb: db },
    });

    const res = await request('/api/desk/conversations?state=open&sort=newest');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: unknown[];
      pagination: { totalCount: number; hasMore: boolean; cursor: string | null };
    };
    expect(body.data).toEqual([]);
    expect(body.pagination.totalCount).toBe(0);
    expect(body.pagination.hasMore).toBe(false);
  });

  it('GET / lists a seeded open conversation newest-first', async () => {
    await db.insert(schema.deskVisitors).values({
      id: 'visitor_list_seed',
      createdAt: new Date(),
      updatedAt: new Date(),
      lastSeenAt: new Date(),
      name: 'Ada',
      email: 'ada@example.test',
    });

    const { conversation } = await createDeskConversation(db, {
      generateId,
      visitorId: 'visitor_list_seed',
      name: 'Ada',
      email: 'ada@example.test',
      body: 'Hello from the widget',
    });

    const { request } = createTestApp('/api/desk/conversations', deskConversationsRoutes, {
      context: { permissions: permissions('conversations:read'), tenantDb: db },
    });

    const res = await request('/api/desk/conversations?state=open&sort=newest');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Array<{ id: string; lastMessagePreview: string | null }> };
    expect(body.data.some((row) => row.id === conversation.id)).toBe(true);
    const listed = body.data.find((row) => row.id === conversation.id);
    expect(listed?.lastMessagePreview).toBe('Hello from the widget');
  });
});

describe('ingestDeskEmail · pglite', () => {
  it('creates an email-channel conversation and threads a reply by Message-ID', async () => {
    const first = await ingestDeskEmail(db, {
      generateId,
      fromName: 'Ada',
      fromEmail: 'ada@customer.test',
      toAddress: 'support@acme.test',
      subject: 'Printer is jammed',
      body: 'The lobby printer will not feed paper.',
      rfcMessageId: 'root-msg-1@customer.test',
    });

    expect(first.created).toBe(true);
    expect(first.conversation.channel).toBe('email');
    expect(first.conversation.email).toBe('ada@customer.test');
    expect(first.conversation.title).toBe('Printer is jammed');

    const reply = await ingestDeskEmail(db, {
      generateId,
      fromName: 'Ada',
      fromEmail: 'ada@customer.test',
      toAddress: 'support@acme.test',
      subject: 'Re: Printer is jammed',
      body: 'It is still jammed.',
      rfcMessageId: 'reply-msg-2@customer.test',
      inReplyTo: 'root-msg-1@customer.test',
    });

    expect(reply.created).toBe(false);
    expect(reply.conversation.id).toBe(first.conversation.id);
    expect(reply.message.body).toBe('It is still jammed.');
  });
});

describe('/api/desk/widget · pglite integration', () => {
  it('GET / returns 200 with an empty list (no trailing slash)', async () => {
    const { request } = createTestApp('/api/desk/widget', deskWidgetRoutes, {
      context: { permissions: permissions('settings:read'), tenantDb: db },
    });

    const res = await request('/api/desk/widget');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: unknown[] };
    expect(Array.isArray(body.data)).toBe(true);
  });
});
