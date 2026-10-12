import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeDb } from '../test/fake-db';
import type { Env } from '../index';

const mocks = vi.hoisted(() => ({
  listActiveLicencesForReset: vi.fn(),
  resetLicensedCredits: vi.fn(),
  partnerIdsWithLicences: vi.fn(),
  snapshotSeats: vi.fn(),
  runPartnerStatement: vi.fn(),
  runDunningSweep: vi.fn(),
}));

vi.mock('@weldsuite/core-domain/partners', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@weldsuite/core-domain/partners')>()),
  listActiveLicencesForReset: mocks.listActiveLicencesForReset,
  resetLicensedCredits: mocks.resetLicensedCredits,
  partnerIdsWithLicences: mocks.partnerIdsWithLicences,
  snapshotSeats: mocks.snapshotSeats,
}));
vi.mock('./partner-billing', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./partner-billing')>()),
  runPartnerStatement: mocks.runPartnerStatement,
}));
vi.mock('./partner-dunning', () => ({ runDunningSweep: mocks.runDunningSweep }));

const { partnerSweepSchedule, resetPartnerCredits, runMonthlyStatements, runPartnerSweeps } = await import('./partner-sweep');

const env = {} as Env;

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

describe('partnerSweepSchedule', () => {
  it('runs the daily jobs only in the 02:xx UTC hour', () => {
    expect(partnerSweepSchedule(new Date('2026-10-14T02:17:00Z')).daily).toBe(true);
    expect(partnerSweepSchedule(new Date('2026-10-14T01:17:00Z')).daily).toBe(false);
    expect(partnerSweepSchedule(new Date('2026-10-14T03:17:00Z')).daily).toBe(false);
  });

  it('runs the statement run at 03:xx UTC on days 1 to 3 only', () => {
    expect(partnerSweepSchedule(new Date('2026-11-01T03:17:00Z')).monthly).toBe(true);
    expect(partnerSweepSchedule(new Date('2026-11-03T03:17:00Z')).monthly).toBe(true);
    expect(partnerSweepSchedule(new Date('2026-11-04T03:17:00Z')).monthly).toBe(false);
    expect(partnerSweepSchedule(new Date('2026-11-01T02:17:00Z')).monthly).toBe(false);
    expect(partnerSweepSchedule(new Date('2026-11-01T04:17:00Z')).monthly).toBe(false);
  });

  it('is the same on the 1st of any month, in UTC', () => {
    // 23:30 on Oct 31 UTC is already Nov 1 in many timezones, but not in UTC.
    expect(partnerSweepSchedule(new Date('2026-10-31T23:30:00Z'))).toEqual({ daily: false, monthly: false });
  });
});

describe('resetPartnerCredits', () => {
  it('resets every active licence for the current UTC month and counts the no-ops', async () => {
    mocks.listActiveLicencesForReset.mockResolvedValue([
      { workspaceId: 'ws_1', clerkOrgId: 'org_1', monthlyCredits: 1000, creditRolloverCap: 0 },
      { workspaceId: 'ws_2', clerkOrgId: 'org_2', monthlyCredits: 500, creditRolloverCap: 100 },
      { workspaceId: 'ws_3', clerkOrgId: 'org_3', monthlyCredits: 500, creditRolloverCap: 0 },
    ]);
    mocks.resetLicensedCredits
      .mockResolvedValueOnce({ expired: 0, granted: 1000, skipped: false })
      .mockResolvedValueOnce({ expired: 0, granted: 0, skipped: true })
      .mockRejectedValueOnce(new Error('db down'));
    const { db } = createFakeDb();

    const result = await resetPartnerCredits(db, new Date('2026-10-14T02:17:00Z'));

    expect(result).toEqual({ licences: 3, reset: 1, skipped: 1, failed: 1 });
    expect(mocks.resetLicensedCredits).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: 'ws_2',
        monthlyCredits: 500,
        creditRolloverCap: 100,
        periodStart: new Date('2026-10-01T00:00:00Z'),
        periodEnd: new Date('2026-11-01T00:00:00Z'),
      }),
    );
  });
});

