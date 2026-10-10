/**
 * Filings (NL loonaangifte, US 941/940/W-2 and state reports), the overview,
 * the US payroll path (NACHA, W-2 employee copy) and the billing ledger.
 */

import { eq } from 'drizzle-orm';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createMasterPgliteDb } from '@weldsuite/worker-kit/testing/pglite';
import type { Database } from '@weldsuite/worker-kit/db';
import { masterSchema, schema } from '@weldsuite/worker-kit/db';
import { createPayrollDb, resetPayrollTables } from '../../../test/payroll-db';
import {
  TEST_KEYRING,
  VALID_BSN,
  VALID_ROUTING,
  VALID_SSN,
  createTestEmployee,
  fakeCalculate,
  nlWorld,
  testDeps,
  type NlWorld,
} from '../../../test/payroll-fixtures';
import { HrConflictError, HrNotFoundError } from '../shared';
import { annualStatementPdf } from './annual';
import { approveRun } from './approve';
import { calculateRun } from './calculate';
import type { DigipoortGateway } from './deps';
import { createCompensation, createElection, setPaymentDetails, upsertProfile } from './employees';
import { updateEmployer, setEmployerBank, createEmployer } from './employers';
import { buildPaymentFile } from './files';
import { filingFile, generateFiling, listFilings, markFilingFiled, refreshFilingStatus, submitFiling, toFilingDto } from './filings';
import { payslipFileName } from './format';
import { payrollOverview } from './overview';
import { createRun, createRunInput } from './runs';
import { createSchedule } from './schedules';
import { writeUsageEvents } from './usage';

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

async function approveMonth(deps: ReturnType<typeof testDeps>['deps'], periodStart = '2026-07-01') {
  const run = await createRun(db, { employerId: world.employerId, kind: 'regular', payScheduleId: world.scheduleId, periodStart }, prep);
  await calculateRun(db, run.id, deps, prep);
  await approveRun(db, run.id, deps, boss);
  return run;
}

const filingOf = async (period: number, kind = 'nl_loonaangifte') =>
  (await db.select().from(schema.hrPayrollFilings)).find((f) => f.kind === kind && f.period === period)!;

