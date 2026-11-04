/**
 * The status_report_due sweep (ADR FLOW-018): drafts a report on the slot day
 * of a project's cadence, once per period, tells the project manager, and
 * answers when the next slot comes.
 */

import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { createPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { publishEntityEventRaw } from '@weldsuite/entity-events';
import type { Env } from '../types';
import { notifyDraftReady } from '../lib/report-notifications';
import { sweepStatusReports } from './status-report-sweep';

vi.mock('@weldsuite/entity-events', async () => {
  const actual = await vi.importActual<typeof import('@weldsuite/entity-events')>('@weldsuite/entity-events');
  return { ...actual, publishEntityEventRaw: vi.fn(async () => undefined) };
});

vi.mock('../lib/report-notifications', () => ({
  notifyDraftReady: vi.fn(async () => true),
  sendPublishedReport: vi.fn(),
  sendPortalInvitation: vi.fn(),
}));

let db: Database;
const env = {} as Env;
const ORG = 'org_sweep';

beforeAll(async () => {
  db = (await createPgliteDb()).db;
}, 60_000);

beforeEach(() => {
  vi.mocked(publishEntityEventRaw).mockClear();
  vi.mocked(notifyDraftReady).mockClear();
});

const weekly = { cadence: 'weekly' as const, weekday: 1, hour: 9, recipients: {} };

async function seedProject(id: string, extra: Partial<typeof schema.projects.$inferInsert> = {}) {
  await db.insert(schema.projects).values({ id, name: id, createdAt: new Date('2026-11-01T00:00:00.000Z'), updatedAt: new Date('2026-11-01T00:00:00.000Z'), projectManagerId: 'user_pm', settings: { statusReport: weekly }, ...extra });
}

const reportsOf = (projectId: string) => db.select().from(schema.projectStatusReports).where(eq(schema.projectStatusReports.projectId, projectId));

describe('sweepStatusReports', () => {
  it('drafts the report of the latest slot, once, and answers the next slot', async () => {
    await seedProject('prj_sw_a');
    // Monday 9 November, 03:30 UTC: the slot day. The report is about week 45.
    const now = new Date('2026-11-09T03:30:00.000Z');
    const next = await sweepStatusReports(env, db, ORG, now);
    expect(next?.toISOString()).toBe('2026-11-16T00:00:00.000Z');

    const rows = await reportsOf('prj_sw_a');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ period: '2026-W45', status: 'draft', createdBy: 'system', summary: null });
    expect(rows[0]?.snapshot?.asOf).toBe(now.toISOString());
    expect(publishEntityEventRaw).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: ORG, userId: 'system', entityType: 'project_status_report', action: 'created', entityId: rows[0]?.id }),
    );
    expect(notifyDraftReady).toHaveBeenCalledTimes(1);

    // The same tick again, or the next day: nothing new.
    await sweepStatusReports(env, db, ORG, now);
    await sweepStatusReports(env, db, ORG, new Date('2026-11-10T03:30:00.000Z'));
    expect(await reportsOf('prj_sw_a')).toHaveLength(1);
    expect(vi.mocked(notifyDraftReady)).toHaveBeenCalledTimes(1);
  });

  it('does not redraft a period whose draft was discarded', async () => {
    await seedProject('prj_sw_deleted');
    await sweepStatusReports(env, db, ORG, new Date('2026-11-09T03:30:00.000Z'));
    await db.update(schema.projectStatusReports).set({ deletedAt: new Date() }).where(eq(schema.projectStatusReports.projectId, 'prj_sw_deleted'));
    await sweepStatusReports(env, db, ORG, new Date('2026-11-09T12:00:00.000Z'));
    expect(await reportsOf('prj_sw_deleted')).toHaveLength(1);
  });

  it('skips projects without a schedule, deleted ones and finished ones, and answers null when none is left', async () => {
    await seedProject('prj_sw_none', { settings: {} });
    await seedProject('prj_sw_gone', { deletedAt: new Date() });
    await seedProject('prj_sw_closed', { status: 'Closed' });
    await seedProject('prj_sw_done', { status: 'Completed' });
    const next = await sweepStatusReports(env, db, ORG, new Date('2026-11-09T03:30:00.000Z'));
    for (const id of ['prj_sw_none', 'prj_sw_gone', 'prj_sw_closed', 'prj_sw_done']) expect(await reportsOf(id)).toHaveLength(0);
    // The project of the first test still has its schedule, so the index keeps a due time.
    expect(next?.toISOString()).toBe('2026-11-16T00:00:00.000Z');
  });

  it('follows a monthly cadence, on the first working day, about the month before', async () => {
    await seedProject('prj_sw_month', { settings: { statusReport: { cadence: 'monthly', weekday: 1, hour: 9, recipients: {} } } });
    // Monday 3 August 2026 is the first working day (1 August is a Saturday).
    await sweepStatusReports(env, db, ORG, new Date('2026-08-03T03:30:00.000Z'));
    const rows = await reportsOf('prj_sw_month');
    expect(rows.map((row) => row.period)).toEqual(['2026-07']);
  });

  it('copies the stakeholders the schedule names into the draft', async () => {
    await seedProject('prj_sw_rec', { settings: { statusReport: { ...weekly, recipients: { stakeholderIds: ['stk_x'] } } } });
    await sweepStatusReports(env, db, ORG, new Date('2026-11-09T03:30:00.000Z'));
    expect((await reportsOf('prj_sw_rec'))[0]?.recipients).toEqual({ stakeholderIds: ['stk_x'] });
  });
});
