/**
 * DB-backed integration tests for /api/helpdesk-faqs.
 *
 * Uses the `articles:*` permission set — FAQs are a kind of help
 * article. Same permission gate as the knowledge-base routes.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { helpdeskFaqsRoutes } from './index';
import { createTestApp, permissions } from '../../test/harness';
import { createPgliteDb } from '../../test/pglite';
import { schema, type Database } from '../../db';

let db: Database;

beforeAll(async () => {
  const handle = await createPgliteDb();
  db = handle.db;
}, 60_000);

describe('/api/helpdesk-faqs · pglite integration', () => {
  it('POST / writes a FAQ row', async () => {
    const { request } = createTestApp('/api/helpdesk-faqs', helpdeskFaqsRoutes, {
      context: { permissions: permissions('articles:create'), tenantDb: db },
    });

    const res = await request('/api/helpdesk-faqs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        question: 'How do I reset my password?',
        answer: 'Click "Forgot password" on the login screen.',
        category: 'Account',
      }),
    });

    expect(res.status).toBe(201);
    const body = (await res.json()) as { data: { id: string } };
    expect(body.data.id).toBeTruthy();

    const [row] = await db
      .select()
      .from(schema.helpdeskFaqs)
      .where(eq(schema.helpdeskFaqs.id, body.data.id))
      .limit(1);
    expect(row?.question).toBe('How do I reset my password?');
    expect(row?.answer).toContain('Forgot password');
    expect(row?.isPublished).toBe(false); // default
  });

  it('POST / rejects empty question', async () => {
    const { request } = createTestApp('/api/helpdesk-faqs', helpdeskFaqsRoutes, {
      context: { permissions: permissions('articles:create'), tenantDb: db },
    });
    const res = await request('/api/helpdesk-faqs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question: '', answer: 'X' }),
    });
    expect(res.status).toBe(400);
  });
});
