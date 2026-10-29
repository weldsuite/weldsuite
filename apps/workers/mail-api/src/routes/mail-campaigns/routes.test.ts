/**
 * /api/mail-campaigns against a pglite tenant DB: list and its filters, CRUD,
 * and the edits a finished campaign still allows.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { mailCampaignsRoutes } from './index';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import type { Database } from '@weldsuite/worker-kit/db';

let db: Database;

beforeAll(async () => {
  db = (await createPgliteDb()).db;
}, 60_000);

function api() {
  const { request } = createTestApp('/api/mail-campaigns', mailCampaignsRoutes, {
    context: {
      userId: 'user_camp',
      tenantDb: db,
      permissions: permissions('campaigns:read', 'campaigns:create', 'campaigns:update', 'campaigns:delete'),
    },
  });
  return (method: string, path: string, body?: unknown) =>
    request(`/api/mail-campaigns${path}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
}

const campaign = (name: string) => ({
  name,
  subject: 'Spring sale',
  htmlContent: '<p>Sale</p>',
  recipientList: {
    type: 'manual',
    emails: [{ email: 'a@example.com', name: 'A', extra: true }, { email: 'b@example.com' }],
    personIds: ['person_1'],
  },
  fromName: 'Acme',
  fromEmail: 'news@acme.test',
  scheduledAt: '2026-06-01T09:00:00Z',
  tags: ['spring'],
});

describe('mail campaigns', () => {
  it('creates, lists, edits and deletes', async () => {
    const call = api();
    const created = await call('POST', '', campaign('Spring'));
    expect(created.status).toBe(201);
    const id = ((await created.json()) as { data: { id: string } }).data.id;
    const sent = await call('POST', '', { ...campaign('Winter'), status: 'sent', trackOpens: false });
    const sentId = ((await sent.json()) as { data: { id: string } }).data.id;
    expect((await call('POST', '', { ...campaign('Bad'), fromEmail: 'nope' })).status).toBe(400);
    expect((await call('POST', '', { ...campaign('Bad'), recipientList: { type: 'csv', csvUrl: 'not a url' } })).status).toBe(400);
    expect((await call('POST', '', { ...campaign('Bad'), scheduledAt: 'tomorrow' })).status).toBe(400);

    for (const q of ['', '?status=sent', '?templateId=tpl_x', '?limit=1']) {
      expect((await call('GET', q)).status).toBe(200);
    }
    const first = await call('GET', '?limit=1');
    const cursor = ((await first.json()) as { pagination: { cursor: string } }).pagination.cursor;
    expect((await call('GET', `?limit=1&cursor=${cursor}`)).status).toBe(200);
    expect((await call('GET', '?status=lost')).status).toBe(400);
    expect((await call('GET', `/${id}`)).status).toBe(200);
    expect((await call('GET', '/camp_missing')).status).toBe(404);

    expect((await call('PATCH', `/${id}`, { name: 'Spring 2', recipientList: { type: 'segments', segmentIds: ['s1', 's2'] } })).status).toBe(200);
    expect((await call('PUT', `/${id}`, { scheduledAt: '2026-07-01T10:00:00Z', status: 'scheduled' })).status).toBe(200);
    expect((await call('PATCH', `/${sentId}`, { subject: 'Changed' })).status).toBe(409);
    expect((await call('PATCH', `/${sentId}`, { tags: ['done'], preheader: 'Thanks' })).status).toBe(200);
    expect((await call('PATCH', '/camp_missing', { name: 'x' })).status).toBe(404);

    expect((await call('DELETE', `/${id}`)).status).toBe(204);
    expect((await call('DELETE', `/${id}`)).status).toBe(404);
  });
});
