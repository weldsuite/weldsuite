/**
 * Regression tests for the review of the payroll backend: the year-to-date
 * chain at approval, the loonheffingen riding in one salary file, run state
 * guards, the people in an approved run, filing versions, identity edits from
 * self-service, the sealed bank account, double collection of hours, pay dates,
 * corrections across years, payslip numbers, the journal, CSV and corrections.
 */

import { eq } from 'drizzle-orm';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { betalingskenmerk } from '@weldsuite/payroll-domain/nl/loonaangifte';
import type { Database } from '@weldsuite/worker-kit/db';
import { schema } from '@weldsuite/worker-kit/db';
import { createPayrollDb, resetPayrollTables } from '../../../test/payroll-db';
import {
  TEST_KEYRING,
  VALID_BSN_2,
  VALID_IBAN,
  VALID_IBAN_2,
  VALID_ROUTING,
  VALID_SSN,
  createTestEmployee,
  fakeCalculate,
  nlWorld,
  testDeps,
  type NlWorld,
} from '../../../test/payroll-fixtures';
import { HrConflictError, HrValidationError } from '../shared';
import { approveRun } from './approve';
import { calculateRun } from './calculate';
import type { DigipoortGateway } from './deps';
import { createCompensation, createElection, myPayrollDetails, setPaymentDetails, upsertProfile } from './employees';
import { createEmployer, setEmployerBank } from './employers';
import { buildPaymentFile, buildRunReport } from './files';
import { filingFile, generateFiling, refreshFilingStatus, submitFiling } from './filings';
import { postRunJournal } from './journal';
import { cancelRun, collectRunInputs, createRun, createRunInput, getRunDetail, listRunInputs, requireRun, setRunEmployee, touchRun, updateRun } from './runs';
import { createSchedule } from './schedules';

let db: Database;
let world: NlWorld;
const prep = { userId: 'user_prep' };
const boss = { userId: 'user_boss' };
const mgr = { userId: 'user_mgr' };

beforeAll(async () => {
  db = await createPayrollDb();
}, 120_000);

beforeEach(async () => {
  await resetPayrollTables(db);
  world = await nlWorld(db);
});

type Deps = ReturnType<typeof testDeps>['deps'];

const monthRun = (periodStart: string) =>
  createRun(db, { employerId: world.employerId, kind: 'regular', payScheduleId: world.scheduleId, periodStart }, prep);

async function approveMonth(deps: Deps, periodStart: string) {
  const run = await monthRun(periodStart);
  await calculateRun(db, run.id, deps, prep);
  await approveRun(db, run.id, deps, boss);
  return run;
}

/** An off-cycle run for Eva inside a month, optionally with a bonus. */
async function offCycleRun(periodStart: string, periodEnd: string, payDate: string, bonus?: number, employeeIds = [world.eva.id]) {
  const run = await createRun(db, { employerId: world.employerId, kind: 'off_cycle', periodStart, periodEnd, payDate, employeeIds }, prep);
  if (bonus) await createRunInput(db, run.id, { employeeId: employeeIds[0]!, code: 'bonus', amount: bonus }, prep);
  return run;
}

const filingOf = async (period: number) =>
  (await db.select().from(schema.hrPayrollFilings)).find((f) => f.kind === 'nl_loonaangifte' && f.period === period)!;

const slipsOf = (runId: string) => db.select().from(schema.hrPayslips).where(eq(schema.hrPayslips.runId, runId));

// ---------------------------------------------------------------------------
// H1: the year-to-date chain
// ---------------------------------------------------------------------------

describe('H1: approving checks the year-to-date chain is still current', () => {
  it('refuses a second run of the month that was calculated from the same tip, until it is calculated again', async () => {
    const { deps } = testDeps();
    const regular = await monthRun('2026-07-01');
    const bonus = await offCycleRun('2026-07-01', '2026-07-31', '2026-07-31', 100);
    await calculateRun(db, regular.id, deps, prep);
    await calculateRun(db, bonus.id, deps, prep);

    await approveRun(db, regular.id, deps, boss);
    await expect(approveRun(db, bonus.id, deps, boss)).rejects.toMatchObject({
      code: 'RECALCULATE_REQUIRED',
      status: 409,
      details: { reason: 'ytd_changed', employeeIds: [world.eva.id] },
    });
    // Nothing was finalised and the run is still the calculated one.
    expect((await requireRun(db, bonus.id)).status).toBe('calculated');
    expect((await slipsOf(bonus.id)).every((s) => s.status === 'draft')).toBe(true);

    await calculateRun(db, bonus.id, deps, prep);
    await expect(approveRun(db, bonus.id, deps, boss)).resolves.toBeDefined();
    // The chain continues: the bonus payslip started from what the regular payslip left.
    const [slip] = await slipsOf(bonus.id);
    expect((slip!.snapshot as { input: { ytd: Record<string, number> } }).input.ytd['gross']).toBe(300_000);
    expect(slip!.ytd['gross']).toBe(300_000 + 310_000);
  });

  it('also catches a correction approved in between', async () => {
    const { deps } = testDeps();
    const july = await approveMonth(deps, '2026-07-01');
    const first = await createRun(db, { employerId: world.employerId, kind: 'correction', correctsRunId: july.id, employeeIds: [world.eva.id], payDate: '2026-08-05' }, prep);
    await createRunInput(db, first.id, { employeeId: world.eva.id, code: 'bonus', amount: 100 }, prep);
    await calculateRun(db, first.id, deps, prep);
    // A regular August run calculated from the same tip as the correction.
    const august = await monthRun('2026-08-01');
    await calculateRun(db, august.id, deps, prep);
    await approveRun(db, first.id, deps, boss);
    await expect(approveRun(db, august.id, deps, boss)).rejects.toMatchObject({ code: 'RECALCULATE_REQUIRED', details: { reason: 'ytd_changed' } });
  });
});

// ---------------------------------------------------------------------------
// H2: the loonheffingen ride in one salary file
// ---------------------------------------------------------------------------