describe('Dutch loonaangifte', () => {
  it('is built from the month\'s final payslips with identity from the sensitive block, and stored', async () => {
    const { deps, calls, stored } = testDeps();
    await approveMonth(deps);
    const filing = await filingOf(7);
    expect(filing.status).toBe('open');

    const row = await generateFiling(db, filing.id, deps, mgr);
    expect(row).toMatchObject({ status: 'ready', version: 1, fileName: 'loonaangifte-2026.xml', contentType: 'application/xml', amountDue: '600.00', dueDate: '2026-08-28' });
    // The betalingskenmerk of the month's payment (16 digits) comes from the engine.
    expect(row.paymentReference).toMatch(/^[0-9]{16}$/);
    expect(row.issues).toEqual([]);
    expect(row.summary).toEqual({ TotLnLbPh: 300_000, TotTeBet: 60_000 });
    expect(row.fileKey).toBe(`workspaces/org_test/hr/filings/${world.employerId}/2026/${filing.id}/v1/loonaangifte-2026.xml`);
    expect(new TextDecoder().decode(stored.get(row.fileKey!)!.body)).toBe('<aangifte ikvs="2" corrections="0"/>');
    // The printable summary sits beside the XML.
    expect([...stored.keys()].some((k) => k.endsWith('-summary.pdf'))).toBe(true);
    expect(row.history.map((h) => h.status)).toEqual(['open', 'ready']);

    const input = calls.loonaangifte[0]!;
    expect(input).toMatchObject({
      taxYear: 2026,
      period: { start: '2026-07-01', end: '2026-07-31' },
      employer: { loonheffingennummer: '123456789L01', name: 'Acme B.V.', contactName: 'Piet Puk', contactPhone: '0301234567', sectorCode: 52 },
      software: { name: 'WeldSuite', relationNumber: 'SWO12345' },
    });
    expect(input.messageId.length).toBeLessThanOrEqual(35);
    const eva = input.ikvs.find((ikv) => ikv.identity.surname === 'Alder')!;
    expect(eva).toMatchObject({ incomeRelationshipNumber: 1, employmentStart: '2026-01-01', employmentEnd: null });
    expect(eva.identity).toMatchObject({ bsn: VALID_BSN, initials: 'E.', dateOfBirth: '1990-05-17', surnamePrefix: null });
    expect(input.ikvs.map((i) => i.incomeRelationshipNumber)).toEqual([1, 2]);
  });

  it('regenerates in place until it was sent, then opens a new version', async () => {
    const { deps } = testDeps();
    await approveMonth(deps);
    const filing = await filingOf(7);
    await generateFiling(db, filing.id, deps, mgr);
    expect((await generateFiling(db, filing.id, deps, mgr)).version).toBe(1);
    await markFilingFiled(db, filing.id, { externalReference: 'LH-123', filedOn: '2026-08-20' }, { userId: 'user_mgr', now: new Date('2026-08-20T09:00:00Z') });
    const again = await generateFiling(db, filing.id, deps, mgr);
    expect(again).toMatchObject({ version: 2, status: 'ready', channel: null, externalReference: null, submittedAt: null });
    expect(again.fileKey).toContain('/v2/');
    expect(again.history.map((h) => h.status)).toEqual(['open', 'ready', 'ready', 'filed', 'ready']);
  });

  it('serves the stored file and its extras, and nothing from another version\'s prefix', async () => {
    const { deps } = testDeps();
    await approveMonth(deps);
    const filing = await filingOf(7);
    await expect(filingFile(db, filing.id, deps)).rejects.toBeInstanceOf(HrNotFoundError);
    await generateFiling(db, filing.id, deps, mgr);
    const main = await filingFile(db, filing.id, deps);
    expect(main).toMatchObject({ fileName: 'loonaangifte-2026.xml', contentType: 'application/xml' });
    expect(await new Response(main.object.body).text()).toContain('<aangifte');
    const extra = await filingFile(db, filing.id, deps, 'loonaangifte-2026-07-summary.pdf');
    expect(extra.contentType).toBe('application/pdf');
    await expect(filingFile(db, filing.id, deps, 'nope.pdf')).rejects.toBeInstanceOf(HrNotFoundError);
  });

  it('refuses to build without a loonheffingennummer, passes builder errors on, and reports a missing builder', async () => {
    const { deps } = testDeps();
    await approveMonth(deps);
    const filing = await filingOf(7);
    await updateEmployer(db, world.employerId, { nlSettings: { loonheffingennummer: null } }, TEST_KEYRING);
    await expect(generateFiling(db, filing.id, deps, mgr)).rejects.toMatchObject({ code: 'EMPLOYER_INCOMPLETE' });
    await updateEmployer(db, world.employerId, { nlSettings: { loonheffingennummer: '123456789L01' } }, TEST_KEYRING);

    const failing = testDeps({
      engines: { ...deps.engines, buildLoonaangifte: () => ({ file: { fileName: 'x.xml', contentType: 'application/xml', content: '' }, summary: {}, amountDueCents: 0, issues: [{ severity: 'error', code: 'invalid_bsn' }] }) },
    }).deps;
    await expect(generateFiling(db, filing.id, failing, mgr)).rejects.toMatchObject({ code: 'FILING_INVALID', status: 422 });
    expect((await filingOf(7)).status).toBe('open');

    const missing = testDeps({
      engines: {
        ...deps.engines,
        buildLoonaangifte: () => {
          throw new Error('Loonaangifte is not implemented yet');
        },
      },
    }).deps;
    await expect(generateFiling(db, filing.id, missing, mgr)).rejects.toMatchObject({ code: 'ENGINE_UNAVAILABLE', status: 503 });
  });

  it('needs storage', async () => {
    const { deps } = testDeps({ bucket: null });
    await approveMonth(deps);
    await expect(generateFiling(db, (await filingOf(7)).id, deps, mgr)).rejects.toMatchObject({ code: 'STORAGE_UNAVAILABLE' });
  });

  it('puts a correction of an earlier month into the current return as a full replacement of that month', async () => {
    const { deps, calls } = testDeps();
    const july = await approveMonth(deps);
    const correction = await createRun(db, { employerId: world.employerId, kind: 'correction', correctsRunId: july.id, employeeIds: [world.eva.id], payDate: '2026-08-05' }, prep);
    await createRunInput(db, correction.id, { employeeId: world.eva.id, code: 'bonus', amount: 100 }, prep);
    await calculateRun(db, correction.id, deps, prep);
    await approveRun(db, correction.id, deps, boss);

    // The correction was paid in August, so August's return carries it; July's own return is untouched.
    expect((await filingOf(7)).status).toBe('open');
    const august = await filingOf(8);
    await generateFiling(db, august.id, deps, mgr);
    const input = calls.loonaangifte.at(-1)!;
    expect(input.period).toEqual({ start: '2026-08-01', end: '2026-08-31' });
    expect(input.ikvs).toEqual([]);
    expect(input.corrections).toHaveLength(1);
    expect(input.corrections[0]!.period).toEqual({ start: '2026-07-01', end: '2026-07-31' });
    // Everyone paid in July, with Eva's original and correction added up.
    expect(input.corrections[0]!.ikvs).toHaveLength(2);
    expect(input.corrections[0]!.ikvs.find((ikv) => ikv.identity.surname === 'Alder')!.filing.amounts).toMatchObject({ loonLbPh: 310_000, wageTax: 62_000 });
  });

  it('counts a correction paid in the same month as part of that month\'s return', async () => {
    const { deps, calls } = testDeps();
    const july = await approveMonth(deps);
    const correction = await createRun(db, { employerId: world.employerId, kind: 'correction', correctsRunId: july.id, employeeIds: [world.eva.id], payDate: '2026-07-28' }, prep);
    await createRunInput(db, correction.id, { employeeId: world.eva.id, code: 'bonus', amount: 100 }, prep);
    await calculateRun(db, correction.id, deps, prep);
    await approveRun(db, correction.id, deps, boss);
    const filing = await filingOf(7);
    expect(filing.status).toBe('open');
    await generateFiling(db, filing.id, deps, mgr);
    const input = calls.loonaangifte.at(-1)!;
    expect(input.corrections).toEqual([]);
    expect(input.ikvs.find((ikv) => ikv.identity.surname === 'Alder')!.filing.amounts).toMatchObject({ loonLbPh: 310_000 });
  });
});

