/**
 * Approving and paying a run: four eyes, numbering, PDFs in R2, billing, the
 * WeldBooks journal, filings, the payment file, payslip access, annual statements.
 */

import { eq } from 'drizzle-orm';
import { PDFDocument } from 'pdf-lib';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Database } from '@weldsuite/worker-kit/db';
import { schema } from '@weldsuite/worker-kit/db';
import { createPayrollDb, resetPayrollTables } from '../../../test/payroll-db';
import { TEST_KEYRING, VALID_BSN, VALID_IBAN, VALID_IBAN_2, nlWorld, testDeps, type NlWorld } from '../../../test/payroll-fixtures';
import { HrNotFoundError } from '../shared';
import { annualStatementPdf, listAnnualStatements } from './annual';
import { setPaymentDetails } from './employees';
import { approveRun, markRunPaid } from './approve';
import { calculateRun } from './calculate';
import { buildPaymentFile, buildRunReport } from './files';
import { postRunJournal } from './journal';
import { listEmployeePayslips, markPayslipViewed, myPayslips, payslipPdf, requirePayslip } from './payslips';
import { collectRunInputs, createRun, getRunDetail } from './runs';

let db: Database;
let world: NlWorld;
const prep = { userId: 'user_prep' };
const boss = { userId: 'user_boss' };

beforeAll(async () => {
  db = await createPayrollDb();
}, 120_000);

beforeEach(async () => {
  await resetPayrollTables(db);
  world = await nlWorld(db);
});

const julyRun = () =>
  createRun(db, { employerId: world.employerId, kind: 'regular', payScheduleId: world.scheduleId, periodStart: '2026-07-01' }, prep);

async function calculated(deps = testDeps().deps) {
  const run = await julyRun();
  await calculateRun(db, run.id, deps, prep);
  return run;
}

describe('approval rules', () => {
  it('refuses a run that is not calculated, or has errors', async () => {
    const { deps } = testDeps();
    const run = await julyRun();
    await expect(approveRun(db, run.id, deps, boss)).rejects.toMatchObject({ code: 'RUN_NOT_CALCULATED', status: 409 });

    await db.update(schema.hrCompensations).set({ effectiveFrom: '2027-01-01' }).where(eq(schema.hrCompensations.employeeId, world.eva.id));
    await calculateRun(db, run.id, deps, prep);
    await expect(approveRun(db, run.id, deps, boss)).rejects.toMatchObject({ code: 'RUN_HAS_ERRORS', status: 409 });
  });

  it('enforces four eyes per employer: the member who calculated cannot approve', async () => {
    await resetPayrollTables(db);
    world = await nlWorld(db, { requireSeparateApprover: true });
    const { deps } = testDeps();
    const run = await calculated(deps);
    expect((await getRunDetail(db, run.id, { userId: 'user_prep' })).canApprove).toBe(false);
    expect((await getRunDetail(db, run.id, { userId: 'user_boss' })).canApprove).toBe(true);
    await expect(approveRun(db, run.id, deps, prep)).rejects.toMatchObject({ code: 'FOUR_EYES', status: 409 });
    await expect(approveRun(db, run.id, deps, boss)).resolves.toMatchObject({ run: { status: 'approved', approvedBy: 'user_boss' } });
  });

  it('lets the same person approve when four eyes is off', async () => {
    const { deps } = testDeps();
    const run = await calculated(deps);
    expect((await getRunDetail(db, run.id, prep)).canApprove).toBe(true);
    await expect(approveRun(db, run.id, deps, prep)).resolves.toBeDefined();
  });

  it('asks for a new calculation when employee data changed after it', async () => {
    const { deps } = testDeps();
    const run = await calculated(deps);
    // A day ahead: pglite's column defaults use the machine's local time zone, so a few seconds would not be later.
    await db.update(schema.hrPayrollProfiles).set({ updatedAt: new Date(Date.now() + 86_400_000) }).where(eq(schema.hrPayrollProfiles.employeeId, world.eva.id));
    await expect(approveRun(db, run.id, deps, boss)).rejects.toMatchObject({ code: 'RECALCULATE_REQUIRED' });
    await calculateRun(db, run.id, deps, prep);
    // The new calculation read the changed data, so approving works.
    await expect(approveRun(db, run.id, deps, boss)).resolves.toBeDefined();
  });

  it('cannot approve a run twice', async () => {
    const { deps } = testDeps();
    const run = await calculated(deps);
    await approveRun(db, run.id, deps, boss);
    await expect(approveRun(db, run.id, deps, boss)).rejects.toMatchObject({ code: 'RUN_NOT_CALCULATED' });
  });

  it('refuses a run with nobody in it', async () => {
    const { deps } = testDeps();
    const run = await julyRun();
    await db.update(schema.hrPayRuns).set({ excludedEmployeeIds: [world.eva.id, world.hans.id] }).where(eq(schema.hrPayRuns.id, run.id));
    await calculateRun(db, run.id, deps, prep);
    await expect(approveRun(db, run.id, deps, boss)).rejects.toMatchObject({ code: 'RUN_EMPTY' });
  });
});

