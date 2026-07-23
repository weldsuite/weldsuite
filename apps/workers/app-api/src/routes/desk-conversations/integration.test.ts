/**
 * DB-backed integration tests for /api/desk/conversations — the HTTP surface
 * over services/desk/{conversations,parts}.ts. Service-level behavior
 * (statistics rollup, snooze matrix, etc.) is covered in
 * services/desk/parts-pglite.test.ts; this file just proves the routes wire
 * validation → service → response envelope correctly end to end.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { deskConversationsRoutes } from './index';
import { createTestApp, permissions } from '../../test/harness';
import { createPgliteDb } from '../../test/pglite';
import type { Database } from '../../db';

let db: Database;

beforeAll(async () => {
  const handle = await createPgliteDb();
  db = handle.db;
}, 60_000);

function app(perm: string) {
  return createTestApp('/api/desk/conversations', deskConversationsRoutes, {
    context: { permissions: permissions(perm), tenantDb: db },
  }).request;
}

describe('/api/desk/conversations · pglite integration', () => {
  it('POST / creates a conversation + initial comment part', async () => {
    const request = app('conversations:create');
    const res = await request('/api/desk/conversations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        channel: 'messenger',
        deliveredAs: 'admin_initiated',
        body: 'Hi there, how can we help?',
        subject: 'New support thread',
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { data: { id: string; conversationNumber: number; state: string } };
    expect(body.data.id).toMatch(/^dconv_/);
    expect(body.data.state).toBe('open');
    expect(body.data.conversationNumber).toBeGreaterThan(0);
  });

  it('GET /:id?include=parts returns the conversation with its parts timeline', async () => {
    const createRes = await app('conversations:create')('/api/desk/conversations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ channel: 'email', body: 'Ticket body' }),
    });
    const { data: created } = (await createRes.json()) as { data: { id: string } };

    const res = await app('conversations:read')(`/api/desk/conversations/${created.id}?include=parts`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { id: string; parts: Array<{ partType: string }> } };
    expect(body.data.parts.length).toBeGreaterThanOrEqual(1);
    expect(body.data.parts[0].partType).toBe('comment');
  });

  it('GET /:id returns 404 for a missing conversation', async () => {
    const res = await app('conversations:read')('/api/desk/conversations/dconv_missing');
    expect(res.status).toBe(404);
  });

  it('POST /:id/reply appends a note part without flipping state', async () => {
    const createRes = await app('conversations:create')('/api/desk/conversations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ channel: 'messenger', body: 'Need help' }),
    });
    const { data: created } = (await createRes.json()) as { data: { id: string } };

    const res = await app('conversations:update')(`/api/desk/conversations/${created.id}/reply`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messageType: 'note', body: 'internal note' }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { data: { conversation: { state: string }; part: { partType: string } } };
    expect(body.data.part.partType).toBe('note');
    expect(body.data.conversation.state).toBe('open');
  });

  it('POST /:id/manage close then open round-trips state', async () => {
    const createRes = await app('conversations:create')('/api/desk/conversations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ channel: 'messenger', body: 'Need help' }),
    });
    const { data: created } = (await createRes.json()) as { data: { id: string } };

    const closeRes = await app('conversations:update')(`/api/desk/conversations/${created.id}/manage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'close' }),
    });
    expect(closeRes.status).toBe(200);
    expect(((await closeRes.json()) as { data: { state: string } }).data.state).toBe('closed');

    const openRes = await app('conversations:update')(`/api/desk/conversations/${created.id}/manage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'open' }),
    });
    expect(openRes.status).toBe(200);
    expect(((await openRes.json()) as { data: { state: string } }).data.state).toBe('open');
  });

  it('POST /:id/tags then DELETE /:id/tags/:tag round-trips the tag list', async () => {
    const createRes = await app('conversations:create')('/api/desk/conversations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ channel: 'messenger', body: 'Need help' }),
    });
    const { data: created } = (await createRes.json()) as { data: { id: string } };

    const addRes = await app('conversations:update')(`/api/desk/conversations/${created.id}/tags`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tag: 'billing' }),
    });
    expect(addRes.status).toBe(200);
    expect(((await addRes.json()) as { data: { tags: string[] } }).data.tags).toContain('billing');

    const delRes = await app('conversations:update')(`/api/desk/conversations/${created.id}/tags/billing`, {
      method: 'DELETE',
    });
    expect(delRes.status).toBe(204);
  });

  it('POST /:id/rating writes conversationRating via a rating part', async () => {
    const createRes = await app('conversations:create')('/api/desk/conversations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ channel: 'messenger', body: 'Need help' }),
    });
    const { data: created } = (await createRes.json()) as { data: { id: string } };

    const res = await app('conversations:update')(`/api/desk/conversations/${created.id}/rating`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rating: 5, remark: 'Great support' }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { conversationRating: { rating: number; remark?: string } } };
    expect(body.data.conversationRating.rating).toBe(5);
    expect(body.data.conversationRating.remark).toBe('Great support');
  });

  it('GET / lists conversations with cursor pagination envelope', async () => {
    const res = await app('conversations:read')('/api/desk/conversations?limit=5');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: unknown[]; pagination: { totalCount: number; hasMore: boolean; cursor: string | null } };
    expect(Array.isArray(body.data)).toBe(true);
    expect(typeof body.pagination.totalCount).toBe('number');
  });
});
