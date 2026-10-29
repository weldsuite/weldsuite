/**
 * The /api/sequences and /api/customer-sequences paths the main integration
 * test leaves out: paging, filters, the enroll body's validation, the 404s
 * and 409s, the refusals, and a person's sequences. Runs against the Rust
 * backend in conformance.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { customerSequencesRoutes, sequencesRoutes } from './index';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';

let db: Database;
const at = (minute: number) => new Date(Date.UTC(2026, 0, 1, 9, minute));
const STEP = [
  { id: 's1', name: 'Email', type: 'send_email', config: { to: '{{contact.email}}' } },
] as unknown as (typeof schema.workflows.$inferInsert)['steps'];

beforeAll(async () => {
  db = (await createPgliteDb()).db;
  await db.insert(schema.workflows).values([
    { id: 'wf_alpha', name: 'Alpha outreach', description: 'first', status: 'active', tags: ['__type:sequence'], steps: STEP, createdAt: at(1), updatedAt: at(1) },
    { id: 'wf_beta', name: 'Beta nurture', status: 'paused', tags: ['__type:sequence'], steps: STEP, createdAt: at(2), updatedAt: at(2) },
    { id: 'wf_gamma', name: 'Gamma', status: 'draft', tags: ['__type:sequence'], steps: [], createdAt: at(3), updatedAt: at(3) },
    { id: 'wf_plain', name: 'Not a sequence', status: 'active', tags: [], steps: [], createdAt: at(4), updatedAt: at(4) },
  ]);
  await db.insert(schema.people).values([
    { id: 'person_ann', firstName: 'Ann', lastName: 'Lee', displayName: 'Ann Lee', email: 'ann@x.test', primaryAddress: { city: 'Ghent' }, createdAt: at(1), updatedAt: at(1) },
    { id: 'person_bob', firstName: 'Bob', displayName: 'Bob', email: 'bob@x.test', mobilePhone: '+3200', createdAt: at(1), updatedAt: at(1) },
    { id: 'person_gone', displayName: 'Gone', deletedAt: at(2), createdAt: at(1), updatedAt: at(1) },
  ]);
  await db.insert(schema.companies).values({ id: 'company_acme', name: 'Acme', displayName: 'Acme', createdAt: at(1), updatedAt: at(1) });
  await db.insert(schema.personCompanies).values({ id: 'pc_1', personId: 'person_ann', companyId: 'company_acme', isPrimary: true, createdAt: at(1), updatedAt: at(1) });
  await db.insert(schema.sequenceEnrollments).values([
    { id: 'senr_a1', sequenceId: 'wf_alpha', customerId: 'person_ann', counterpartyId: 'person_ann', status: 'active', enrolledAt: at(5), customerSnapshot: { email: 'ann@x.test', companyName: 'Acme' } },
    { id: 'senr_a2', sequenceId: 'wf_alpha', customerId: 'person_bob', counterpartyId: 'person_bob', status: 'completed', enrolledAt: at(6), completedAt: at(7) },
    { id: 'senr_b1', sequenceId: 'wf_beta', customerId: 'person_ann', counterpartyId: 'person_ann', status: 'paused', enrolledAt: at(8) },
    { id: 'senr_b2', sequenceId: 'wf_beta', customerId: 'person_bob', counterpartyId: 'person_bob', status: 'failed', enrolledAt: at(9), errorMessage: 'boom' },
  ]);
}, 60_000);

const ALL = ['contacts:read', 'contacts:create', 'contacts:update'];

function sequences(...keys: string[]) {
  return createTestApp('/api/sequences', sequencesRoutes, {
    context: { permissions: permissions(...(keys.length ? keys : ALL)), tenantDb: db },
  });
}
function customerSequences(...keys: string[]) {
  return createTestApp('/api/customer-sequences', customerSequencesRoutes, {
    context: { permissions: permissions(...(keys.length ? keys : ALL)), tenantDb: db },
  });
}
const post = (body: unknown) => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

describe('/api/sequences · more routes', () => {
  it('lists, searches and pages sequences', async () => {
    const first = await sequences().request('/api/sequences?limit=2');
    const page = (await first.json()) as { data: { id: string }[]; pagination: { cursor: string; totalCount: number } };
    expect(page.data.map((s) => s.id)).toEqual(['wf_gamma', 'wf_beta']);
    expect(page.pagination.totalCount).toBe(3);
    expect((await sequences().request(`/api/sequences?limit=2&cursor=${page.pagination.cursor}`)).status).toBe(200);
    expect((await sequences().request('/api/sequences?cursor=wf_missing')).status).toBe(200);
    expect((await sequences().request('/api/sequences?search=nurture')).status).toBe(200);
    expect((await sequences().request('/api/sequences?search=first&limit=500')).status).toBe(200);
    // Drizzle leaves out a LIMIT that is NaN or negative.
    const unlimited = await sequences().request('/api/sequences?limit=abc');
    expect(((await unlimited.json()) as { data: unknown[] }).data).toHaveLength(3);
    expect((await sequences().request('/api/sequences?limit=-1')).status).toBe(200);
    expect((await sequences().request('/api/sequences?limit=-2')).status).toBe(200);
    expect((await sequences().request('/api/sequences/wf_alpha/enrollments?limit=x')).status).toBe(200);
  });

  it('reads a sequence and its enrollments with filters and paging', async () => {
    expect((await sequences().request('/api/sequences/wf_alpha')).status).toBe(200);
    expect((await sequences().request('/api/sequences/wf_missing')).status).toBe(404);
    const list = await sequences().request('/api/sequences/wf_alpha/enrollments?limit=1');
    const body = (await list.json()) as { pagination: { cursor: string } };
    expect((await sequences().request(`/api/sequences/wf_alpha/enrollments?limit=1&cursor=${body.pagination.cursor}`)).status).toBe(200);
    expect((await sequences().request('/api/sequences/wf_alpha/enrollments?status=completed')).status).toBe(200);
    expect((await sequences().request('/api/sequences/wf_alpha/enrollments?search=Ann')).status).toBe(200);
    expect((await sequences().request('/api/sequences/wf_missing/enrollments')).status).toBe(200);
  });

  it('validates the enroll body', async () => {
    const app = sequences();
    expect((await app.request('/api/sequences/wf_gamma/enroll', post({}))).status).toBe(400);
    expect((await app.request('/api/sequences/wf_gamma/enroll', post({ personIds: [] }))).status).toBe(400);
    expect((await app.request('/api/sequences/wf_gamma/enroll', post({ personIds: 'person_ann' }))).status).toBe(400);
    expect((await app.request('/api/sequences/wf_gamma/enroll', post({ personIds: [1], customerIds: [] }))).status).toBe(400);
    expect((await app.request('/api/sequences/wf_gamma/enroll', post([])))).toHaveProperty('status', 400);
    expect((await app.request('/api/sequences/wf_missing/enroll', post({ personIds: ['person_ann'] }))).status).toBe(404);
    expect((await app.request('/api/sequences/wf_gamma/enroll', post({ personIds: ['person_gone', 'person_nobody'] }))).status).toBe(400);
  });

  it('enrolls into a draft with snapshots, once', async () => {
    const app = sequences();
    const res = await app.request('/api/sequences/wf_gamma/enroll', post({ personIds: ['person_ann', 'person_bob', 'person_ann'], customerIds: ['person_gone'] }));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { data: { enrolled: number } }).data.enrolled).toBe(2);
    expect((await app.request('/api/sequences/wf_gamma/enroll', post({ customerIds: ['person_bob'] }))).status).toBe(200);
  });

  it('answers 404 and 409 for missing or mismatched sequences and enrollments', async () => {
    const app = sequences();
    expect((await app.request('/api/sequences/wf_missing/launch', { method: 'POST' })).status).toBe(404);
    expect((await app.request('/api/sequences/wf_gamma/launch', { method: 'POST' })).status).toBe(400);
    expect((await app.request('/api/sequences/wf_missing/start', { method: 'POST' })).status).toBe(404);
    expect((await app.request('/api/sequences/wf_missing/pause', { method: 'POST' })).status).toBe(404);
    expect((await app.request('/api/sequences/wf_alpha/enrollments/senr_missing/pause', { method: 'PATCH' })).status).toBe(404);
    expect((await app.request('/api/sequences/wf_alpha/enrollments/senr_a2/pause', { method: 'PATCH' })).status).toBe(409);
    expect((await app.request('/api/sequences/wf_alpha/enrollments/senr_a1/resume', { method: 'PATCH' })).status).toBe(409);
    expect((await app.request('/api/sequences/wf_beta/enrollments/senr_b1/resume', { method: 'PATCH' })).status).toBe(409);
    expect((await app.request('/api/sequences/wf_missing/enrollments/senr_b1/resume', { method: 'PATCH' })).status).toBe(404);
    expect((await app.request('/api/sequences/enrollments/senr_missing', { method: 'DELETE' })).status).toBe(404);
    expect((await app.request('/api/sequences/enrollments/senr_b2', { method: 'DELETE' })).status).toBe(204);
  });

  it('pauses a running sequence without a Workflow binding', async () => {
    const app = sequences();
    expect((await app.request('/api/sequences/wf_alpha/pause', { method: 'POST' })).status).toBe(200);
    expect((await app.request('/api/sequences/wf_alpha/resume', { method: 'POST' })).status).toBe(200);
    expect((await app.request('/api/sequences/wf_alpha/start', { method: 'POST' })).status).toBe(200);
  });

  it('refuses without the permission', async () => {
    const reader = sequences('contacts:read');
    expect((await reader.request('/api/sequences/wf_alpha/enroll', post({ personIds: ['person_ann'] }))).status).toBe(403);
    expect((await reader.request('/api/sequences/wf_alpha/launch', { method: 'POST' })).status).toBe(403);
    expect((await reader.request('/api/sequences/enrollments/senr_a1', { method: 'DELETE' })).status).toBe(403);
    expect((await sequences('contacts:update').request('/api/sequences')).status).toBe(403);
    expect((await customerSequences('contacts:update').request('/api/customer-sequences/person_ann')).status).toBe(403);
  });
});

describe('/api/customer-sequences', () => {
  it("lists a person's sequences", async () => {
    const res = await customerSequences().request('/api/customer-sequences/person_ann');
    expect(res.status).toBe(200);
    expect(((await res.json()) as { data: unknown[] }).data.length).toBeGreaterThan(0);
    expect((await customerSequences().request('/api/customer-sequences/person_ann?limit=1')).status).toBe(200);
    expect((await customerSequences().request('/api/customer-sequences/person_nobody')).status).toBe(200);
    expect((await customerSequences().request('/api/customer-sequences/person_ann?limit=-3')).status).toBe(200);
  });
});
