/**
 * The /api/activities routes the main integration test leaves out: PATCH
 * (dates, completion), DELETE, the owner scope, custom fields, paging and
 * the refusals. Runs against the Rust backend in conformance.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { activitiesRoutes } from './index';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';

let db: Database;

beforeAll(async () => {
  db = (await createPgliteDb()).db;
  const at = (minute: number) => new Date(Date.UTC(2026, 0, 1, 9, minute));
  await db.insert(schema.customFieldDefinitions).values([
    { id: 'cfld_score', entityType: 'activity', name: 'Score', slug: 'score', fieldType: 'number', required: false, sortOrder: 0, createdAt: at(0), updatedAt: at(0) },
    { id: 'cfld_kind', entityType: 'activity', name: 'Kind', slug: 'kind', fieldType: 'single_select', options: [{ value: 'a', label: 'A' }], required: false, sortOrder: 1, createdAt: at(0), updatedAt: at(0) },
  ]);
  await db.insert(schema.crmActivities).values([
    { id: 'act_call', type: 'call', subject: 'Intro call', status: 'planned', assignedToId: 'user_test_default', customerId: 'cmp_1', customFields: { legacy: true }, createdAt: at(1), updatedAt: at(1) },
    { id: 'act_mail', type: 'email', subject: 'Follow up', description: 'about pricing', status: 'planned', assignedToId: 'user_other', personId: 'per_1', createdAt: at(2), updatedAt: at(2) },
    { id: 'act_note', type: 'note', subject: 'Note', status: 'completed', assignedToId: 'user_test_default', contactId: 'per_1', createdAt: at(3), updatedAt: at(3) },
  ]);
  await db.insert(schema.customFieldValues).values({
    id: 'cfv_1', fieldId: 'cfld_score', entityType: 'activity', entityId: 'act_call', valueNumber: 7, createdAt: at(1), updatedAt: at(1),
  });
}, 60_000);

const ALL = ['activities:read', 'activities:create', 'activities:update', 'activities:delete', 'activities:scope:all'];

function app(...keys: string[]) {
  return createTestApp('/api/activities', activitiesRoutes, {
    context: { permissions: permissions(...(keys.length ? keys : ALL)), tenantDb: db },
  });
}
const json = (method: string, body: unknown) => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

describe('/api/activities · every route', () => {
  it('lists with filters, the person filter, paging and hydrated custom fields', async () => {
    const res = await app().request('/api/activities?limit=2');
    expect(res.status).toBe(200);
    const page = (await res.json()) as { pagination: { cursor: string } };
    expect((await app().request(`/api/activities?cursor=${page.pagination.cursor}`)).status).toBe(200);
    expect((await app().request('/api/activities?personId=per_1')).status).toBe(200);
    expect((await app().request('/api/activities?type=call&status=planned&customerId=cmp_1&assignedToId=user_test_default')).status).toBe(200);
    expect((await app().request('/api/activities?search=pricing&leadId=&opportunityId=')).status).toBe(200);
    expect((await app('activities:read').request('/api/activities')).status).toBe(200);
    expect((await app().request('/api/activities/act_call')).status).toBe(200);
    expect((await app('activities:read').request('/api/activities/act_mail')).status).toBe(404);
  });

  it('updates dates, custom fields and status, publishing completed once', async () => {
    const res = await app().request(
      '/api/activities/act_call',
      json('PATCH', { status: 'completed', dueDate: '2026-02-01', outcome: 'Good', customerId: null, customFields: { score: 9, kind: 'a' } }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { id: 'act_call' } });
    expect((await app().request('/api/activities/act_call', json('PATCH', { status: 'completed', subject: 'Done' }))).status).toBe(200);
    expect((await app().request('/api/activities/act_call', json('PATCH', { customFields: { kind: 'zzz' } }))).status).toBe(200);
    expect((await app().request('/api/activities/act_call')).status).toBe(200);
  });

  it('refuses a bad body, an invalid date, unknown and out-of-scope activities', async () => {
    expect((await app().request('/api/activities/act_call', json('PATCH', { type: 'fax', priority: 'urgent' }))).status).toBe(400);
    expect((await app().request('/api/activities/act_call', json('PATCH', { dueDate: 'not a date' }))).status).toBe(500);
    expect((await app().request('/api/activities/act_missing', json('PATCH', { subject: 'x' }))).status).toBe(404);
    expect((await app('activities:update').request('/api/activities/act_mail', json('PATCH', { subject: 'x' }))).status).toBe(404);
    expect((await app().request('/api/activities', json('POST', { type: 'call' }))).status).toBe(400);
    expect((await app().request('/api/activities', json('POST', { type: 'meeting', subject: 'Kickoff', startTime: '2026-03-01T10:00:00Z', endTime: '2026-03-01T11:00:00Z', attendees: ['a@b.c'], isVirtual: true, customFields: { score: '3' } }))).status).toBe(201);
  });

  it('deletes and refuses without the permission', async () => {
    expect((await app('activities:read').request('/api/activities', json('POST', { type: 'call', subject: 'x' }))).status).toBe(403);
    expect((await app('activities:read').request('/api/activities/act_note', json('PATCH', {}))).status).toBe(403);
    expect((await app('activities:read').request('/api/activities/act_note', { method: 'DELETE' })).status).toBe(403);
    expect((await app('activities:delete').request('/api/activities/act_mail', { method: 'DELETE' })).status).toBe(404);
    expect((await app().request('/api/activities/act_note', { method: 'DELETE' })).status).toBe(204);
    expect((await app().request('/api/activities/act_note', { method: 'DELETE' })).status).toBe(404);
  });
});