describe('runMonthlyStatements', () => {
  const now = new Date('2026-11-01T03:17:00Z');

  it('runs the previous month for each partner with licences, keyed per partner and month', async () => {
    mocks.partnerIdsWithLicences.mockResolvedValue(['ptr_a']);
    mocks.runPartnerStatement.mockResolvedValue({ action: 'invoiced', statement: { id: 'pst_1', totalDue: '300.00', stripeInvoiceId: 'in_1' } });
    const { db } = createFakeDb({ selects: [[]] });

    const result = await runMonthlyStatements(env, db, now);

    expect(result).toMatchObject({ period: '2026-10', partners: 1, invoiced: 1, failed: 0 });
    expect(mocks.runPartnerStatement).toHaveBeenCalledWith(
      env,
      db,
      expect.objectContaining({
        partnerId: 'ptr_a',
        keyBase: 'cron:ptr_a:2026-10',
        reopenVoided: false,
        period: { start: new Date('2026-10-01T00:00:00Z'), end: new Date('2026-11-01T00:00:00Z') },
      }),
    );
  });

  it('skips partners whose statement is already invoiced, paid or void, or settled at zero (catch-up days)', async () => {
    mocks.partnerIdsWithLicences.mockResolvedValue(['ptr_a', 'ptr_b', 'ptr_c', 'ptr_d']);
    const { db } = createFakeDb({
      selects: [
        [{ status: 'invoiced', totalDue: '10.00' }],
        [{ status: 'paid', totalDue: '10.00' }],
        [{ status: 'void', totalDue: '10.00' }],
        [{ status: 'final', totalDue: '0.00' }],
      ],
    });
    const result = await runMonthlyStatements(env, db, new Date('2026-11-02T03:17:00Z'));
    expect(result).toMatchObject({ partners: 4, skipped: 4, invoiced: 0 });
    expect(mocks.runPartnerStatement).not.toHaveBeenCalled();
  });

  it('retries a final statement that never got its invoice', async () => {
    mocks.partnerIdsWithLicences.mockResolvedValue(['ptr_a']);
    mocks.runPartnerStatement.mockResolvedValue({ action: 'invoiced', statement: { id: 'pst_1', totalDue: '75.00', stripeInvoiceId: 'in_2' } });
    const { db } = createFakeDb({ selects: [[{ status: 'final', totalDue: '75.00' }]] });
    const result = await runMonthlyStatements(env, db, new Date('2026-11-02T03:17:00Z'));
    expect(result.invoiced).toBe(1);
  });

  it("isolates a partner's failure and records it in the audit trail", async () => {
    mocks.partnerIdsWithLicences.mockResolvedValue(['ptr_a', 'ptr_b']);
    mocks.runPartnerStatement
      .mockRejectedValueOnce(new Error('This partner has no contract for the period'))
      .mockResolvedValueOnce({ action: 'finalized_no_charge', statement: { id: 'pst_2' } });
    const { db, written } = createFakeDb({ selects: [[], []] });

    const result = await runMonthlyStatements(env, db, now);

    expect(result).toMatchObject({ failed: 1, noCharge: 1 });
    const audit = written('insert') as Array<{ action: string; outcome: string; targetType: string; targetId: string; error?: string }>;
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ action: 'statement.invoiced', outcome: 'failure', targetType: 'partner', targetId: 'ptr_a' });
    expect(audit[0]!.error).toContain('no contract');
  });
});

describe('runPartnerSweeps', () => {
  it('does nothing outside the scheduled hours', async () => {
    const result = await runPartnerSweeps(env, new Date('2026-10-14T12:17:00Z'), createFakeDb().db);
    expect(result).toEqual({ daily: false, monthly: false });
    expect(mocks.snapshotSeats).not.toHaveBeenCalled();
    expect(mocks.runDunningSweep).not.toHaveBeenCalled();
  });

  it('runs seat snapshots, credit reset and dunning at 02:xx, each surviving the others failing', async () => {
    mocks.snapshotSeats.mockRejectedValue(new Error('boom'));
    mocks.listActiveLicencesForReset.mockResolvedValue([]);
    mocks.runDunningSweep.mockResolvedValue({ partners: 1, statusChanged: 0, emailed: 0, failed: 0 });
    const db = createFakeDb().db;

    const result = await runPartnerSweeps(env, new Date('2026-10-14T02:17:00Z'), db);

    expect(result.daily).toBe(true);
    expect(result.seatSnapshots).toBeUndefined();
    expect(result.credits).toEqual({ licences: 0, reset: 0, skipped: 0, failed: 0 });
    expect(result.dunning).toMatchObject({ partners: 1 });
    expect(mocks.runDunningSweep).toHaveBeenCalledWith(env, db, new Date('2026-10-14T02:17:00Z'));
  });

  it('runs only the statement run at 03:xx on the 1st', async () => {
    mocks.partnerIdsWithLicences.mockResolvedValue([]);
    const result = await runPartnerSweeps(env, new Date('2026-11-01T03:17:00Z'), createFakeDb().db);
    expect(result).toMatchObject({ daily: false, monthly: true, statements: { period: '2026-10', partners: 0 } });
    expect(mocks.snapshotSeats).not.toHaveBeenCalled();
  });
});
