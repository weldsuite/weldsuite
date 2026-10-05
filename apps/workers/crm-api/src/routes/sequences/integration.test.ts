/**
 * DB-backed integration tests for /api/sequences/*, focused on the
 * TASK-912 regression: enroll must target People (`people.id`), not the
 * `parties` wrapper table most people never get a row in. Also covers the
 * /launch "launch checklist" gate (steps + at least one enrolled person)
 * added to keep the Sequences list row's "Activate" action from bypassing
 * it.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { eq, and } from 'drizzle-orm';
import { sequencesRoutes } from './index';
import { createTestApp, permissions } from '@weldsuite/worker-kit/testing';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { generateId } from '@weldsuite/worker-kit/id';
import { schema, type Database } from '@weldsuite/worker-kit/db';

let db: Database;

beforeAll(async () => {
  const handle = await createPgliteDb();
  db = handle.db;
}, 60_000);

async function insertSequence(overrides: Partial<typeof schema.workflows.$inferInsert> = {}) {
  const id = generateId('wf');
  const now = new Date();
  await db.insert(schema.workflows).values({
    id,
    name: 'Test sequence',
    status: 'draft',
    tags: ['__type:sequence'],
    steps: [],
    createdAt: now,
    updatedAt: now,
    ...overrides,
  });
  return id;
}

async function insertPerson(overrides: Partial<typeof schema.people.$inferInsert> = {}) {
  const id = generateId('person');
  const now = new Date();
  await db.insert(schema.people).values({
    id,
    displayName: 'Test Person',
    fullName: 'Test Person',
    email: 'test.person@e2e.test',
    createdAt: now,
    updatedAt: now,
    ...overrides,
  });
  return id;
}

describe('/api/sequences · pglite integration', () => {
  it('POST /:id/enroll enrolls a known person and ignores an unknown id', async () => {
    const sequenceId = await insertSequence();
    const personId = await insertPerson({ email: 'alice@e2e.test', fullName: 'Alice Example' });

    const { request } = createTestApp('/api/sequences', sequencesRoutes, {
      context: { permissions: permissions('contacts:create'), tenantDb: db },
    });

    const res = await request(`/api/sequences/${sequenceId}/enroll`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ personIds: [personId, 'person_does_not_exist'] }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { enrolled: number; enrollmentIds: string[] } };
    expect(body.data.enrolled).toBe(1);
    expect(body.data.enrollmentIds).toHaveLength(1);

    const [row] = await db
      .select()
      .from(schema.sequenceEnrollments)
      .where(eq(schema.sequenceEnrollments.id, body.data.enrollmentIds[0]!))
      .limit(1);
    expect(row?.customerId).toBe(personId);
    expect(row?.customerSnapshot?.email).toBe('alice@e2e.test');
    expect(row?.customerSnapshot?.fullName).toBe('Alice Example');
  });

  it('POST /:id/enroll still accepts the legacy customerIds field', async () => {
    const sequenceId = await insertSequence();
    const personId = await insertPerson();

    const { request } = createTestApp('/api/sequences', sequencesRoutes, {
      context: { permissions: permissions('contacts:create'), tenantDb: db },
    });

    const res = await request(`/api/sequences/${sequenceId}/enroll`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ customerIds: [personId] }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { enrolled: number } };
    expect(body.data.enrolled).toBe(1);
  });

  it('POST /:id/enroll rejects with 400 when no id matches a person (instead of a silent enrolled: 0)', async () => {
    const sequenceId = await insertSequence();

    const { request } = createTestApp('/api/sequences', sequencesRoutes, {
      context: { permissions: permissions('contacts:create'), tenantDb: db },
    });

    const res = await request(`/api/sequences/${sequenceId}/enroll`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ personIds: ['person_does_not_exist'] }),
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toMatch(/no matching people/i);
  });

  it('POST /:id/enroll is idempotent: re-enrolling an already-enrolled person returns enrolled: 0, not an error', async () => {
    const sequenceId = await insertSequence();
    const personId = await insertPerson();

    const { request } = createTestApp('/api/sequences', sequencesRoutes, {
      context: { permissions: permissions('contacts:create'), tenantDb: db },
    });

    await request(`/api/sequences/${sequenceId}/enroll`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ personIds: [personId] }),
    });
    const res = await request(`/api/sequences/${sequenceId}/enroll`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ personIds: [personId] }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { enrolled: number } };
    expect(body.data.enrolled).toBe(0);
  });

  it('GET /:id/enrollments lists the enrolled person with their snapshot email', async () => {
    const sequenceId = await insertSequence();
    const personId = await insertPerson({ email: 'bob@e2e.test', displayName: 'Bob Example' });

    const { request } = createTestApp('/api/sequences', sequencesRoutes, {
      context: { permissions: permissions('contacts:create', 'contacts:read'), tenantDb: db },
    });

    await request(`/api/sequences/${sequenceId}/enroll`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ personIds: [personId] }),
    });

    const res = await request(`/api/sequences/${sequenceId}/enrollments`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Array<{ customerId: string; customerEmail: string | null; customerFullName: string | null }> };
    expect(body.data).toHaveLength(1);
    expect(body.data[0]?.customerId).toBe(personId);
    expect(body.data[0]?.customerEmail).toBe('bob@e2e.test');
  });

  it('POST /:id/launch rejects a sequence with no steps', async () => {
    const sequenceId = await insertSequence({ steps: [] });
    const personId = await insertPerson();
    await db.insert(schema.sequenceEnrollments).values({
      id: generateId('senr'),
      sequenceId,
      customerId: personId,
      counterpartyId: personId,
      status: 'pending',
      enrolledAt: new Date(),
    });

    const { request } = createTestApp('/api/sequences', sequencesRoutes, {
      context: { permissions: permissions('contacts:update'), tenantDb: db },
    });

    const res = await request(`/api/sequences/${sequenceId}/launch`, { method: 'POST' });
    expect(res.status).toBe(400);
  });

  it('POST /:id/launch rejects a sequence with no enrollments', async () => {
    const sequenceId = await insertSequence({
      steps: [{ id: 'step1', type: 'send_email', name: 'Send email', config: {}, inputs: {} }],
    });

    const { request } = createTestApp('/api/sequences', sequencesRoutes, {
      context: { permissions: permissions('contacts:update'), tenantDb: db },
    });

    const res = await request(`/api/sequences/${sequenceId}/launch`, { method: 'POST' });
    expect(res.status).toBe(400);
  });

  it('POST /:id/launch activates a sequence that has both a step and an enrollment', async () => {
    const sequenceId = await insertSequence({
      steps: [{ id: 'step1', type: 'send_email', name: 'Send email', config: {}, inputs: {} }],
    });
    const personId = await insertPerson();
    await db.insert(schema.sequenceEnrollments).values({
      id: generateId('senr'),
      sequenceId,
      customerId: personId,
      counterpartyId: personId,
      status: 'pending',
      enrolledAt: new Date(),
    });

    const { request } = createTestApp('/api/sequences', sequencesRoutes, {
      context: { permissions: permissions('contacts:update'), tenantDb: db },
    });

    const res = await request(`/api/sequences/${sequenceId}/launch`, { method: 'POST' });
    expect(res.status).toBe(200);

    const [workflow] = await db
      .select({ status: schema.workflows.status })
      .from(schema.workflows)
      .where(eq(schema.workflows.id, sequenceId))
      .limit(1);
    expect(workflow?.status).toBe('active');

    const [enrollment] = await db
      .select({ status: schema.sequenceEnrollments.status })
      .from(schema.sequenceEnrollments)
      .where(
        and(
          eq(schema.sequenceEnrollments.sequenceId, sequenceId),
          eq(schema.sequenceEnrollments.customerId, personId),
        ),
      )
      .limit(1);
    expect(enrollment?.status).toBe('active');
  });
});