describe('submitting over Digipoort', () => {
  const gateway = (status: 'submitted' | 'accepted' | 'rejected' = 'submitted') => {
    const sent: Array<{ xml: string; lhn: string }> = [];
    const impl: DigipoortGateway = {
      submit: async (input) => (sent.push({ xml: input.xml, lhn: input.loonheffingennummer }), { reference: 'DP-1' }),
      status: async () => ({ status, message: status === 'rejected' ? 'Foutieve BSN' : null }),
    };
    return { impl, sent };
  };

  async function readyFiling(deps: ReturnType<typeof testDeps>['deps']) {
    await approveMonth(deps);
    const filing = await filingOf(7);
    await generateFiling(db, filing.id, deps, mgr);
    return filing.id;
  }

  it('answers DIGIPOORT_NOT_CONFIGURED without a gateway or the flag', async () => {
    const { deps } = testDeps();
    const id = await readyFiling(deps);
    await expect(submitFiling(db, id, deps, { userId: 'u', flagOn: true })).rejects.toMatchObject({ code: 'DIGIPOORT_NOT_CONFIGURED', status: 409 });
    const { impl } = gateway();
    const configured = testDeps({ digipoort: impl }).deps;
    await expect(submitFiling(db, id, configured, { userId: 'u', flagOn: false })).rejects.toMatchObject({ code: 'DIGIPOORT_NOT_CONFIGURED' });
    const [row] = await db.select().from(schema.hrPayrollFilings).where(eq(schema.hrPayrollFilings.id, id));
    expect(toFilingDto(row!, { employerName: 'Acme BV', digipoortAvailable: false }).canSubmit).toBe(false);
  });

  it('sends the stored XML, records the reference, and follows the status', async () => {
    const { impl, sent } = gateway('accepted');
    const { deps } = testDeps({ digipoort: impl });
    const id = await readyFiling(deps);
    const [before] = await db.select().from(schema.hrPayrollFilings).where(eq(schema.hrPayrollFilings.id, id));
    expect(toFilingDto(before!, { employerName: 'Acme BV', digipoortAvailable: true }).canSubmit).toBe(true);

    const submitted = await submitFiling(db, id, deps, { userId: 'user_mgr', flagOn: true });
    expect(submitted).toMatchObject({ status: 'submitted', channel: 'digipoort', externalReference: 'DP-1', submittedBy: 'user_mgr' });
    expect(sent).toEqual([{ xml: '<aangifte ikvs="2" corrections="0"/>', lhn: '123456789L01' }]);
    await expect(submitFiling(db, id, deps, { userId: 'u', flagOn: true })).rejects.toBeInstanceOf(HrConflictError);

    const refreshed = await refreshFilingStatus(db, id, deps, { userId: 'u', flagOn: true });
    expect(refreshed.status).toBe('accepted');
    expect(refreshed.history.at(-1)).toMatchObject({ status: 'accepted' });
  });

  it('allows another attempt after a rejection and records why', async () => {
    const { impl } = gateway('rejected');
    const { deps } = testDeps({ digipoort: impl });
    const id = await readyFiling(deps);
    await submitFiling(db, id, deps, { userId: 'u', flagOn: true });
    const rejected = await refreshFilingStatus(db, id, deps, { userId: 'u', flagOn: true });
    expect(rejected.status).toBe('rejected');
    expect(rejected.history.at(-1)!.message).toBe('Foutieve BSN');
    await expect(submitFiling(db, id, deps, { userId: 'u', flagOn: true })).resolves.toMatchObject({ status: 'submitted' });
  });

  it('wraps a gateway failure and leaves the filing as it was', async () => {
    const { deps } = testDeps({ digipoort: { submit: async () => { throw new Error('connection refused'); }, status: async () => ({ status: 'submitted' }) } });
    const id = await readyFiling(deps);
    await expect(submitFiling(db, id, deps, { userId: 'u', flagOn: true })).rejects.toMatchObject({ code: 'DIGIPOORT_ERROR', status: 503 });
    expect((await filingOf(7)).status).toBe('ready');
  });

  it('records a filing the employer made itself', async () => {
    const { deps } = testDeps();
    await approveMonth(deps);
    const filing = await filingOf(7);
    await expect(markFilingFiled(db, filing.id, {}, { userId: 'u', now: new Date() })).rejects.toThrow(/Generate the filing/);
    await generateFiling(db, filing.id, deps, mgr);
    const filed = await markFilingFiled(db, filing.id, { externalReference: 'LH-9', filedOn: '2026-08-20' }, { userId: 'user_mgr', now: new Date('2026-08-21T09:00:00Z') });
    expect(filed).toMatchObject({ status: 'filed', channel: 'manual', externalReference: 'LH-9', submittedBy: 'user_mgr' });
    expect(filed.submittedAt?.toISOString()).toBe('2026-08-20T12:00:00.000Z');
    await expect(markFilingFiled(db, filing.id, {}, { userId: 'u', now: new Date() })).rejects.toBeInstanceOf(HrConflictError);
  });
});

