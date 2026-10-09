/**
 * DB-backed integration tests for /api/sequences/*, focused on the
 * TASK-912 regression: enroll must target People (`people.id`), not the
 * `parties` wrapper table most people never get a row in. Also covers the
 * /launch "launch checklist" gate (steps + at least one enrolled person)
 * added to keep the Sequences list row's "Activate" action from bypassing
 * it.
 */

import { describe, it, expect, beforeAll, vi } from 'vitest';
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

  // ==========================================================================
  // TASK-941 / TASK-942: workflow trigger bookkeeping, resume, counts
  // ==========================================================================

  const STEP = [{ id: 'step1', type: 'send_email', name: 'Send email', config: {}, inputs: {} }];

  async function insertEnrollment(sequenceId: string, status: 'pending' | 'active' = 'pending') {
    const personId = await insertPerson({ email: `${generateId('p')}@e2e.test` });
    const id = generateId('senr');
    await db.insert(schema.sequenceEnrollments).values({
      id,
      sequenceId,
      customerId: personId,
      counterpartyId: personId,
      status,
      enrolledAt: new Date(),
    });
    return id;
  }

  async function executionIdOf(enrollmentId: string) {
    const [row] = await db
      .select({ executionId: schema.sequenceEnrollments.executionId })
      .from(schema.sequenceEnrollments)
      .where(eq(schema.sequenceEnrollments.id, enrollmentId))
      .limit(1);
    return row?.executionId ?? null;
  }

  /** Mimics the Workflows binding, whose real instance ids are 36-char UUIDs. */
  function fakeBinding(overrides: { create?: ReturnType<typeof vi.fn>; get?: ReturnType<typeof vi.fn> } = {}) {
    const create =
      overrides.create ??
      vi.fn(async (opts?: { id?: string }) => ({ id: opts?.id ?? '11111111-2222-3333-4444-555555555555' }));
    const get = overrides.get ?? vi.fn(async () => { throw new Error('instance.not_found'); });
    return { create, get };
  }

  function appWith(binding: ReturnType<typeof fakeBinding>, ...perms: string[]) {
    return createTestApp('/api/sequences', sequencesRoutes, {
      context: { permissions: permissions(...perms), tenantDb: db },
      env: { EXECUTE_SEQUENCE: binding as unknown as never },
    });
  }

  it('POST /:id/launch returns 200, passes a column-sized id to the workflow and stores it (TASK-941)', async () => {
    const sequenceId = await insertSequence({ steps: STEP });
    const enrollmentId = await insertEnrollment(sequenceId);
    const binding = fakeBinding();
    const { request } = appWith(binding, 'contacts:update');

    const res = await request(`/api/sequences/${sequenceId}/launch`, { method: 'POST' });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { data: { activated: number } }).data.activated).toBe(1);

    expect(binding.create).toHaveBeenCalledTimes(1);
    const arg = binding.create.mock.calls[0]![0] as { id: string; params: { enrollmentId: string } };
    expect(arg.id.length).toBeLessThanOrEqual(30);
    expect(arg.params.enrollmentId).toBe(enrollmentId);
    expect(await executionIdOf(enrollmentId)).toBe(arg.id);
  });

  it('never triggers a second run for the same enrollment (launch twice, then start)', async () => {
    const sequenceId = await insertSequence({ steps: STEP });
    await insertEnrollment(sequenceId);
    const binding = fakeBinding();
    const { request } = appWith(binding, 'contacts:update');

    expect((await request(`/api/sequences/${sequenceId}/launch`, { method: 'POST' })).status).toBe(200);
    expect((await request(`/api/sequences/${sequenceId}/launch`, { method: 'POST' })).status).toBe(200);
    const start = await request(`/api/sequences/${sequenceId}/start`, { method: 'POST' });
    expect(start.status).toBe(200);
    expect(((await start.json()) as { data: { triggered: number } }).data.triggered).toBe(0);

    expect(binding.create).toHaveBeenCalledTimes(1);
  });

  it('releases the claim when the workflow cannot be created, so /start can retry', async () => {
    const sequenceId = await insertSequence({ steps: STEP });
    const enrollmentId = await insertEnrollment(sequenceId);
    const failing = fakeBinding({ create: vi.fn(async () => { throw new Error('boom'); }) });
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const first = await appWith(failing, 'contacts:update').request(`/api/sequences/${sequenceId}/launch`, { method: 'POST' });
    errSpy.mockRestore();
    expect(first.status).toBe(200);
    expect(await executionIdOf(enrollmentId)).toBeNull();

    const working = fakeBinding();
    const start = await appWith(working, 'contacts:update').request(`/api/sequences/${sequenceId}/start`, { method: 'POST' });
    expect(((await start.json()) as { data: { triggered: number } }).data.triggered).toBe(1);
    expect(working.create).toHaveBeenCalledTimes(1);
    expect(await executionIdOf(enrollmentId)).not.toBeNull();
  });

  it('keeps the claim when create fails but the instance already exists', async () => {
    const sequenceId = await insertSequence({ steps: STEP });
    const enrollmentId = await insertEnrollment(sequenceId);
    const binding = fakeBinding({
      create: vi.fn(async () => { throw new Error('instance.already_exists'); }),
      get: vi.fn(async () => ({ id: enrollmentId })),
    });
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await appWith(binding, 'contacts:update').request(`/api/sequences/${sequenceId}/launch`, { method: 'POST' });
    errSpy.mockRestore();
    expect(res.status).toBe(200);
    expect(await executionIdOf(enrollmentId)).toBe(enrollmentId);
  });

  it('POST /:id/enroll on an active sequence starts the run and stores a column-sized id', async () => {
    const sequenceId = await insertSequence({ steps: STEP, status: 'active' });
    const personId = await insertPerson();
    const binding = fakeBinding();
    const { request } = appWith(binding, 'contacts:create');

    const res = await request(`/api/sequences/${sequenceId}/enroll`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ personIds: [personId] }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { enrollmentIds: string[] } };
    expect(binding.create).toHaveBeenCalledTimes(1);
    expect((await executionIdOf(body.data.enrollmentIds[0]!))!.length).toBeLessThanOrEqual(30);
  });

  it('POST /:id/resume sets a paused sequence active and starts its pending enrollments (TASK-942)', async () => {
    const sequenceId = await insertSequence({ steps: STEP, status: 'paused' });
    const enrollmentId = await insertEnrollment(sequenceId, 'pending');
    const binding = fakeBinding();
    const { request } = appWith(binding, 'contacts:update');

    const res = await request(`/api/sequences/${sequenceId}/resume`, { method: 'POST' });
    expect(res.status).toBe(200);

    const [workflow] = await db
      .select({ status: schema.workflows.status })
      .from(schema.workflows)
      .where(eq(schema.workflows.id, sequenceId))
      .limit(1);
    expect(workflow?.status).toBe('active');
    expect(binding.create).toHaveBeenCalledTimes(1);
    expect(await executionIdOf(enrollmentId)).not.toBeNull();
  });

  it('POST /:id/resume 404s for an unknown sequence', async () => {
    const { request } = appWith(fakeBinding(), 'contacts:update');
    const res = await request('/api/sequences/wf_missing/resume', { method: 'POST' });
    expect(res.status).toBe(404);
  });

  it('GET / and GET /:id report real enrollment counts and last-run data (TASK-942)', async () => {
    const sequenceId = await insertSequence({
      steps: STEP,
      status: 'active',
      executionCount: 3,
      lastExecutedAt: new Date('2026-01-02T03:04:05Z'),
    });
    await insertEnrollment(sequenceId, 'active');
    await insertEnrollment(sequenceId, 'active');
    await insertEnrollment(sequenceId, 'pending');

    const { request } = appWith(fakeBinding(), 'contacts:read');

    const listRes = await request('/api/sequences?limit=100');
    expect(listRes.status).toBe(200);
    const listBody = (await listRes.json()) as {
      data: Array<{ id: string; enrolledCount: number; activeEnrolledCount: number; pendingEnrolledCount: number; executionCount: number; lastExecutedAt: string | null }>;
    };
    const row = listBody.data.find((r) => r.id === sequenceId)!;
    expect(row.enrolledCount).toBe(3);
    expect(row.activeEnrolledCount).toBe(2);
    expect(row.pendingEnrolledCount).toBe(1);
    expect(row.executionCount).toBe(3);
    expect(row.lastExecutedAt).toBeTruthy();

    const detailRes = await request(`/api/sequences/${sequenceId}`);
    const detail = ((await detailRes.json()) as { data: { enrolledCount: number; activeEnrolledCount: number; pendingEnrolledCount: number } }).data;
    expect(detail).toMatchObject({ enrolledCount: 3, activeEnrolledCount: 2, pendingEnrolledCount: 1 });
  });
});
