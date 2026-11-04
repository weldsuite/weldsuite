/**
 * An approved change is applied once (FLOW-012), and a rejected one is recorded
 * once, however many final answers settle it at the same time: the settlement
 * claims the change first, and only the claimant writes.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { and, eq, isNull } from 'drizzle-orm';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { applyApprovedChange, recordRejectedChange } from '@weldsuite/flow-domain/changes';

let db: Database;

beforeAll(async () => {
  db = (await createPgliteDb()).db;
}, 60_000);

const NOW = new Date('2026-11-04T10:00:00.000Z');

async function seed(projectId: string, status = 'awaiting_approval') {
  await db.insert(schema.projects).values({
    id: projectId,
    name: projectId,
    projectManagerId: 'user_once_pm',
    budgetedAmount: '1000.00',
    budgetCurrency: 'EUR',
    createdAt: NOW,
    updatedAt: NOW,
  });
  const id = `chg_${projectId}`;
  await db.insert(schema.projectChangeRequests).values({
    id,
    projectId,
    number: 1,
    title: 'More scope',
    status: status as 'awaiting_approval',
    costDelta: '250.00',
    scopeChanges: { add: [{ title: 'Extra deliverable' }] },
    route: 'manager',
    submittedAt: NOW,
    createdBy: 'user_once_pm',
    createdAt: NOW,
    updatedAt: NOW,
  });
  return id;
}

const decisionsOf = (projectId: string) => db.select().from(schema.projectDecisions).where(eq(schema.projectDecisions.projectId, projectId));
const deliverablesOf = (projectId: string) =>
  db.select().from(schema.projectDeliverables).where(and(eq(schema.projectDeliverables.projectId, projectId), isNull(schema.projectDeliverables.deletedAt)));

describe('settling a change request', () => {
  it('applies an approved change once when two final answers arrive together', async () => {
    const id = await seed('prj_once_apply');
    const results = await Promise.all([
      applyApprovedChange(db, id, { actorId: 'user_once_pm', now: NOW }),
      applyApprovedChange(db, id, { actorId: 'user_once_pm', now: NOW }),
    ]);
    expect(results.map((r) => r.outcome).sort()).toEqual(['applied', 'skipped']);
    expect(await deliverablesOf('prj_once_apply')).toHaveLength(1);
    expect(await decisionsOf('prj_once_apply')).toHaveLength(1);
    const [project] = await db.select().from(schema.projects).where(eq(schema.projects.id, 'prj_once_apply'));
    expect(project?.budgetedAmount).toBe('1250.00');
    const [change] = await db.select().from(schema.projectChangeRequests).where(eq(schema.projectChangeRequests.id, id));
    expect(change).toMatchObject({ status: 'approved' });
    expect(change?.decidedAt).not.toBeNull();
    // A later call finds it settled and writes nothing.
    expect((await applyApprovedChange(db, id, { actorId: 'user_once_pm' })).outcome).toBe('skipped');
    expect(await decisionsOf('prj_once_apply')).toHaveLength(1);
  });

  it('records a rejected change once when two final answers arrive together', async () => {
    const id = await seed('prj_once_reject');
    const results = await Promise.all([
      recordRejectedChange(db, id, { actorId: 'user_once_pm', rows: [], now: NOW }),
      recordRejectedChange(db, id, { actorId: 'user_once_pm', rows: [], now: NOW }),
    ]);
    expect(results.map((r) => r.outcome).sort()).toEqual(['applied', 'skipped']);
    expect(await decisionsOf('prj_once_reject')).toHaveLength(1);
    const [change] = await db.select().from(schema.projectChangeRequests).where(eq(schema.projectChangeRequests.id, id));
    expect(change?.status).toBe('rejected');
  });

  it('leaves a change that is not waiting for approval alone, and does not keep a claim on it', async () => {
    const id = await seed('prj_once_draft', 'assessing');
    expect((await applyApprovedChange(db, id, { actorId: 'user_once_pm' })).outcome).toBe('skipped');
    const [change] = await db.select().from(schema.projectChangeRequests).where(eq(schema.projectChangeRequests.id, id));
    expect(change).toMatchObject({ status: 'assessing', decidedAt: null });
    expect(await decisionsOf('prj_once_draft')).toHaveLength(0);
  });

  it('releases its claim when the write fails, so the settlement can run again', async () => {
    const id = await seed('prj_once_fail');
    // A planned deliverable with an unusable owner cannot be written: break the batch on purpose.
    await db.update(schema.projectChangeRequests).set({ scopeChanges: { add: [{ title: 'x', ownerId: 'u'.repeat(400) }] } }).where(eq(schema.projectChangeRequests.id, id));
    await expect(applyApprovedChange(db, id, { actorId: 'user_once_pm' })).rejects.toThrow();
    const [change] = await db.select().from(schema.projectChangeRequests).where(eq(schema.projectChangeRequests.id, id));
    expect(change).toMatchObject({ status: 'awaiting_approval', decidedAt: null });
  });
});
