/**
 * The weekly finance snapshot of one workspace (cron/finance-snapshot.ts):
 * only projects with a baseline, one row per ISO week, the next due time.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { snapshotWorkspace } from './finance-snapshot';

let db: Database;

beforeAll(async () => {
  db = (await createPgliteDb()).db;
}, 60_000);

const T0 = new Date('2026-01-01T00:00:00.000Z');

async function seedProject(id: string, extra: Partial<typeof schema.projects.$inferInsert> = {}) {
  await db.insert(schema.projects).values({
    id,
    name: id,
    budgetedAmount: '1000.00',
    startDate: new Date('2026-01-01T00:00:00.000Z'),
    endDate: new Date('2026-12-31T00:00:00.000Z'),
    createdAt: T0,
    updatedAt: T0,
    ...extra,
  });
}

async function baseline(projectId: string) {
  await db.insert(schema.projectBaselines).values({
    id: `bl_${projectId}`,
    projectId,
    version: 1,
    snapshot: { goLive: '2026-12-31T00:00:00.000Z', milestones: [], deliverables: [], budgetedAmount: '1000.00', budgetedHours: null, budgetCurrency: null, scopeStatement: null },
    createdBy: 'user_1',
  });
}

describe('snapshotWorkspace', () => {
  it('snapshots only live, open projects with a baseline and replaces the same week', async () => {
    await seedProject('prj_fs_a');
    await baseline('prj_fs_a');
    await seedProject('prj_fs_nobase');
    await seedProject('prj_fs_closed', { status: 'Closed' });
    await baseline('prj_fs_closed');
    await seedProject('prj_fs_gone', { deletedAt: T0 });
    await baseline('prj_fs_gone');
    await db.insert(schema.timeEntries).values({ id: 'te_fs_1', projectId: 'prj_fs_a', userId: 'u', date: '2026-05-04', duration: '60', cost: '80.00', status: 'approved' });

    const monday = new Date('2026-06-01T03:30:00.000Z'); // ISO week 2026-W23
    const first = await snapshotWorkspace(db, monday);
    expect(first.written).toBe(1);
    expect(first.next?.toISOString()).toBe('2026-06-08T00:00:00.000Z');

    await db.insert(schema.timeEntries).values({ id: 'te_fs_2', projectId: 'prj_fs_a', userId: 'u', date: '2026-05-05', duration: '60', cost: '20.00', status: 'approved' });
    await snapshotWorkspace(db, new Date('2026-06-03T10:00:00.000Z'));
    const nextWeek = await snapshotWorkspace(db, new Date('2026-06-08T03:30:00.000Z'));
    expect(nextWeek.written).toBe(1);

    const rows = await db.select().from(schema.projectFinanceSnapshots).where(eq(schema.projectFinanceSnapshots.projectId, 'prj_fs_a')).orderBy(schema.projectFinanceSnapshots.week);
    expect(rows.map((r) => [r.week, r.budget, r.actualCost])).toEqual([
      ['2026-W23', '1000.00', '100.00'],
      ['2026-W24', '1000.00', '100.00'],
    ]);
    expect(await db.select().from(schema.projectFinanceSnapshots)).toHaveLength(2);
  });

  it('has no next due time when nothing qualifies', async () => {
    await db.delete(schema.projectBaselines);
    expect(await snapshotWorkspace(db, new Date('2026-06-01T03:30:00.000Z'))).toEqual({ written: 0, next: null });
  });
});
