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
import { SEQUENCE_RESUME_EVENT } from '@weldsuite/crm-domain/workflows/execute-sequence';

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

  // ==========================================================================
  // Pause / resume of in-flight enrollments
  // ==========================================================================

  async function enrollmentRow(enrollmentId: string) {
    const [row] = await db
      .select()
      .from(schema.sequenceEnrollments)
      .where(eq(schema.sequenceEnrollments.id, enrollmentId))
      .limit(1);
    return row!;
  }

  async function sequenceStatus(sequenceId: string) {
    const [row] = await db
      .select({ status: schema.workflows.status })
      .from(schema.workflows)
      .where(eq(schema.workflows.id, sequenceId))
      .limit(1);
    return row?.status;
  }

  /** A binding whose instances accept events, so the routes can wake parked runs. */
  function bindingWithInstances() {
    const sendEvent = vi.fn(async () => {});
    const binding = fakeBinding({ get: vi.fn(async (id: string) => ({ id, sendEvent })) });
    return { binding, sendEvent };
  }

  async function launched(status: 'active' | 'paused' = 'active') {
    const sequenceId = await insertSequence({ steps: STEP, status });
    const enrollmentId = await insertEnrollment(sequenceId, 'active');
    // As if the workflow had been started for it.
    await db
      .update(schema.sequenceEnrollments)
      .set({ executionId: enrollmentId })
      .where(eq(schema.sequenceEnrollments.id, enrollmentId));
    return { sequenceId, enrollmentId };
  }

  it('POST /:id/pause pauses the sequence AND its active enrollments, leaving pending ones alone', async () => {
    const { sequenceId, enrollmentId } = await launched();
    const pendingId = await insertEnrollment(sequenceId, 'pending');
    const { binding } = bindingWithInstances();
    const { request } = appWith(binding, 'contacts:update');

    const res = await request(`/api/sequences/${sequenceId}/pause`, { method: 'POST' });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { data: { paused: boolean; pausedEnrollments: number } }).data).toEqual({
      paused: true,
      pausedEnrollments: 1,
    });

    expect(await sequenceStatus(sequenceId)).toBe('paused');
    const paused = await enrollmentRow(enrollmentId);
    expect(paused.status).toBe('paused');
    expect(paused.pausedAt).toBeInstanceOf(Date);
    // The run is kept (it parks itself), not replaced: no new instance is created.
    expect(paused.executionId).toBe(enrollmentId);
    expect(binding.create).not.toHaveBeenCalled();
    expect((await enrollmentRow(pendingId)).status).toBe('pending');
  });

  it('POST /:id/pause only touches the sequence it was called for', async () => {
    const mine = await launched();
    const other = await launched();
    const { request } = appWith(bindingWithInstances().binding, 'contacts:update');

    await request(`/api/sequences/${mine.sequenceId}/pause`, { method: 'POST' });

    expect((await enrollmentRow(mine.enrollmentId)).status).toBe('paused');
    expect((await enrollmentRow(other.enrollmentId)).status).toBe('active');
    expect(await sequenceStatus(other.sequenceId)).toBe('active');
  });

  it('POST /:id/resume reactivates paused enrollments and wakes their parked runs without starting new ones', async () => {
    const { sequenceId, enrollmentId } = await launched();
    const { binding, sendEvent } = bindingWithInstances();
    const { request } = appWith(binding, 'contacts:update');

    await request(`/api/sequences/${sequenceId}/pause`, { method: 'POST' });
    const res = await request(`/api/sequences/${sequenceId}/resume`, { method: 'POST' });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { data: { resumedEnrollments: number } }).data.resumedEnrollments).toBe(1);

    expect(await sequenceStatus(sequenceId)).toBe('active');
    const resumed = await enrollmentRow(enrollmentId);
    expect(resumed.status).toBe('active');
    expect(resumed.pausedAt).toBeNull();
    expect(binding.get).toHaveBeenCalledWith(enrollmentId);
    expect(sendEvent).toHaveBeenCalledWith({ type: SEQUENCE_RESUME_EVENT, payload: {} });
    // The same run continues: no second instance for the enrollment.
    expect(binding.create).not.toHaveBeenCalled();
  });

  it('POST /:id/resume still succeeds when a parked run cannot be woken', async () => {
    const { sequenceId, enrollmentId } = await launched();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // default fake binding: get() throws instance.not_found
    const { request } = appWith(fakeBinding(), 'contacts:update');

    await request(`/api/sequences/${sequenceId}/pause`, { method: 'POST' });
    const res = await request(`/api/sequences/${sequenceId}/resume`, { method: 'POST' });
    warn.mockRestore();

    expect(res.status).toBe(200);
    expect((await enrollmentRow(enrollmentId)).status).toBe('active');
  });

  it('POST /:id/launch on a running sequence leaves a deliberately paused person paused', async () => {
    const { sequenceId, enrollmentId } = await launched();
    const { binding, sendEvent } = bindingWithInstances();
    const { request } = appWith(binding, 'contacts:update');
    await db
      .update(schema.sequenceEnrollments)
      .set({ status: 'paused', pausedAt: new Date() })
      .where(eq(schema.sequenceEnrollments.id, enrollmentId));

    const res = await request(`/api/sequences/${sequenceId}/launch`, { method: 'POST' });
    expect(res.status).toBe(200);
    expect((await enrollmentRow(enrollmentId)).status).toBe('paused');
    expect(sendEvent).not.toHaveBeenCalled();
  });

  it('PATCH enrollment pause/resume flips one person and wakes their run', async () => {
    const { sequenceId, enrollmentId } = await launched();
    const { binding, sendEvent } = bindingWithInstances();
    const { request } = appWith(binding, 'contacts:update');

    const pause = await request(`/api/sequences/${sequenceId}/enrollments/${enrollmentId}/pause`, { method: 'PATCH' });
    expect(pause.status).toBe(200);
    expect((await enrollmentRow(enrollmentId)).status).toBe('paused');
    expect(await sequenceStatus(sequenceId)).toBe('active');

    const resume = await request(`/api/sequences/${sequenceId}/enrollments/${enrollmentId}/resume`, { method: 'PATCH' });
    expect(resume.status).toBe(200);
    const row = await enrollmentRow(enrollmentId);
    expect(row.status).toBe('active');
    expect(row.pausedAt).toBeNull();
    expect(sendEvent).toHaveBeenCalledTimes(1);
    expect(binding.create).not.toHaveBeenCalled();
  });

  it('PATCH enrollment pause/resume refuse an enrollment in the wrong state', async () => {
    const { sequenceId, enrollmentId } = await launched();
    const { request } = appWith(bindingWithInstances().binding, 'contacts:update');

    // Not paused yet: nothing to resume.
    const early = await request(`/api/sequences/${sequenceId}/enrollments/${enrollmentId}/resume`, { method: 'PATCH' });
    expect(early.status).toBe(409);

    await db
      .update(schema.sequenceEnrollments)
      .set({ status: 'completed' })
      .where(eq(schema.sequenceEnrollments.id, enrollmentId));
    const late = await request(`/api/sequences/${sequenceId}/enrollments/${enrollmentId}/pause`, { method: 'PATCH' });
    expect(late.status).toBe(409);
    expect((await enrollmentRow(enrollmentId)).status).toBe('completed');
  });

  it('PATCH enrollment resume is refused while the whole sequence is paused', async () => {
    const { sequenceId, enrollmentId } = await launched();
    const { request } = appWith(bindingWithInstances().binding, 'contacts:update');
    await request(`/api/sequences/${sequenceId}/pause`, { method: 'POST' });

    const res = await request(`/api/sequences/${sequenceId}/enrollments/${enrollmentId}/resume`, { method: 'PATCH' });
    expect(res.status).toBe(409);
    expect((await enrollmentRow(enrollmentId)).status).toBe('paused');
  });

  it('PATCH enrollment resume starts a run for an enrollment that never had one', async () => {
    const sequenceId = await insertSequence({ steps: STEP, status: 'active' });
    const enrollmentId = await insertEnrollment(sequenceId, 'active');
    await db
      .update(schema.sequenceEnrollments)
      .set({ status: 'paused', pausedAt: new Date() })
      .where(eq(schema.sequenceEnrollments.id, enrollmentId));
    const binding = fakeBinding();
    const { request } = appWith(binding, 'contacts:update');

    const res = await request(`/api/sequences/${sequenceId}/enrollments/${enrollmentId}/resume`, { method: 'PATCH' });
    expect(res.status).toBe(200);
    expect(binding.create).toHaveBeenCalledTimes(1);
    expect(await executionIdOf(enrollmentId)).toBe(enrollmentId);
  });

  it('DELETE enrollment unenrolls and wakes a run parked on a pause', async () => {
    const { sequenceId, enrollmentId } = await launched();
    const { binding, sendEvent } = bindingWithInstances();
    const { request } = appWith(binding, 'contacts:update');
    await request(`/api/sequences/${sequenceId}/pause`, { method: 'POST' });

    const res = await request(`/api/sequences/enrollments/${enrollmentId}`, { method: 'DELETE' });
    expect(res.status).toBe(204);
    const row = await enrollmentRow(enrollmentId);
    expect(row.status).toBe('unenrolled');
    expect(row.unenrolledAt).toBeInstanceOf(Date);
    expect(sendEvent).toHaveBeenCalledTimes(1);
  });

  // ==========================================================================
  // Enroll: one pass, bounded fan-out
  // ==========================================================================

  it('POST /:id/enroll stores the sequence step count on every new enrollment', async () => {
    const sequenceId = await insertSequence({ steps: [...STEP, ...STEP] });
    const a = await insertPerson({ email: 'a@e2e.test' });
    const b = await insertPerson({ email: 'b@e2e.test' });
    const { request } = appWith(fakeBinding(), 'contacts:create');

    const res = await request(`/api/sequences/${sequenceId}/enroll`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ personIds: [a, b] }),
    });
    const body = (await res.json()) as { data: { enrolled: number; enrollmentIds: string[] } };
    expect(body.data.enrolled).toBe(2);
    for (const id of body.data.enrollmentIds) {
      const row = await enrollmentRow(id);
      expect(row.status).toBe('pending');
      expect(row.totalSteps).toBe(2);
    }
  });

  it('POST /:id/enroll on an active sequence starts every run exactly once, in a single claim pass', async () => {
    const sequenceId = await insertSequence({ steps: STEP, status: 'active' });
    const personIds: string[] = [];
    for (let i = 0; i < 25; i += 1) personIds.push(await insertPerson({ email: `bulk${i}@e2e.test` }));
    const binding = fakeBinding();
    const { request } = appWith(binding, 'contacts:create');

    const res = await request(`/api/sequences/${sequenceId}/enroll`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ personIds }),
    });
    const body = (await res.json()) as { data: { enrolled: number; enrollmentIds: string[] } };
    expect(body.data.enrolled).toBe(25);
    expect(binding.create).toHaveBeenCalledTimes(25);
    const createdIds = binding.create.mock.calls.map((call) => (call[0] as { id: string }).id);
    expect(new Set(createdIds)).toEqual(new Set(body.data.enrollmentIds));
    for (const id of body.data.enrollmentIds) expect(await executionIdOf(id)).toBe(id);
  });

  it('POST /:id/enroll does not fail the call (or double-start) when a run cannot be created', async () => {
    const sequenceId = await insertSequence({ steps: STEP, status: 'active' });
    const personIds = [await insertPerson({ email: 'x1@e2e.test' }), await insertPerson({ email: 'x2@e2e.test' })];
    let calls = 0;
    const binding = fakeBinding({
      create: vi.fn(async () => {
        calls += 1;
        if (calls === 1) throw new Error('boom');
        return { id: 'ok' };
      }),
    });
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { request } = appWith(binding, 'contacts:create');

    const res = await request(`/api/sequences/${sequenceId}/enroll`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ personIds }),
    });
    errSpy.mockRestore();
    const body = (await res.json()) as { data: { enrolled: number; enrollmentIds: string[] } };
    expect(res.status).toBe(200);
    expect(body.data.enrolled).toBe(2);

    const claimed = await Promise.all(body.data.enrollmentIds.map((id) => executionIdOf(id)));
    // exactly one claim was released (the failed create), the other kept
    expect(claimed.filter((id) => id === null)).toHaveLength(1);
    expect(claimed.filter((id) => id !== null)).toHaveLength(1);
  });

  it('GET /:id/enrollments reports the sequence step count as totalSteps (legacy rows stored 0)', async () => {
    const sequenceId = await insertSequence({ steps: [...STEP, ...STEP, ...STEP], status: 'active' });
    await insertEnrollment(sequenceId, 'active'); // inserted with the column default, 0
    const { request } = appWith(fakeBinding(), 'contacts:read');

    const res = await request(`/api/sequences/${sequenceId}/enrollments`);
    const body = (await res.json()) as { data: Array<{ totalSteps: number }> };
    expect(body.data).toHaveLength(1);
    expect(body.data[0]!.totalSteps).toBe(3);
  });
});