describe('overview', () => {
  it('summarises setup, the next period of each schedule, recent runs and filings due', async () => {
    const { deps } = testDeps();
    const empty = await payrollOverview(db, TEST_KEYRING, { today: '2026-08-01', digipoortAvailable: false });
    expect(empty.setup).toEqual({ hasEmployer: true, hasSchedule: true, employeesOnPayroll: 2, employeesNotReady: 0 });
    expect(empty.upcoming[0]).toMatchObject({ scheduleName: 'Monthly', runId: null, runStatus: null, period: { start: '2026-01-01' } });

    const july = await approveMonth(deps);
    const draft = await createRun(db, { employerId: world.employerId, kind: 'regular', payScheduleId: world.scheduleId, periodStart: '2026-08-01' }, prep);
    const overview = await payrollOverview(db, TEST_KEYRING, { today: '2026-08-01', digipoortAvailable: false });
    expect(overview.upcoming[0]).toMatchObject({ runId: draft.id, runStatus: 'draft', period: { start: '2026-08-01', end: '2026-08-31' }, employerName: 'Acme BV', country: 'NL' });
    expect(overview.recentRuns.map((r) => r.id)).toEqual([draft.id, july.id]);
    expect(overview.filingsDue).toHaveLength(1);
    expect(overview.filingsDue[0]).toMatchObject({ kind: 'nl_loonaangifte', period: 7, status: 'open', dueDate: '2026-08-28', canSubmit: false });
    expect(overview.employers[0]).toMatchObject({ name: 'Acme BV', employeeCount: 2 });

    await db.update(schema.hrPayrollFilings).set({ dueDate: '2027-02-28' });
    expect((await payrollOverview(db, TEST_KEYRING, { today: '2026-08-01', digipoortAvailable: false })).filingsDue).toEqual([]);
    expect((await listFilings(db, { year: 2026, kind: 'nl_loonaangifte' }, false))).toHaveLength(1);
    expect((await listFilings(db, { status: 'filed' }, false))).toHaveLength(0);
  });

  it('counts people who cannot be paid yet', async () => {
    const nobody = await createTestEmployee(db, { firstName: 'Nina' });
    await upsertProfile(db, nobody.id, { employerId: world.employerId, payScheduleId: world.scheduleId });
    const overview = await payrollOverview(db, TEST_KEYRING, { today: '2026-08-01', digipoortAvailable: false });
    expect(overview.setup).toMatchObject({ employeesOnPayroll: 3, employeesNotReady: 1 });
  });
});