describe('approveRun', () => {
  it('finalises and numbers the payslips, stores the PDFs, meters them, posts the journal and creates the filing', async () => {
    const { deps, meterCalls, booksCalls, stored } = testDeps();
    const run = await calculated(deps);
    const result = await approveRun(db, run.id, deps, boss);

    expect(result.run).toMatchObject({ status: 'approved', approvedBy: 'user_boss' });
    expect(result.payslips.map((p) => p.number)).toEqual(['2026-0001', '2026-0002']);
    const slips = await db.select().from(schema.hrPayslips).where(eq(schema.hrPayslips.runId, run.id));
    expect(slips.every((s) => s.status === 'final')).toBe(true);
    const eva = slips.find((s) => s.employeeId === world.eva.id)!;
    expect(eva.number).toBe('2026-0001');
    expect(eva.fileKey).toBe(`workspaces/org_test/hr/payslips/2026/${eva.id}.pdf`);

    // A real PDF in R2.
    const pdf = stored.get(eva.fileKey!)!;
    expect(pdf.contentType).toBe('application/pdf');
    expect((await PDFDocument.load(pdf.body)).getPageCount()).toBeGreaterThanOrEqual(1);
    expect(result.pdfFailures).toBe(0);

    // Billing: one event per payslip, keyed by the master workspace id.
    expect(meterCalls).toHaveLength(1);
    expect(meterCalls[0]!.map((e) => [e.workspaceId, e.month, e.country, e.runId, e.employerId]).sort()).toEqual(
      slips.map((s) => ['ws_test', '2026-07', 'NL', run.id, world.employerId]),
    );
    expect(result.metered).toBe(2);
    expect(meterCalls[0]!.map((e) => e.payslipId).sort()).toEqual(slips.map((s) => s.id).sort());

    // No accounting entity linked: skipped, nothing posted.
    expect(booksCalls).toHaveLength(0);
    expect(result.journal.status).toBe('skipped');
    expect((await getRunDetail(db, run.id, boss)).journalStatus).toBe('skipped');

    // The month's loonaangifte is open, due the 28th of the next month in the fake.
    const [filing] = await db.select().from(schema.hrPayrollFilings);
    expect(filing).toMatchObject({ employerId: world.employerId, kind: 'nl_loonaangifte', taxYear: 2026, period: 7, periodStart: '2026-07-01', periodEnd: '2026-07-31', status: 'open', dueDate: '2026-08-28', version: 1 });
    expect(result.filings).toEqual([{ id: filing!.id, created: true }]);
  });

  it('numbers continue per employer and year across runs', async () => {
    const { deps } = testDeps();
    const june = await createRun(db, { employerId: world.employerId, kind: 'regular', payScheduleId: world.scheduleId, periodStart: '2026-06-01' }, prep);
    await calculateRun(db, june.id, deps, prep);
    await approveRun(db, june.id, deps, boss);
    const july = await calculated(deps);
    const result = await approveRun(db, july.id, deps, boss);
    expect(result.payslips.map((p) => p.number)).toEqual(['2026-0003', '2026-0004']);
    // Same month's filing is reused, the next month's is new.
    const filings = await db.select().from(schema.hrPayrollFilings);
    expect(filings.map((f) => f.period).sort()).toEqual([6, 7]);
  });

  it('reopens an existing filing that new payslips changed', async () => {
    const { deps } = testDeps();
    const first = await calculated(deps);
    await approveRun(db, first.id, deps, boss);
    const [filing] = await db.select().from(schema.hrPayrollFilings);
    await db.update(schema.hrPayrollFilings).set({ status: 'filed' }).where(eq(schema.hrPayrollFilings.id, filing!.id));
    const offCycle = await createRun(db, { employerId: world.employerId, kind: 'off_cycle', periodStart: '2026-07-01', periodEnd: '2026-07-31', payDate: '2026-07-30', employeeIds: [world.eva.id] }, prep);
    await calculateRun(db, offCycle.id, deps, prep);
    const result = await approveRun(db, offCycle.id, deps, boss);
    expect(result.filings).toEqual([{ id: filing!.id, created: false }]);
    const [after] = await db.select().from(schema.hrPayrollFilings);
    expect(after!.status).toBe('open');
    expect(after!.history.at(-1)).toMatchObject({ status: 'open' });
  });

  it('posts the journal to WeldBooks when the employer is linked, with totals that balance', async () => {
    await resetPayrollTables(db);
    await db.insert(schema.entities).values({ id: 'ent_nl', name: 'Acme Books', jurisdictionCode: 'NL' });
    world = await nlWorld(db, { accountingEntityId: 'ent_nl' });
    const { deps, booksCalls } = testDeps();
    const run = await julyRun();
    await collectRunInputs(db, run.id, TEST_KEYRING, prep);
    await db.insert(schema.hrDeclarations).values({ id: 'dcl_1', employeeId: world.eva.id, expenseDate: '2026-07-10', category: 'travel', description: 'Train', amount: '45.50', currency: 'EUR', status: 'approved' });
    await collectRunInputs(db, run.id, TEST_KEYRING, prep);
    await calculateRun(db, run.id, deps, prep);
    const result = await approveRun(db, run.id, deps, boss);

    expect(booksCalls).toHaveLength(1);
    const call = booksCalls[0]!;
    expect(call.workspaceKey).toBe('org_test');
    expect(call.input).toMatchObject({ entityId: 'ent_nl', externalId: run.id, payDate: '2026-07-24', periodStart: '2026-07-01', periodEnd: '2026-07-31', country: 'NL', postedBy: 'user_boss' });
    // Eva 3000 gross, 600 tax, 45.50 reimbursed: net 2445.50 of which 45.50 is the reimbursement.
    expect(call.input.totals).toEqual({
      grossWages: 3000,
      employerTaxes: 300,
      employerBenefits: 0,
      reimbursements: 45.5,
      employeeTaxes: 600,
      employeeDeductions: 0,
      netPay: 2400,
    });
    const t = call.input.totals;
    expect(t.grossWages).toBeCloseTo(t.netPay + t.employeeTaxes + t.employeeDeductions, 6);
    expect(result.journal).toMatchObject({ status: 'posted', journalEntryId: 'je_fake' });
    expect(result.run).toMatchObject({ journalStatus: 'posted', journalEntryId: 'je_fake', journalError: null });
  });

  it('records a failed journal with its message and retries it', async () => {
    await resetPayrollTables(db);
    await db.insert(schema.entities).values({ id: 'ent_nl', name: 'Acme Books', jurisdictionCode: 'NL' });
    world = await nlWorld(db, { accountingEntityId: 'ent_nl' });
    let fail = true;
    const { deps } = testDeps({
      books: {
        postPayroll: async () => (fail ? { status: 'failed', error: 'The period is locked' } : { status: 'posted', importId: 'pri_1', journalEntryId: 'je_1', duplicate: false }),
      },
    });
    const run = await calculated(deps);
    const result = await approveRun(db, run.id, deps, boss);
    // A failed journal never undoes the approval.
    expect(result.run).toMatchObject({ status: 'approved', journalStatus: 'failed', journalError: 'The period is locked' });
    fail = false;
    const retry = await postRunJournal(db, run.id, deps, boss);
    expect(retry).toEqual({ status: 'posted', error: null, journalEntryId: 'je_1' });
    expect((await getRunDetail(db, run.id, boss))).toMatchObject({ journalStatus: 'posted', journalError: null });
  });

  it('survives a billing failure and a PDF that cannot be stored', async () => {
    const base = testDeps();
    const { deps } = testDeps({
      meter: async () => {
        throw new Error('master db down');
      },
      bucket: { ...(base.deps.bucket as object), put: async () => { throw new Error('r2 down'); } } as unknown as R2Bucket,
    });
    const run = await calculated(deps);
    const result = await approveRun(db, run.id, deps, boss);
    expect(result.run.status).toBe('approved');
    expect(result.metered).toBe(0);
    const slips = await db.select().from(schema.hrPayslips).where(eq(schema.hrPayslips.runId, run.id));
    expect(slips.every((s) => s.status === 'final' && s.fileKey === null)).toBe(true);
    // The PDF is rendered on first download instead.
    const bytes = await payslipPdf(db, slips[0]!, deps);
    expect(new TextDecoder().decode(bytes.slice(0, 5))).toBe('%PDF-');
  });

  it('does not charge for payslips of a correction run', async () => {
    const { deps, meterCalls } = testDeps();
    const run = await calculated(deps);
    await approveRun(db, run.id, deps, boss);
    const correction = await createRun(db, { employerId: world.employerId, kind: 'correction', correctsRunId: run.id, employeeIds: [world.eva.id], payDate: '2026-08-05' }, prep);
    await calculateRun(db, correction.id, deps, prep);
    await approveRun(db, correction.id, deps, boss);
    expect(meterCalls).toHaveLength(1);
  });
});