describe('H2: last month\'s loonheffingen ride in exactly one salary file', () => {
  const reference = betalingskenmerk({ loonheffingennummer: '123456789L01', taxYear: 2026, month: 7 });

  it('carries them in the first file built, again in that file, and not in another run of the same month', async () => {
    const { deps, calls } = testDeps();
    await approveMonth(deps, '2026-07-01');
    await generateFiling(db, (await filingOf(7)).id, deps, mgr);
    const august = await approveMonth(deps, '2026-08-01');
    const extra = await offCycleRun('2026-08-01', '2026-08-31', '2026-08-28', 100);
    await calculateRun(db, extra.id, deps, prep);
    await approveRun(db, extra.id, deps, boss);

    await buildPaymentFile(db, august.id, deps);
    expect(calls.sepa.at(-1)!.tax).toEqual({ amountCents: 60_000, betalingskenmerk: reference });
    await buildPaymentFile(db, extra.id, deps);
    expect(calls.sepa.at(-1)!.tax).toBeNull();
    // Downloading the first file again gives the same file.
    await buildPaymentFile(db, august.id, deps);
    expect(calls.sepa.at(-1)!.tax).toEqual({ amountCents: 60_000, betalingskenmerk: reference });
    expect((await filingOf(7)).taxPayments).toEqual([{ runId: august.id, version: 1, cents: 60_000, reference }]);
  });

  it('carries nothing while a correction has reopened the return, then only what the earlier file did not', async () => {
    const { deps, calls } = testDeps();
    const july = await approveMonth(deps, '2026-07-01');
    await generateFiling(db, (await filingOf(7)).id, deps, mgr);
    const august = await approveMonth(deps, '2026-08-01');
    await buildPaymentFile(db, august.id, deps);
    expect(calls.sepa.at(-1)!.tax?.amountCents).toBe(60_000);

    // A correction paid in July puts the July return back to open (its amount is stale).
    const correction = await createRun(db, { employerId: world.employerId, kind: 'correction', correctsRunId: july.id, employeeIds: [world.eva.id], payDate: '2026-07-30' }, prep);
    await createRunInput(db, correction.id, { employeeId: world.eva.id, code: 'bonus', amount: 100 }, prep);
    await calculateRun(db, correction.id, deps, prep);
    await approveRun(db, correction.id, deps, boss);
    expect((await filingOf(7)).status).toBe('open');

    const extra = await offCycleRun('2026-08-01', '2026-08-31', '2026-08-28', 50);
    await calculateRun(db, extra.id, deps, prep);
    await approveRun(db, extra.id, deps, boss);
    await buildPaymentFile(db, extra.id, deps);
    expect(calls.sepa.at(-1)!.tax).toBeNull();

    // Generated again: the return is 62,000 now and 60,000 was carried by the August file; the next file carries 2,000.
    await generateFiling(db, (await filingOf(7)).id, deps, mgr);
    expect((await filingOf(7)).amountDue).toBe('620.00');
    await buildPaymentFile(db, extra.id, deps);
    expect(calls.sepa.at(-1)!.tax).toEqual({ amountCents: 2_000, betalingskenmerk: reference });
    // The first file is unchanged.
    await buildPaymentFile(db, august.id, deps);
    expect(calls.sepa.at(-1)!.tax).toEqual({ amountCents: 60_000, betalingskenmerk: reference });
    expect((await filingOf(7)).taxPayments.map((p) => [p.runId, p.cents])).toEqual([[august.id, 60_000], [extra.id, 2_000]]);
  });

  it('does not carry a return that is not generated yet, or whose build failed', async () => {
    const { deps, calls } = testDeps();
    await approveMonth(deps, '2026-07-01');
    const august = await approveMonth(deps, '2026-08-01');
    await buildPaymentFile(db, august.id, deps);
    expect(calls.sepa.at(-1)!.tax).toBeNull();
    expect((await filingOf(7)).taxPayments).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// M1: run state guards
// ---------------------------------------------------------------------------

describe('M1: a change racing an approval cannot corrupt the approved run', () => {
  it('touchRun refuses a run that is no longer open and never flips its status', async () => {
    const { deps } = testDeps();
    const run = await monthRun('2026-07-01');
    await calculateRun(db, run.id, deps, prep);
    await touchRun(db, run.id);
    expect((await requireRun(db, run.id)).status).toBe('draft');
    await calculateRun(db, run.id, deps, prep);
    await approveRun(db, run.id, deps, boss);
    await expect(touchRun(db, run.id)).rejects.toBeInstanceOf(HrConflictError);
    expect((await requireRun(db, run.id)).status).toBe('approved');
  });

  it('a recalculation that races an approval leaves an approved run approved: approval is refused while the run is being calculated', async () => {
    const base = testDeps();
    const run = await monthRun('2026-07-01');
    await calculateRun(db, run.id, base.deps, prep);
    let racing: Promise<unknown> | null = null;
    const { deps } = testDeps({
      engines: {
        ...base.deps.engines,
        calculatePayslip: (input) => {
          // The first engine call happens while the run is being recalculated: an approval arrives now.
          racing ??= approveRun(db, run.id, base.deps, boss).catch((err: unknown) => err);
          return fakeCalculate(input);
        },
      },
    });
    const recalculated = await calculateRun(db, run.id, deps, prep);
    const outcome = await racing;
    expect(outcome).toMatchObject({ code: 'RUN_NOT_CALCULATED' });
    expect(recalculated.status).toBe('calculated');
    expect((await slipsOf(run.id)).every((s) => s.status === 'draft')).toBe(true);
  });

  it('a cancel that lands while a run is being calculated wins, and leaves no draft payslips behind', async () => {
    const base = testDeps();
    const run = await monthRun('2026-07-01');
    let cancelled: Promise<unknown> | null = null;
    const { deps } = testDeps({
      engines: {
        ...base.deps.engines,
        calculatePayslip: (input) => {
          cancelled ??= db.update(schema.hrPayRuns).set({ status: 'cancelled' }).where(eq(schema.hrPayRuns.id, run.id)).execute();
          return fakeCalculate(input);
        },
      },
    });
    await expect(calculateRun(db, run.id, deps, prep)).rejects.toBeInstanceOf(HrConflictError);
    await cancelled;
    expect((await requireRun(db, run.id)).status).toBe('cancelled');
    expect(await slipsOf(run.id)).toEqual([]);
  });

  it('approving and cancelling at the same time end in one consistent state, never both', async () => {
    for (const delay of [0, 1]) {
      await resetPayrollTables(db);
      world = await nlWorld(db);
      const { deps } = testDeps();
      const run = await monthRun('2026-07-01');
      await calculateRun(db, run.id, deps, prep);
      const approval = approveRun(db, run.id, deps, boss).catch((err: unknown) => err);
      if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
      const cancel = cancelRun(db, run.id).catch((err: unknown) => err);
      await Promise.all([approval, cancel]);
      const final = await requireRun(db, run.id);
      const slips = await slipsOf(run.id);
      if (final.status === 'approved') {
        expect(slips.length).toBeGreaterThan(0);
        expect(slips.every((s) => s.status === 'final' && s.number)).toBe(true);
      } else {
        expect(final.status).toBe('cancelled');
        expect(slips.some((s) => s.status === 'final')).toBe(false);
      }
    }
  });

  it('a changed pay date or a changed crew racing an approval cannot reach an approved run', async () => {
    const { deps } = testDeps();
    const run = await monthRun('2026-07-01');
    await calculateRun(db, run.id, deps, prep);
    const approval = approveRun(db, run.id, deps, boss).catch((err: unknown) => err);
    const edits = Promise.allSettled([updateRun(db, run.id, { payDate: '2026-07-30' }), setRunEmployee(db, run.id, world.hans.id, true)]);
    await Promise.all([approval, edits]);
    const final = await requireRun(db, run.id);
    const slips = await slipsOf(run.id);
    if (final.status === 'approved') {
      // Approved as calculated: the payslips carry the pay date and the people they were calculated with.
      expect(slips.every((s) => s.status === 'final' && s.payDate === final.payDate)).toBe(true);
    } else {
      expect(final.status).toBe('draft');
      expect(slips.some((s) => s.status === 'final')).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// M2: the people in an approved run
// ---------------------------------------------------------------------------

describe('M2: the payslips of a run are for the people it includes now', () => {
  it('refuses to approve when someone was paused after the calculation', async () => {
    const { deps } = testDeps();
    const run = await monthRun('2026-07-01');
    await calculateRun(db, run.id, deps, prep);
    await db.update(schema.hrPayrollProfiles).set({ status: 'paused' }).where(eq(schema.hrPayrollProfiles.employeeId, world.hans.id));
    await expect(approveRun(db, run.id, deps, boss)).rejects.toMatchObject({ code: 'RECALCULATE_REQUIRED', details: { reason: 'employees_changed', employeeIds: [world.hans.id] } });
    await calculateRun(db, run.id, deps, prep);
    const result = await approveRun(db, run.id, deps, boss);
    expect(result.payslips.map((p) => p.employeeId)).toEqual([world.eva.id]);
  });

  it('refuses when someone moved to another schedule, so nobody is paid twice', async () => {
    const { deps } = testDeps();
    const run = await monthRun('2026-07-01');
    await calculateRun(db, run.id, deps, prep);
    const other = await createSchedule(db, { employerId: world.employerId, name: 'Other', frequency: 'monthly', anchorDate: '2026-01-01', payDateRule: { kind: 'day_of_month', day: 20 } });
    await upsertProfile(db, world.hans.id, { employerId: world.employerId, payScheduleId: other.id });
    await expect(approveRun(db, run.id, deps, boss)).rejects.toMatchObject({ code: 'RECALCULATE_REQUIRED', details: { reason: 'employees_changed' } });
  });

  it('refuses when someone left or joined the run through its included list', async () => {
    const { deps } = testDeps();
    const run = await monthRun('2026-07-01');
    await calculateRun(db, run.id, deps, prep);
    // Excluded straight in the table (no re-open), as a racing writer would.
    await db.update(schema.hrPayRuns).set({ excludedEmployeeIds: [world.hans.id] }).where(eq(schema.hrPayRuns.id, run.id));
    await expect(approveRun(db, run.id, deps, boss)).rejects.toMatchObject({ code: 'RECALCULATE_REQUIRED', details: { reason: 'employees_changed' } });
  });

  it('refuses when the pay date changed after the calculation', async () => {
    const { deps } = testDeps();
    const run = await monthRun('2026-07-01');
    await calculateRun(db, run.id, deps, prep);
    await db.update(schema.hrPayRuns).set({ payDate: '2026-07-30' }).where(eq(schema.hrPayRuns.id, run.id));
    await expect(approveRun(db, run.id, deps, boss)).rejects.toMatchObject({ code: 'RECALCULATE_REQUIRED', details: { reason: 'period_changed' } });
  });

  it('refuses when an input was added after the calculation', async () => {
    const { deps } = testDeps();
    const run = await monthRun('2026-07-01');
    await calculateRun(db, run.id, deps, prep);
    // Straight into the table, as a writer that slipped in while the calculation was running would.
    await db.insert(schema.hrPayRunInputs).values({ id: 'hrpi_late', runId: run.id, employeeId: world.eva.id, code: 'bonus', amount: '10.00', source: 'manual' });
    await expect(approveRun(db, run.id, deps, boss)).rejects.toMatchObject({ code: 'RECALCULATE_REQUIRED', details: { reason: 'inputs_changed' } });
  });
});

// ---------------------------------------------------------------------------
// M3: a reopened filing is a new version
// ---------------------------------------------------------------------------

describe('M3: a filing that was sent and is reopened goes out as a new version', () => {
  const gateway = () => {
    const sent: Array<{ messageId: string; xml: string }> = [];
    const impl: DigipoortGateway = {
      submit: async (input) => (sent.push({ messageId: input.messageId, xml: input.xml }), { reference: `DP-${sent.length}` }),
      status: async () => ({ status: 'accepted', message: null }),
    };
    return { impl, sent };
  };

  it('bumps the version, clears the sending details, keeps the history and the old file, and never marks the unsent version accepted', async () => {
    const { impl, sent } = gateway();
    const { deps, stored } = testDeps({ digipoort: impl });
    const july = await approveMonth(deps, '2026-07-01');
    const before = await generateFiling(db, (await filingOf(7)).id, deps, mgr);
    await submitFiling(db, before.id, deps, { userId: 'user_mgr', flagOn: true });
    const v1Key = (await filingOf(7)).fileKey!;
    expect(v1Key).toContain('/v1/');

    // A correction paid in the same month changes the return.
    const correction = await createRun(db, { employerId: world.employerId, kind: 'correction', correctsRunId: july.id, employeeIds: [world.eva.id], payDate: '2026-07-30' }, prep);
    await createRunInput(db, correction.id, { employeeId: world.eva.id, code: 'bonus', amount: 100 }, prep);
    await calculateRun(db, correction.id, deps, prep);
    await approveRun(db, correction.id, deps, boss);

    const reopened = await filingOf(7);
    expect(reopened).toMatchObject({ status: 'open', version: 2, channel: null, externalReference: null, submittedAt: null, submittedBy: null });
    expect(reopened.history.map((e) => [e.status, e.version ?? 1])).toEqual([['open', 1], ['ready', 1], ['submitted', 1], ['open', 2]]);
    // Nothing was sent for version 2, so there is nothing to refresh, and version 1's file is still there to download.
    await expect(refreshFilingStatus(db, reopened.id, deps, { userId: 'u', flagOn: true })).rejects.toBeInstanceOf(HrConflictError);
    expect((await filingFile(db, reopened.id, deps)).fileName).toBe('loonaangifte-2026.xml');
    const v1Body = new TextDecoder().decode(stored.get(v1Key)!.body);

    // Regenerating keeps version 2 (it is the new one already) and leaves the stored version 1 file alone.
    const regenerated = await generateFiling(db, reopened.id, deps, mgr);
    expect(regenerated).toMatchObject({ status: 'ready', version: 2 });
    expect(regenerated.fileKey).toContain('/v2/');
    expect(new TextDecoder().decode(stored.get(v1Key)!.body)).toBe(v1Body);

    await submitFiling(db, regenerated.id, deps, { userId: 'user_mgr', flagOn: true });
    expect(sent.map((s) => s.messageId.slice(-3))).toEqual(['-v1', '-v2']);
    expect(sent[0]!.messageId).not.toBe(sent[1]!.messageId);
  });

  it('keeps the version of a filing that was generated but never sent', async () => {
    const { deps } = testDeps();
    const july = await approveMonth(deps, '2026-07-01');
    await generateFiling(db, (await filingOf(7)).id, deps, mgr);
    const correction = await createRun(db, { employerId: world.employerId, kind: 'correction', correctsRunId: july.id, employeeIds: [world.eva.id], payDate: '2026-07-30' }, prep);
    await createRunInput(db, correction.id, { employeeId: world.eva.id, code: 'bonus', amount: 100 }, prep);
    await calculateRun(db, correction.id, deps, prep);
    await approveRun(db, correction.id, deps, boss);
    expect(await filingOf(7)).toMatchObject({ status: 'open', version: 1 });
  });
});

// ---------------------------------------------------------------------------
// M4: identity edits from self-service
// ---------------------------------------------------------------------------

describe('M4: an employee changing who they are loses HR\'s verification', () => {
  const self = { keyring: TEST_KEYRING, selfService: true };
  const hr = { keyring: TEST_KEYRING, selfService: false };

  it('clears idVerifiedAt when the BSN, the date of birth or the ID document changes from self-service, and flags it', async () => {
    const same = await setPaymentDetails(db, world.eva.id, { nationalId: '111222333', dateOfBirth: '1990-05-17' }, self);
    expect(same.idVerificationCleared).toBe(false);
    expect(same.details.idVerifiedAt).toBe('2025-01-02');

    const bsn = await setPaymentDetails(db, world.eva.id, { nationalId: VALID_BSN_2 }, self);
    expect(bsn.idVerificationCleared).toBe(true);
    expect(bsn.details.idVerifiedAt).toBeNull();
    expect(bsn.changedFields).toContain('idVerifiedAt');

    // HR verifies again; every identity field clears it again.
    for (const change of [{ dateOfBirth: '1991-01-01' }, { idDocumentType: 'passport' as const }, { idDocumentNumber: 'X123' }, { idDocumentExpiresOn: '2031-01-01' }]) {
      await setPaymentDetails(db, world.eva.id, { idVerifiedAt: '2026-01-01' }, hr);
      const result = await setPaymentDetails(db, world.eva.id, change, self);
      expect(result.idVerificationCleared, JSON.stringify(change)).toBe(true);
      expect(result.details.idVerifiedAt).toBeNull();
    }
  });

  it('does not touch it for bank or address edits, and HR\'s own edits keep what HR sets', async () => {
    const bank = await setPaymentDetails(db, world.eva.id, { bankIban: VALID_IBAN }, self);
    expect(bank.idVerificationCleared).toBe(false);
    expect(bank.details.idVerifiedAt).toBe('2025-01-02');
    const byHr = await setPaymentDetails(db, world.eva.id, { nationalId: VALID_BSN_2, dateOfBirth: '1980-02-02' }, hr);
    expect(byHr.idVerificationCleared).toBe(false);
    expect(byHr.details.idVerifiedAt).toBe('2025-01-02');
  });

  it('puts the employee on the anonymous rate for the next calculation', async () => {
    const seen: Array<boolean> = [];
    const base = testDeps();
    const { deps } = testDeps({
      engines: {
        ...base.deps.engines,
        calculatePayslip: (input) => {
          if (input.country === 'NL') seen.push(input.nl.anonymous);
          return fakeCalculate(input);
        },
      },
    });
    await setPaymentDetails(db, world.eva.id, { nationalId: VALID_BSN_2 }, self);
    const run = await monthRun('2026-07-01');
    await calculateRun(db, run.id, deps, prep);
    // Eva (anonymous now) and Hans (still verified), in alphabetical order of the loop's input.
    expect(seen.sort()).toEqual([false, true]);
    const details = await myPayrollDetails(db, world.eva.id, TEST_KEYRING);
    expect(details.paymentDetails.idVerifiedAt).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// M5: the sealed bank account
// ---------------------------------------------------------------------------

describe('M5: a payslip is paid to the account that was approved', () => {
  it('seals the account in the snapshot, never in plaintext', async () => {
    const { deps } = testDeps();
    const run = await approveMonth(deps, '2026-07-01');
    const [eva] = (await slipsOf(run.id)).filter((s) => s.employeeId === world.eva.id);
    const snapshot = eva!.snapshot as { bankEncrypted?: string };
    expect(typeof snapshot.bankEncrypted).toBe('string');
    expect(JSON.stringify(eva!.snapshot)).not.toContain(VALID_IBAN_2);
  });

  it('pays the approved account after the IBAN changed, and warns', async () => {
    const { deps, calls } = testDeps();
    const run = await approveMonth(deps, '2026-07-01');
    const unchanged = await buildPaymentFile(db, run.id, deps);
    expect(unchanged.warnings).toEqual([]);

    // A payroll:prepare user redirects Eva's salary after the (four-eyes) approval.
    await setPaymentDetails(db, world.eva.id, { bankIban: VALID_IBAN }, { keyring: TEST_KEYRING, selfService: false });
    const file = await buildPaymentFile(db, run.id, deps);
    expect(calls.sepa.at(-1)!.salaries[0]!.creditor.iban).toBe(VALID_IBAN_2);
    expect(file.warnings).toEqual([{ severity: 'warning', code: 'bank_changed_after_approval', employeeId: world.eva.id }]);
  });

  it('pays an approved account even when the current one was removed', async () => {
    const { deps, calls } = testDeps();
    const run = await approveMonth(deps, '2026-07-01');
    await setPaymentDetails(db, world.eva.id, { bankIban: null }, { keyring: TEST_KEYRING, selfService: false });
    const file = await buildPaymentFile(db, run.id, deps);
    expect(calls.sepa.at(-1)!.salaries[0]!.creditor.iban).toBe(VALID_IBAN_2);
    expect(file.warnings.map((w) => w.code)).toEqual(['bank_changed_after_approval']);
  });
});

// ---------------------------------------------------------------------------
// M6: hours are not paid twice
// ---------------------------------------------------------------------------

describe('M6: collecting skips hours, leave and sick days another live run pays', () => {
  async function seed() {
    await db.insert(schema.hrAttendanceRecords).values(
      ['2026-07-06', '2026-07-07'].map((date) => ({ id: `att_${date}`, employeeId: world.hans.id, date, workedMinutes: 480, approvedAt: new Date(), approvedBy: 'user_mgr' })),
    );
    await db.insert(schema.hrLeaveTypes).values({ id: 'lt_unpaid', name: 'Unpaid leave', isPaid: false });
    await db.insert(schema.hrLeaveRequests).values([
      { id: 'lr_unpaid', employeeId: world.eva.id, leaveTypeId: 'lt_unpaid', startDate: '2026-07-06', endDate: '2026-07-07', days: 2, status: 'approved' },
    ]);
    await db.insert(schema.hrAbsences).values({ id: 'abs_1', employeeId: world.eva.id, startDate: '2026-07-20', endDate: '2026-07-21', firstDay: 'full' });
  }
  const bothPeople = () => [world.eva.id, world.hans.id];
  const collected = async (runId: string) => (await listRunInputs(db, runId)).filter((i) => ['attendance', 'leave', 'absence'].includes(i.source));

  it('does not collect them again in an off-cycle run, but does once the first run is cancelled', async () => {
    await seed();
    const regular = await monthRun('2026-07-01');
    expect(await collectRunInputs(db, regular.id, TEST_KEYRING, prep)).toMatchObject({ attendance: 2, leave: 1, absence: 1 });
    const extra = await offCycleRun('2026-07-01', '2026-07-31', '2026-07-30', undefined, bothPeople());
    expect(await collectRunInputs(db, extra.id, TEST_KEYRING, prep)).toEqual({ attendance: 0, leave: 0, absence: 0, declaration: 0 });
    expect(await collected(extra.id)).toEqual([]);

    await cancelRun(db, regular.id);
    expect(await collectRunInputs(db, extra.id, TEST_KEYRING, prep)).toMatchObject({ attendance: 2, leave: 1, absence: 1 });
  });

  it('also skips them in a regular run when an earlier off-cycle run took them', async () => {
    await seed();
    const extra = await offCycleRun('2026-07-01', '2026-07-31', '2026-07-30', undefined, bothPeople());
    await collectRunInputs(db, extra.id, TEST_KEYRING, prep);
    const regular = await monthRun('2026-07-01');
    expect(await collectRunInputs(db, regular.id, TEST_KEYRING, prep)).toMatchObject({ attendance: 0, leave: 0, absence: 0 });
  });

  it('still collects leave that spans two periods once per period', async () => {
    await db.insert(schema.hrLeaveTypes).values({ id: 'lt_unpaid', name: 'Unpaid leave', isPaid: false });
    await db.insert(schema.hrLeaveRequests).values({ id: 'lr_span', employeeId: world.eva.id, leaveTypeId: 'lt_unpaid', startDate: '2026-06-29', endDate: '2026-07-03', days: 5, status: 'approved' });
    const june = await monthRun('2026-06-01');
    const july = await monthRun('2026-07-01');
    await collectRunInputs(db, june.id, TEST_KEYRING, prep);
    await collectRunInputs(db, july.id, TEST_KEYRING, prep);
    expect((await collected(june.id)).map((i) => i.quantity)).toEqual(['16.0000']);
    expect((await collected(july.id)).map((i) => i.quantity)).toEqual(['24.0000']);
  });

  it('only leaves out the days another run\'s period covers when leave overlaps two runs partly', async () => {
    await db.insert(schema.hrLeaveTypes).values({ id: 'lt_unpaid', name: 'Unpaid leave', isPaid: false });
    // Wed 8 to Wed 15 July: six weekdays.
    await db.insert(schema.hrLeaveRequests).values({ id: 'lr_part', employeeId: world.eva.id, leaveTypeId: 'lt_unpaid', startDate: '2026-07-08', endDate: '2026-07-15', days: 6, status: 'approved' });
    const early = await offCycleRun('2026-07-01', '2026-07-10', '2026-07-10');
    await collectRunInputs(db, early.id, TEST_KEYRING, prep);
    const regular = await monthRun('2026-07-01');
    await collectRunInputs(db, regular.id, TEST_KEYRING, prep);
    expect((await collected(early.id)).map((i) => i.quantity)).toEqual(['24.0000']);
    expect((await collected(regular.id)).map((i) => i.quantity)).toEqual(['24.0000']);
  });
});

// ---------------------------------------------------------------------------
// M7: the pay date and the tax year
// ---------------------------------------------------------------------------

describe('M7: a changed pay date keeps tax year and period number right', () => {
  it('refuses a Dutch pay date in another calendar year than the period, when creating and when changing it', async () => {
    await expect(createRun(db, { employerId: world.employerId, kind: 'regular', payScheduleId: world.scheduleId, periodStart: '2026-12-01', payDate: '2027-01-05' }, prep)).rejects.toBeInstanceOf(HrValidationError);
    const run = await monthRun('2026-12-01');
    await expect(updateRun(db, run.id, { payDate: '2027-01-05' })).rejects.toBeInstanceOf(HrValidationError);
    expect(await updateRun(db, run.id, { payDate: '2026-12-30' })).toMatchObject({ payDate: '2026-12-30', taxYear: 2026, periodNumber: 12 });
    // An override inside the year is fine and keeps the numbers.
    const other = await createRun(db, { employerId: world.employerId, kind: 'regular', payScheduleId: world.scheduleId, periodStart: '2026-11-01', payDate: '2026-11-27' }, prep);
    expect(other).toMatchObject({ payDate: '2026-11-27', taxYear: 2026, periodNumber: 11 });
  });

  describe('US', () => {
    async function usWorld() {
      const employer = await createEmployer(
        db,
        { name: 'Acme Inc', legalName: 'Acme Inc.', country: 'US', address: { line1: '1 Main St', city: 'Austin', region: 'TX', postalCode: '78701', country: 'US' }, usSettings: { ein: '12-3456789', depositSchedule: 'monthly', states: { TX: { suiRates: { '2026': 2.7, '2027': 2.7 } } } } },
        { createdBy: 'u', keyring: TEST_KEYRING },
      );
      await setEmployerBank(db, employer.id, { routingNumber: VALID_ROUTING, accountNumber: '987654321', accountType: 'checking', nachaCompanyId: '1123456789', bankName: 'First Bank' }, TEST_KEYRING);
      const schedule = await createSchedule(db, { employerId: employer.id, name: 'Biweekly', frequency: 'biweekly', anchorDate: '2026-01-05', payDateRule: { kind: 'offset_after_end', days: 5 } });
      const pat = await createTestEmployee(db, { firstName: 'Pat', lastName: 'Doe' });
      await upsertProfile(db, pat.id, { employerId: employer.id, payScheduleId: schedule.id, startDate: '2025-06-01', us: { workState: 'TX', flsaStatus: 'exempt' } });
      await createCompensation(db, pat.id, { effectiveFrom: '2025-06-01', payType: 'salary', amount: 52_000, period: 'year' }, { createdBy: 'u' });
      await setPaymentDetails(db, pat.id, { nationalId: VALID_SSN, bankRoutingNumber: VALID_ROUTING, bankAccountNumber: '123456789', bankAccountType: 'savings', homeAddress: { line1: '9 Oak St', city: 'Austin', region: 'TX', postalCode: '78702' } }, { keyring: TEST_KEYRING, selfService: false });
      await createElection(db, pat.id, { kind: 'us_w4', effectiveFrom: '2026-01-01', data: { formYear: 2026, filingStatus: 'single', multipleJobs: false, dependentsAmount: 0, otherIncome: 0, deductions: 0, extraWithholding: 0, exempt: false }, signatureName: 'Pat Doe' }, { signedBy: 'u', source: 'admin' });
      return { employerId: employer.id, scheduleId: schedule.id, patId: pat.id };
    }

    it('moves the tax year and period number with the pay date, on creation and on a change', async () => {
      const us = await usWorld();
      // 21 Dec 2026 to 3 Jan 2027, naturally paid on 8 Jan 2027: the first period of 2027.
      const natural = await createRun(db, { employerId: us.employerId, kind: 'regular', payScheduleId: us.scheduleId, periodStart: '2026-12-21' }, prep);
      expect(natural).toMatchObject({ payDate: '2027-01-08', taxYear: 2027, periodNumber: 1 });
      await cancelRun(db, natural.id);

      // Paid on 31 December instead: taxed in 2026, the year's 27th period (the 26th ended on 20 December).
      const early = await createRun(db, { employerId: us.employerId, kind: 'regular', payScheduleId: us.scheduleId, periodStart: '2026-12-21', payDate: '2026-12-31' }, prep);
      expect(early).toMatchObject({ payDate: '2026-12-31', taxYear: 2026, periodNumber: 27 });

      // And back again by changing the pay date.
      const moved = await updateRun(db, early.id, { payDate: '2027-01-08' });
      expect(moved).toMatchObject({ payDate: '2027-01-08', taxYear: 2027, periodNumber: 1 });
      const midYear = await createRun(db, { employerId: us.employerId, kind: 'regular', payScheduleId: us.scheduleId, periodStart: '2026-01-19', payDate: '2026-02-03' }, prep);
      expect(midYear).toMatchObject({ taxYear: 2026, periodNumber: 3 });
    });

    it('derives the tax year of an off-cycle run from its pay date', async () => {
      const us = await usWorld();
      const run = await createRun(db, { employerId: us.employerId, kind: 'off_cycle', periodStart: '2026-12-21', periodEnd: '2027-01-03', payDate: '2026-12-30', employeeIds: [us.patId] }, prep);
      expect(run).toMatchObject({ taxYear: 2026 });
    });
  });
});

// ---------------------------------------------------------------------------
// M8: corrections across a year boundary
// ---------------------------------------------------------------------------

describe('M8: a correction is paid in the year of the period it corrects', () => {
  it('refuses to create one paid in another year, and to move one there, with CORRECTION_CROSSES_YEAR', async () => {
    const { deps } = testDeps();
    const july = await approveMonth(deps, '2026-07-01');
    await expect(
      createRun(db, { employerId: world.employerId, kind: 'correction', correctsRunId: july.id, employeeIds: [world.eva.id], payDate: '2027-01-05' }, prep),
    ).rejects.toMatchObject({ code: 'CORRECTION_CROSSES_YEAR', status: 409 });
    const run = await createRun(db, { employerId: world.employerId, kind: 'correction', correctsRunId: july.id, employeeIds: [world.eva.id], payDate: '2026-12-30' }, prep);
    await expect(updateRun(db, run.id, { payDate: '2027-01-02' })).rejects.toMatchObject({ code: 'CORRECTION_CROSSES_YEAR' });
  });

  it('refuses to approve one whose pay date left the year', async () => {
    const { deps } = testDeps();
    const july = await approveMonth(deps, '2026-07-01');
    const run = await createRun(db, { employerId: world.employerId, kind: 'correction', correctsRunId: july.id, employeeIds: [world.eva.id], payDate: '2026-08-05' }, prep);
    await createRunInput(db, run.id, { employeeId: world.eva.id, code: 'bonus', amount: 100 }, prep);
    await calculateRun(db, run.id, deps, prep);
    // The pay date slipped to the next year behind the API's back.
    await db.update(schema.hrPayRuns).set({ payDate: '2027-01-05' }).where(eq(schema.hrPayRuns.id, run.id));
    await expect(approveRun(db, run.id, deps, boss)).rejects.toMatchObject({ code: 'CORRECTION_CROSSES_YEAR' });
  });
});

// ---------------------------------------------------------------------------
// M9: claim and finalise are one write
// ---------------------------------------------------------------------------

describe('M9: a failure while finalising leaves the run calculated, not approved with drafts', () => {
  /** Deps whose clock, read just before the claim, lets a racing approval take 2026-0001 for `employeeId`. */
  function racingDeps(employeeId: string) {
    let armed = true;
    return testDeps({
      now: () => {
        if (armed) {
          armed = false;
          void db.insert(schema.hrPayRuns).values({ id: 'run_other', employerId: world.employerId, country: 'NL', currency: 'EUR', periodStart: '2026-06-01', periodEnd: '2026-06-30', payDate: '2026-06-24', taxYear: 2026, periodNumber: 6, status: 'approved', kind: 'off_cycle' }).execute();
          void db.insert(schema.hrPayslips).values({ id: 'slip_taken', runId: 'run_other', employeeId, employerId: world.employerId, country: 'NL', currency: 'EUR', status: 'final', number: '2026-0001', periodStart: '2026-06-01', periodEnd: '2026-06-30', payDate: '2026-06-24', taxYear: 2026, periodNumber: 6 }).execute();
        }
        return new Date('2026-08-01T10:00:00Z');
      },
    });
  }

  it('rolls the claim back when a payslip number is taken after the numbers were chosen, and approves on the next attempt', async () => {
    const run = await monthRun('2026-07-01');
    await calculateRun(db, run.id, testDeps().deps, prep);
    // The racing approval is for someone else, so the run's own chain is untouched.
    const { deps } = racingDeps('hremp_somebody_else');
    const result = await approveRun(db, run.id, deps, boss);
    // The first attempt hit the unique index and rolled back as a whole (the claim included); the second used the free numbers.
    expect(result.payslips.map((p) => p.number)).toEqual(['2026-0002', '2026-0003']);
    expect((await requireRun(db, run.id)).status).toBe('approved');
    expect((await slipsOf(run.id)).every((s) => s.status === 'final')).toBe(true);
  });

  it('starts over with fresh checks: when the racing approval moved an employee chain, the run is refused and stays calculated with its drafts', async () => {
    const run = await monthRun('2026-07-01');
    await calculateRun(db, run.id, testDeps().deps, prep);
    const { deps } = racingDeps(world.eva.id);
    await expect(approveRun(db, run.id, deps, boss)).rejects.toMatchObject({ code: 'RECALCULATE_REQUIRED', details: { reason: 'ytd_changed' } });
    // The failed attempt left nothing behind: not approved, no final payslip of this run, no half-finished claim.
    const after = await requireRun(db, run.id);
    expect(after).toMatchObject({ status: 'calculated', approvedBy: null, approvedAt: null });
    expect((await slipsOf(run.id)).every((s) => s.status === 'draft' && s.number === null)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// L1: payslip numbers are unique per employer
// ---------------------------------------------------------------------------

describe('L1: payslip numbers are unique per employer', () => {
  it('rejects a duplicate number in the database', async () => {
    const { deps } = testDeps();
    const run = await approveMonth(deps, '2026-07-01');
    const [first] = await slipsOf(run.id);
    const second = (await slipsOf(run.id)).find((s) => s.id !== first!.id)!;
    await expect(db.update(schema.hrPayslips).set({ number: first!.number }).where(eq(schema.hrPayslips.id, second.id))).rejects.toThrow();
  });

  it('two approvals racing for the same numbers end with distinct numbers', async () => {
    const { deps } = testDeps();
    const regular = await monthRun('2026-07-01');
    // Different people, so neither approval invalidates the other's year-to-date chain.
    const hansRun = await createRun(db, { employerId: world.employerId, kind: 'off_cycle', periodStart: '2026-07-01', periodEnd: '2026-07-31', payDate: '2026-07-31', employeeIds: [world.hans.id] }, prep);
    await setRunEmployee(db, regular.id, world.hans.id, true);
    await calculateRun(db, regular.id, deps, prep);
    await calculateRun(db, hansRun.id, deps, prep);
    await Promise.all([approveRun(db, regular.id, deps, boss), approveRun(db, hansRun.id, deps, mgr)]);
    const numbers = [...(await slipsOf(regular.id)), ...(await slipsOf(hansRun.id))].map((s) => s.number);
    expect(new Set(numbers).size).toBe(2);
    expect(numbers.every((n) => /^2026-000[12]$/.test(n ?? ''))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// L2: the journal
// ---------------------------------------------------------------------------

describe('L2: the journal is posted for approved runs only, and a reversed import is not "posted"', () => {
  it('refuses to post a draft, calculated or cancelled run', async () => {
    const { deps, booksCalls } = testDeps();
    const run = await monthRun('2026-07-01');
    await expect(postRunJournal(db, run.id, deps, { userId: 'u' })).rejects.toMatchObject({ code: 'RUN_NOT_APPROVED', status: 409 });
    await calculateRun(db, run.id, deps, prep);
    await expect(postRunJournal(db, run.id, deps, { userId: 'u' })).rejects.toMatchObject({ code: 'RUN_NOT_APPROVED' });
    await cancelRun(db, run.id);
    await expect(postRunJournal(db, run.id, deps, { userId: 'u' })).rejects.toMatchObject({ code: 'RUN_NOT_APPROVED' });
    expect(booksCalls).toHaveLength(0);
  });

  it('records a failure when books answers that the import was reversed', async () => {
    const { deps } = testDeps({
      books: { postPayroll: async () => ({ status: 'failed', error: 'This payroll was posted to WeldBooks and has since been reversed there.' }) },
    });
    await db.update(schema.hrPayrollEmployers).set({ accountingEntityId: 'ent_1' }).where(eq(schema.hrPayrollEmployers.id, world.employerId));
    const run = await approveMonth(deps, '2026-07-01');
    const detail = await getRunDetail(db, run.id, boss);
    expect(detail).toMatchObject({ journalStatus: 'failed' });
    expect(detail.journalError).toMatch(/reversed/);
  });
});

// ---------------------------------------------------------------------------
// L3: excluded people in a correction run
// ---------------------------------------------------------------------------

describe('L3: a correction run honours its excluded employees', () => {
  it('calculates and approves with the excluded person left out', async () => {
    const { deps } = testDeps();
    const july = await approveMonth(deps, '2026-07-01');
    const run = await createRun(db, { employerId: world.employerId, kind: 'correction', correctsRunId: july.id, employeeIds: [world.eva.id, world.hans.id], payDate: '2026-08-05' }, prep);
    await createRunInput(db, run.id, { employeeId: world.eva.id, code: 'bonus', amount: 100 }, prep);
    await setRunEmployee(db, run.id, world.hans.id, true);
    const calculated = await calculateRun(db, run.id, deps, prep);
    expect(calculated.issues.filter((i) => i.severity === 'error')).toEqual([]);
    expect(calculated.employeeCount).toBe(1);
    const approved = await approveRun(db, run.id, deps, boss);
    expect(approved.payslips.map((p) => p.employeeId)).toEqual([world.eva.id]);
  });
});

// ---------------------------------------------------------------------------
// L4: CSV formula injection
// ---------------------------------------------------------------------------

describe('L4: the run report neutralises formulas', () => {
  it('prefixes text cells that start with = + - @ and leaves numbers alone', async () => {
    const base = testDeps();
    // An engine that carries the input's label onto the reimbursement line, as the real ones do.
    const { deps } = testDeps({
      engines: {
        ...base.deps.engines,
        calculatePayslip: (input) => {
          const result = fakeCalculate(input);
          const label = input.inputs.find((i) => i.code === 'reimbursement')?.label ?? null;
          return { ...result, lines: result.lines.map((line) => (line.code === 'reimbursement' ? { ...line, label } : line)) };
        },
      },
    });
    await db.insert(schema.hrDeclarations).values({ id: 'dcl_evil', employeeId: world.eva.id, expenseDate: '2026-07-10', category: 'travel', description: '=HYPERLINK("http://evil.example","x")', amount: '12.00', currency: 'EUR', status: 'approved' });
    const run = await monthRun('2026-07-01');
    await collectRunInputs(db, run.id, TEST_KEYRING, prep);
    await calculateRun(db, run.id, deps, prep);
    const report = await buildRunReport(db, run.id);
    const lines = report.content.split('\r\n');
    const evil = lines.find((l) => l.includes('HYPERLINK'))!;
    expect(evil).toBeTruthy();
    // The label cell now starts with an apostrophe (and is quoted for its comma and quotes).
    expect(evil).toContain(`"'=HYPERLINK(""http://evil.example"",""x"")"`);
    // A negative amount is data, not a formula.
    expect(lines.some((l) => /,-\d+\.\d\d,EUR$/.test(l))).toBe(true);
    expect(lines.filter((l) => /(^|,)[=+@]/.test(l.replace(/"[^"]*"/g, '')))).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Corrections over several periods
// ---------------------------------------------------------------------------

describe('a correction of a later period starts from the accumulators earlier corrections left', () => {
  it('adds the year-to-date delta of an earlier period\'s correction to the recalculation\'s start', async () => {
    const { deps } = testDeps();
    const june = await approveMonth(deps, '2026-06-01');
    const july = await approveMonth(deps, '2026-07-01');
    // Correct June (+100 bonus), then July.
    const fixJune = await createRun(db, { employerId: world.employerId, kind: 'correction', correctsRunId: june.id, employeeIds: [world.eva.id], payDate: '2026-08-05' }, prep);
    await createRunInput(db, fixJune.id, { employeeId: world.eva.id, code: 'bonus', amount: 100 }, prep);
    await calculateRun(db, fixJune.id, deps, prep);
    await approveRun(db, fixJune.id, deps, boss);

    const fixJuly = await createRun(db, { employerId: world.employerId, kind: 'correction', correctsRunId: july.id, employeeIds: [world.eva.id], payDate: '2026-08-06' }, prep);
    await calculateRun(db, fixJuly.id, deps, prep);
    const [delta] = await slipsOf(fixJuly.id);
    const input = (delta!.snapshot as { input: { ytd: Record<string, number> } }).input;
    // July's own start was June's 300,000; June's correction added 10,000 since.
    expect(input.ytd['gross']).toBe(310_000);
    // Nothing changed in July itself, so the difference is zero.
    expect(delta!.grossPay).toBe('0.00');
  });
});