describe('US payroll', () => {
  async function usWorld() {
    await resetPayrollTables(db);
    const employer = await createEmployer(
      db,
      { name: 'Acme Inc', legalName: 'Acme Inc.', country: 'US', address: { line1: '1 Main St', city: 'Austin', region: 'TX', postalCode: '78701', country: 'US' }, usSettings: { ein: '12-3456789', depositSchedule: 'monthly', states: { TX: { withholdingAccountNumber: 'W-1', suiAccountNumber: 'S-1', suiRates: { '2026': 2.7 } } } } },
      { createdBy: 'u', keyring: TEST_KEYRING },
    );
    await setEmployerBank(db, employer.id, { routingNumber: VALID_ROUTING, accountNumber: '987654321', accountType: 'checking', nachaCompanyId: '1123456789', bankName: 'First Bank' }, TEST_KEYRING);
    const schedule = await createSchedule(db, { employerId: employer.id, name: 'Biweekly', frequency: 'biweekly', anchorDate: '2026-01-05', payDateRule: { kind: 'offset_after_end', days: 5 } });
    const pat = await createTestEmployee(db, { firstName: 'Pat', lastName: 'Doe' });
    await upsertProfile(db, pat.id, { employerId: employer.id, payScheduleId: schedule.id, startDate: '2025-06-01', us: { workState: 'TX', flsaStatus: 'exempt' } });
    await createCompensation(db, pat.id, { effectiveFrom: '2025-06-01', payType: 'salary', amount: 52_000, period: 'year' }, { createdBy: 'u' });
    await setPaymentDetails(
      db,
      pat.id,
      { nationalId: VALID_SSN, bankRoutingNumber: VALID_ROUTING, bankAccountNumber: '123456789', bankAccountType: 'savings', homeAddress: { line1: '9 Oak St', city: 'Austin', region: 'TX', postalCode: '78702' } },
      { keyring: TEST_KEYRING, selfService: false },
    );
    await createElection(
      db,
      pat.id,
      { kind: 'us_w4', effectiveFrom: '2026-01-01', data: { formYear: 2026, filingStatus: 'single', multipleJobs: false, dependentsAmount: 0, otherIncome: 0, deductions: 0, extraWithholding: 0, exempt: false }, signatureName: 'Pat Doe' },
      { signedBy: 'u', source: 'admin' },
    );
    return { employerId: employer.id, scheduleId: schedule.id, pat };
  }

  it('builds the engine input from the W-4, work state and SUI rate, carries open overtime workweeks into the new year', async () => {
    const us = await usWorld();
    const seen: Array<Record<string, unknown>> = [];
    const base = testDeps();
    const { deps } = testDeps({ engines: { ...base.deps.engines, calculatePayslip: (input) => (seen.push(input as never), fakeCalculate(input)) } });
    // Last year's final payslip: an open workweek carried, everything else that resets.
    await db.insert(schema.hrPayRuns).values({ id: 'run_2025', employerId: us.employerId, country: 'US', currency: 'USD', periodStart: '2025-12-15', periodEnd: '2025-12-28', payDate: '2026-01-02', taxYear: 2025, periodNumber: 26, status: 'paid' });
    await db.insert(schema.hrPayslips).values({
      id: 'slip_2025',
      runId: 'run_2025',
      employeeId: us.pat.id,
      employerId: us.employerId,
      country: 'US',
      currency: 'USD',
      status: 'final',
      number: '2025-0026',
      periodStart: '2025-12-15',
      periodEnd: '2025-12-28',
      payDate: '2025-12-31',
      taxYear: 2025,
      periodNumber: 26,
      ytd: { 'us.gross': 5_000_000, 'us.ot_carry.2025-12-28.hours': 1_200, 'us.fit': 800_000 },
    });
    const run = await createRun(db, { employerId: us.employerId, kind: 'regular', payScheduleId: us.scheduleId }, prep);
    // The period before it (22 Dec to 4 Jan) is paid on 9 January, so it is the year's first.
    expect(run).toMatchObject({ periodStart: '2026-01-05', periodEnd: '2026-01-18', payDate: '2026-01-23', taxYear: 2026, periodNumber: 2 });
    const calculated = await calculateRun(db, run.id, deps, prep);
    expect(calculated.issues.filter((i) => i.severity === 'error')).toEqual([]);

    const input = seen[0] as {
      country: string;
      period: { frequency: string; periodsPerYear: number };
      ytd: Record<string, number>;
      employer: { workweekStartDay: number; suiRatePercent: Record<string, number | null>; employeeCountEstimate: number };
      us: { workState: string; flsaStatus: string; w4: { filingStatus: string; formYear: number } | null; stateCertificates: Record<string, unknown> };
    };
    expect(input.country).toBe('US');
    expect(input.period).toMatchObject({ frequency: 'biweekly', periodsPerYear: 26 });
    // The year starts empty, except for the open overtime workweek.
    expect(input.ytd).toEqual({ 'us.ot_carry.2025-12-28.hours': 1_200 });
    expect(input.employer).toMatchObject({ workweekStartDay: 0, suiRatePercent: { TX: 2.7 }, employeeCountEstimate: 1 });
    expect(input.us).toMatchObject({ workState: 'TX', flsaStatus: 'exempt', w4: { filingStatus: 'single', formYear: 2026 }, stateCertificates: {} });
  });

  it('creates 941, 940, W-2 and state filings, builds them, and produces the ACH file and the W-2 copy', async () => {
    const us = await usWorld();
    const states = { TX: { stateWages: 100, stateIncomeTax: 0, suiWages: 100, suiGrossWages: 100, suiEmployerTax: 3, suiEmployeeTax: 0, programs: {} } };
    const base = testDeps();
    const { calls } = base;
    const { deps, stored } = testDeps({
      engines: {
        ...base.deps.engines,
        calculatePayslip: (input) => {
          const result = fakeCalculate(input);
          return { ...result, filingData: { ...(result.filingData as object), states } as never };
        },
      },
    });
    const run = await createRun(db, { employerId: us.employerId, kind: 'regular', payScheduleId: us.scheduleId }, prep);
    await calculateRun(db, run.id, deps, prep);
    const approved = await approveRun(db, run.id, deps, boss);
    const filings = await db.select().from(schema.hrPayrollFilings);
    const key = (f: (typeof filings)[number]) => `${f.kind}${f.state ? `:${f.state}` : ''}:${f.period}`;
    expect(filings.map(key).sort()).toEqual(['us_940:0', 'us_941:1', 'us_state_unemployment:TX:1', 'us_state_withholding:TX:1', 'us_w2:0'].sort());
    expect(approved.filings).toHaveLength(5);
    const f941 = filings.find((f) => f.kind === 'us_941')!;
    expect(f941).toMatchObject({ taxYear: 2026, periodStart: '2026-01-01', periodEnd: '2026-03-31', dueDate: '2026-04-30', status: 'open' });
    expect(filings.find((f) => f.kind === 'us_940')).toMatchObject({ periodStart: '2026-01-01', periodEnd: '2026-12-31', dueDate: '2027-01-31' });

    const built = await generateFiling(db, f941.id, deps, mgr);
    expect(built).toMatchObject({ status: 'ready', fileName: '941-2026-q1.pdf', contentType: 'application/pdf', amountDue: '123.45', dueDate: '2026-10-31' });
    expect(calls.f941[0]).toMatchObject({ taxYear: 2026, quarter: 1, employer: { ein: '12-3456789', depositSchedule: 'monthly' } });
    // The pay period goes with each payslip (941 line 1).
    expect(calls.f941[0]!.payslips[0]).toMatchObject({ periodStart: '2026-01-05', periodEnd: '2026-01-18', payDate: '2026-01-23' });
    expect(new TextDecoder().decode(stored.get(built.fileKey!)!.body.slice(0, 5))).toBe('%PDF-');

    // A state report is a wage list: the CSV is the file, the printable PDF sits beside it.
    const wh = filings.find((f) => f.kind === 'us_state_withholding')!;
    const report = await generateFiling(db, wh.id, deps, mgr);
    expect(report).toMatchObject({ fileName: 'TX-wh.csv', contentType: 'text/csv' });
    expect(calls.states).toContainEqual({ kind: 'withholding', state: 'TX', employees: 1 });
    expect([...stored.keys()].some((k) => k.endsWith('.pdf') && k.includes(wh.id))).toBe(true);
    await generateFiling(db, filings.find((f) => f.kind === 'us_w2')!.id, deps, mgr);
    await generateFiling(db, filings.find((f) => f.kind === 'us_940')!.id, deps, mgr);

    // The NACHA file: the employer's bank as originator, the employee's account as the credit.
    const ach = await buildPaymentFile(db, run.id, deps);
    expect(ach.fileName).toBe('payroll.ach');
    expect(calls.nacha[0]).toMatchObject({
      originator: { companyName: 'Acme Inc', companyId: '1123456789', odfiRouting: VALID_ROUTING, odfiName: 'First Bank' },
      effectiveDate: '2026-08-01',
    });
    expect(calls.nacha[0]!.credits).toEqual([
      { individualId: expect.any(String), individualName: 'Pat Doe', routingNumber: VALID_ROUTING, accountNumber: '123456789', accountType: 'savings', amountCents: expect.any(Number) },
    ]);

    // The W-2 employee copy masks the SSN; the W-3 / state files built above used the full one.
    const { fileName } = await annualStatementPdf(db, us.pat.id, 2026, us.employerId, deps);
    expect(fileName).toBe('w2-2026.pdf');
    expect(calls.w2[0]!.employee.ssn).toBe('***-**-6789');
    expect(calls.w2[0]!.employer.address).toEqual(['1 Main St', 'Austin, TX 78701']);
    expect(payslipFileName('US', { periodStart: '2026-01-05', payDate: '2026-01-23' })).toBe('payslip-2026-01-23.pdf');
  });
});

describe('billing ledger', () => {
  it('writes one row per payslip and never counts a payslip twice', async () => {
    const master = await createMasterPgliteDb();
    const events = [
      { workspaceId: 'ws_1', month: '2026-07', country: 'NL' as const, employerId: 'e1', runId: 'r1', payslipId: 'p1' },
      { workspaceId: 'ws_1', month: '2026-07', country: 'NL' as const, employerId: 'e1', runId: 'r1', payslipId: 'p2' },
    ];
    await writeUsageEvents(master.db, events);
    await writeUsageEvents(master.db, events);
    await writeUsageEvents(master.db, [...events, { ...events[0]!, payslipId: 'p3' }]);
    await writeUsageEvents(master.db, []);
    const rows = await master.db.select().from(masterSchema.payrollUsageEvents);
    expect(rows.map((r: { payslipId: string }) => r.payslipId).sort()).toEqual(['p1', 'p2', 'p3']);
    // The same payslip id in another workspace is a different row.
    await writeUsageEvents(master.db, [{ ...events[0]!, workspaceId: 'ws_2' }]);
    expect(await master.db.select().from(masterSchema.payrollUsageEvents)).toHaveLength(4);
    await master.close();
  }, 120_000);
});

void createRunInput;