describe('markRunPaid', () => {
  it('marks the run paid and the reimbursed declarations paid', async () => {
    const { deps } = testDeps();
    await db.insert(schema.hrDeclarations).values({ id: 'dcl_1', employeeId: world.eva.id, expenseDate: '2026-07-10', category: 'travel', description: 'Train', amount: '45.50', currency: 'EUR', status: 'approved' });
    const run = await julyRun();
    await collectRunInputs(db, run.id, TEST_KEYRING, prep);
    await calculateRun(db, run.id, deps, prep);
    await approveRun(db, run.id, deps, boss);

    const result = await markRunPaid(db, run.id, { paidOn: '2026-07-24' }, { userId: 'user_boss', now: new Date('2026-07-24T10:00:00Z') });
    expect(result.run).toMatchObject({ status: 'paid', paidBy: 'user_boss' });
    expect(result.declarationIds).toEqual(['dcl_1']);
    const [declaration] = await db.select().from(schema.hrDeclarations);
    expect(declaration).toMatchObject({ status: 'paid', paidBy: 'user_boss' });
    await expect(markRunPaid(db, run.id, {}, { userId: 'u', now: new Date() })).rejects.toThrow(/approved run/);
  });

  it('refuses a run that is not approved', async () => {
    const run = await calculated();
    await expect(markRunPaid(db, run.id, {}, { userId: 'u', now: new Date() })).rejects.toThrow(/only an approved run/);
  });
});

describe('payment file and report', () => {
  it('builds the SEPA batch from approved net pay and each employee\'s IBAN', async () => {
    const { deps, calls } = testDeps();
    const run = await calculated(deps);
    await expect(buildPaymentFile(db, run.id, deps)).rejects.toMatchObject({ code: 'RUN_NOT_APPROVED' });
    await approveRun(db, run.id, deps, boss);
    const file = await buildPaymentFile(db, run.id, deps);
    expect(file).toMatchObject({ fileName: 'salary.xml', contentType: 'application/xml' });
    const input = calls.sepa[0]!;
    expect(input).toMatchObject({ messageId: `SAL-${run.id.replaceAll("_", "-")}`.slice(0, 35), executionDate: '2026-08-01', tax: null });
    expect(input.debtor).toEqual({ name: 'Acme B.V.', iban: VALID_IBAN, bic: null });
    // Hans worked no hours: nothing to pay. Eva's net pay goes to her own IBAN.
    expect(input.salaries).toHaveLength(1);
    expect(input.salaries[0]).toMatchObject({ amountCents: 240_000, remittance: 'Salaris juli 2026', creditor: { iban: VALID_IBAN_2 } });
    expect(input.salaries[0]!.endToEndId).toMatch(/^[A-Za-z0-9-]{1,35}$/);
    expect(input.messageId).toMatch(/^[A-Za-z0-9-]{1,35}$/);
  });

  it('refuses when the employer or an employee has no bank account', async () => {
    const { deps } = testDeps();
    const run = await calculated(deps);
    await approveRun(db, run.id, deps, boss);
    // As if the payslips were approved before the account was sealed into them: the current details are all there is.
    for (const slip of await db.select().from(schema.hrPayslips).where(eq(schema.hrPayslips.runId, run.id))) {
      await db.update(schema.hrPayslips).set({ snapshot: { ...slip.snapshot, bankEncrypted: null } }).where(eq(schema.hrPayslips.id, slip.id));
    }
    await setPaymentDetails(db, world.eva.id, { bankIban: null }, { keyring: TEST_KEYRING, selfService: false });
    await expect(buildPaymentFile(db, run.id, deps)).rejects.toMatchObject({ code: 'MISSING_BANK_ACCOUNT', details: { employeeIds: [world.eva.id] } });
    await setPaymentDetails(db, world.eva.id, { bankIban: VALID_IBAN_2 }, { keyring: TEST_KEYRING, selfService: false });
    await db.update(schema.hrPayrollEmployers).set({ bankEncrypted: null }).where(eq(schema.hrPayrollEmployers.id, world.employerId));
    await expect(buildPaymentFile(db, run.id, deps)).rejects.toMatchObject({ code: 'EMPLOYER_INCOMPLETE' });
  });

  it('passes builder errors on instead of handing out a broken file', async () => {
    const base = testDeps();
    const run = await calculated(base.deps);
    await approveRun(db, run.id, base.deps, boss);
    const { deps } = testDeps({
      engines: {
        ...base.deps.engines,
        buildSepaSalaryBatch: () => ({ fileName: 'x.xml', contentType: 'application/xml', content: '', issues: [{ severity: 'error', code: 'invalid_iban' }] }),
      },
    });
    await expect(buildPaymentFile(db, run.id, deps)).rejects.toMatchObject({ code: 'PAYMENT_FILE_INVALID', status: 422 });
  });

  it('reports a missing builder as unavailable, not as a server error', async () => {
    const { deps } = testDeps({
      engines: {
        ...testDeps().deps.engines,
        buildSepaSalaryBatch: () => {
          throw new Error('SEPA salary batch is not implemented yet');
        },
      },
    });
    const run = await calculated(deps);
    await approveRun(db, run.id, deps, boss);
    await expect(buildPaymentFile(db, run.id, deps)).rejects.toMatchObject({ code: 'ENGINE_UNAVAILABLE', status: 503 });
  });

  it('writes a CSV of every payslip line', async () => {
    const { deps } = testDeps();
    const run = await calculated(deps);
    await approveRun(db, run.id, deps, boss);
    const report = await buildRunReport(db, run.id);
    expect(report.contentType).toContain('text/csv');
    const rows = report.content.trim().split('\r\n');
    expect(rows[0]).toBe('employee,employee_id,payslip_number,status,section,code,label,quantity,rate,amount,currency');
    expect(rows[1]).toContain('Eva Alder');
    expect(rows.some((r) => r.includes('wage_tax') && r.includes('-600.00'))).toBe(true);
  });
});

describe('payslips and annual statements', () => {
  it('shows the employee only their own final payslips, stamps the first view', async () => {
    const { deps } = testDeps();
    const run = await calculated(deps);
    const draftSlip = (await db.select().from(schema.hrPayslips).where(eq(schema.hrPayslips.employeeId, world.eva.id)))[0]!;
    expect(await myPayslips(db, world.eva.id)).toEqual([]);
    await expect(requirePayslip(db, draftSlip.id, world.eva.id)).rejects.toBeInstanceOf(HrNotFoundError);
    // A draft renders for the back office with a watermark; it is a valid PDF.
    expect(new TextDecoder().decode((await payslipPdf(db, draftSlip, deps)).slice(0, 5))).toBe('%PDF-');

    await approveRun(db, run.id, deps, boss);
    const mine = await myPayslips(db, world.eva.id);
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ number: '2026-0001', employerName: 'Acme BV', grossPay: '3000.00', netPay: '2400.00', viewedAt: null, currency: 'EUR' });
    await expect(requirePayslip(db, mine[0]!.id, world.hans.id)).rejects.toBeInstanceOf(HrNotFoundError);

    await markPayslipViewed(db, mine[0]!.id, new Date('2026-07-25T08:00:00Z'));
    await markPayslipViewed(db, mine[0]!.id, new Date('2026-07-26T08:00:00Z'));
    expect((await myPayslips(db, world.eva.id))[0]!.viewedAt).toBe('2026-07-25T08:00:00.000Z');
    expect((await listEmployeePayslips(db, world.eva.id))).toHaveLength(1);
  });

  it('serves the stored PDF and renders it again when the object is gone', async () => {
    const { deps, stored } = testDeps();
    const run = await calculated(deps);
    await approveRun(db, run.id, deps, boss);
    const slip = (await db.select().from(schema.hrPayslips).where(eq(schema.hrPayslips.employeeId, world.eva.id)))[0]!;
    const first = await payslipPdf(db, slip, deps);
    expect(first).toEqual(new Uint8Array(stored.get(slip.fileKey!)!.body));
    stored.delete(slip.fileKey!);
    const again = await payslipPdf(db, slip, deps);
    expect(new TextDecoder().decode(again.slice(0, 5))).toBe('%PDF-');
    expect(stored.has(slip.fileKey!)).toBe(true);
    // A tampered key pointing outside the workspace is never read.
    await db.update(schema.hrPayslips).set({ fileKey: 'workspaces/org_other/hr/payslips/2026/x.pdf' }).where(eq(schema.hrPayslips.id, slip.id));
    stored.set('workspaces/org_other/hr/payslips/2026/x.pdf', { body: new TextEncoder().encode('secret'), contentType: 'application/pdf' });
    const [tampered] = await db.select().from(schema.hrPayslips).where(eq(schema.hrPayslips.id, slip.id));
    expect(new TextDecoder().decode((await payslipPdf(db, tampered!, deps)).slice(0, 5))).toBe('%PDF-');
  });

  it('lists the years and builds the jaaropgaaf with the BSN from the sensitive block', async () => {
    const { deps, calls } = testDeps();
    const run = await calculated(deps);
    await approveRun(db, run.id, deps, boss);
    expect(await listAnnualStatements(db, world.eva.id)).toEqual([{ year: 2026, employerId: world.employerId, employerName: 'Acme BV', kind: 'jaaropgaaf' }]);
    const { bytes, fileName } = await annualStatementPdf(db, world.eva.id, 2026, world.employerId, deps);
    expect(fileName).toBe('jaaropgaaf-2026.pdf');
    expect(new TextDecoder().decode(bytes.slice(0, 5))).toBe('%PDF-');
    expect(calls.annual[0]).toMatchObject({ year: 2026, lang: 'nl', employer: { loonheffingennummer: '123456789L01' }, employee: { bsn: VALID_BSN, dateOfBirth: '1990-05-17' } });
    expect(calls.annual[0]!.payslips).toHaveLength(1);
    await expect(annualStatementPdf(db, world.eva.id, 2025, world.employerId, deps)).rejects.toBeInstanceOf(HrNotFoundError);
    await expect(annualStatementPdf(db, world.hans.id, 2026, world.employerId, deps)).resolves.toBeDefined();
  });
});
