/**
 * Route tests for WeldHR pay runs end to end (/payroll/runs, /payslips,
 * /filings, the annual statements and the payroll routes of My HR), Dutch
 * and US, through the whole /api/weldhr router on a pglite tenant database:
 * collecting inputs from time and expenses, calculating, approving (PDFs into
 * the `STORAGE` bucket, the WeldBooks journal over `BOOKS_INTERNAL`, filings),
 * the payment files, corrections and the filings' files.
 *
 * These are the requests the Rust port (rust/modules/hr/src/payroll) is
 * compared on in conformance mode: `STORAGE` and `BOOKS_INTERNAL` are shared
 * with the Rust server, generated files are compared without the moment they
 * were made, and PDFs by their drawing (worker-kit's conformance-binary.ts).
 */

import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createMemoryR2 } from '@weldsuite/worker-kit/testing/r2';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { HR_ADMIN, data, errorOf, hrCaller, hrDb, resetHr, seedEmployee, seedMember } from '../../../test/hr-fixtures';

let db: Database;
let bucket: R2Bucket;

const PAYROLL = ['payroll:read', 'payroll:prepare', 'payroll:approve', 'payroll:manage', 'employees:self'];
const FLAGS = ['weldhr-payroll'];

/** books-api's internal payroll import, answering as the route does. */
const books = {
  fetch: async (_input: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as { externalId: string };
    return new Response(
      JSON.stringify({ data: { importId: `pimp_${body.externalId.slice(-8)}`, journalEntryId: 'je_payroll', duplicate: false, status: 'posted' } }),
      { status: 201, headers: { 'Content-Type': 'application/json' } },
    );
  },
};

beforeAll(async () => {
  db = await hrDb();
}, 60_000);

beforeEach(async () => {
  bucket = createMemoryR2();
  await resetHr(db);
  await seedMember(db, HR_ADMIN, { name: 'Hanna Admin', email: 'hanna@example.com' });
  await seedMember(db, 'user_eva', { name: 'Eva Alder', email: 'eva@example.com' });
  await seedEmployee(db, { id: 'hremp_eva', userId: 'user_eva', firstName: 'Eva', lastName: 'Alder', email: 'eva@example.com', employeeNumber: 'E-001' });
  await seedEmployee(db, { id: 'hremp_hans', firstName: 'Hans', lastName: 'Berg', email: 'hans@example.com', employeeNumber: 'E-002' });
  await seedEmployee(db, { id: 'hremp_lee', firstName: 'Lee', lastName: 'Chen', email: 'lee@example.com', employeeNumber: 'U-001' });
  await db.insert(schema.entities).values({ id: 'ent_nl_books', name: 'Acme B.V.', jurisdictionCode: 'NL' }).onConflictDoNothing();
});

const admin = (env: Record<string, unknown> = {}) =>
  hrCaller(db, { grants: PAYROLL, flags: FLAGS, env: { STORAGE: bucket, BOOKS_INTERNAL: books, NL_SOFTWARE_RELATION_NUMBER: 'SWO12345', ...env } as never });
const eva = () => hrCaller(db, { grants: ['employees:self'], userId: 'user_eva', flags: FLAGS, env: { STORAGE: bucket } });

async function ok<T = Record<string, unknown>>(res: Response | Promise<Response>, status = 200): Promise<T> {
  const answer = await res;
  if (answer.status !== status) throw new Error(`expected ${status}, got ${answer.status}: ${await answer.text()}`);
  return data<T>(answer);
}

// ---------------------------------------------------------------------------
// The Netherlands
// ---------------------------------------------------------------------------

async function nlWorld() {
  const a = admin();
  const employer = await ok<{ id: string }>(
    a.send('POST', '/payroll/employers', {
      name: 'Acme BV',
      legalName: 'Acme B.V.',
      country: 'NL',
      accountingEntityId: 'ent_nl_books',
      address: { line1: 'Dorpsstraat', houseNumber: '1', postalCode: '1234 AB', city: 'Utrecht', country: 'NL' },
      nlSettings: {
        loonheffingennummer: '123456789L01',
        sectorCode: 52,
        contactName: 'Piet Puk',
        contactPhone: '0301234567',
        years: { '2026': { whkRate: 1.16, aofSmallEmployer: true } },
      },
    }),
    201,
  );
  await ok(a.send('PUT', `/payroll/employers/${employer.id}/bank`, { accountHolder: 'Acme B.V.', iban: 'NL91ABNA0417164300', bic: 'ABNANL2A' }));
  const schedule = await ok<{ id: string }>(
    a.send('POST', '/payroll/schedules', {
      employerId: employer.id,
      name: 'Monthly',
      frequency: 'monthly',
      anchorDate: '2026-01-01',
      payDateRule: { kind: 'day_of_month', day: 25 },
    }),
    201,
  );
  const people = [
    { id: 'hremp_eva', bsn: '111222333', iban: 'NL02ABNA0123456789', pay: { payType: 'salary', amount: 3000, period: 'month', hoursPerWeek: 36 }, nl: { gender: 2, nationality: 'NL' } },
    { id: 'hremp_hans', bsn: '123456782', iban: 'NL91ABNA0417164300', pay: { payType: 'hourly', amount: 20, period: 'hour' }, nl: { onCall: true } },
  ];
  for (const person of people) {
    await ok(
      a.send('PUT', `/payroll/employees/${person.id}/profile`, {
        employerId: employer.id,
        payScheduleId: schedule.id,
        startDate: '2026-01-01',
        nl: { writtenContract: true, indefiniteContract: true, ...person.nl },
      }),
    );
    await ok(
      a.send('PUT', `/payroll/employees/${person.id}/payment-details`, {
        nationalId: person.bsn,
        dateOfBirth: '1990-05-17',
        bankIban: person.iban,
        bankAccountHolder: person.id === 'hremp_eva' ? 'E. Alder' : null,
        idVerifiedAt: '2026-01-02',
        homeAddress: { line1: 'Kerkstraat', houseNumber: '5', postalCode: '1000 AA', city: 'Amsterdam', country: 'NL' },
      }),
    );
    await ok(a.send('POST', `/payroll/employees/${person.id}/compensations`, { effectiveFrom: '2026-01-01', ...person.pay }), 201);
    await ok(
      a.send('POST', `/payroll/employees/${person.id}/tax-elections`, {
        kind: 'nl_loonheffingskorting',
        effectiveFrom: '2026-01-01',
        data: { applyCredit: person.id === 'hremp_eva' },
        signatureName: 'Signed',
      }),
      201,
    );
  }
  await ok(
    a.send('POST', '/payroll/employees/hremp_eva/components', {
      code: 'nl.travel_allowance',
      params: { km_per_day: 20, days_per_month: 16 },
      effectiveFrom: '2026-01-01',
    }),
    201,
  );
  await ok(a.send('POST', '/payroll/employees/hremp_eva/components', { code: 'nl.pension_employee', params: { percent: 4.5, franchise_per_year: 17545 }, effectiveFrom: '2026-01-01' }), 201);
  return { employerId: employer.id, scheduleId: schedule.id };
}

/** Time and expenses for July 2026: Hans's approved hours and expense, Eva's unpaid leave and a sick report. */
async function seedJuly() {
  const approvedAt = new Date('2026-08-01T08:00:00.000Z');
  const days = ['2026-07-01', '2026-07-02', '2026-07-03', '2026-07-06', '2026-07-07'];
  let n = 0;
  for (const date of days) {
    n += 1;
    await db.insert(schema.hrAttendanceRecords).values({
      id: `hratt_jul_${n}`,
      employeeId: 'hremp_hans',
      date,
      workedMinutes: n === 3 ? 450 : 480,
      approvedBy: HR_ADMIN,
      approvedAt,
      createdAt: new Date(`${date}T17:00:00.000Z`),
      updatedAt: new Date(`${date}T17:00:00.000Z`),
    });
  }
  // A second record on a day adds up with the first.
  await db.insert(schema.hrAttendanceRecords).values({
    id: 'hratt_jul_extra',
    employeeId: 'hremp_hans',
    date: '2026-07-01',
    workedMinutes: 90,
    approvedBy: HR_ADMIN,
    approvedAt,
    createdAt: new Date('2026-07-01T20:00:00.000Z'),
    updatedAt: new Date('2026-07-01T20:00:00.000Z'),
  });
  await db.insert(schema.hrLeaveTypes).values({ id: 'hrlt_unpaid', name: 'Unpaid leave', isPaid: false }).onConflictDoNothing();
  await db.insert(schema.hrLeaveRequests).values({
    id: 'hrlr_eva_unpaid',
    employeeId: 'hremp_eva',
    leaveTypeId: 'hrlt_unpaid',
    startDate: '2026-07-13',
    endDate: '2026-07-14',
    days: 2,
    status: 'approved',
  });
  await db.insert(schema.hrAbsences).values({ id: 'hrabs_eva_sick', employeeId: 'hremp_eva', startDate: '2026-07-20', endDate: '2026-07-21', firstDay: 'half' });
  await db.insert(schema.hrDeclarations).values({
    id: 'hrdcl_hans_train',
    employeeId: 'hremp_hans',
    expenseDate: '2026-07-10',
    category: 'travel',
    description: 'Train to the client, return',
    amount: '45.50',
    currency: 'EUR',
    status: 'approved',
    submittedBy: HR_ADMIN,
  });
}

describe('a Dutch pay run', () => {
  it('collects, calculates, approves, pays, files and corrects a month', async () => {
    const { employerId, scheduleId } = await nlWorld();
    await seedJuly();
    const a = admin();

    // Creating.
    expect((await a.send('POST', '/payroll/runs', { employerId, kind: 'regular' })).status).toBe(400);
    expect((await a.send('POST', '/payroll/runs', { employerId, kind: 'regular', payScheduleId: scheduleId, periodStart: '2026-07-02' })).status).toBe(400);
    expect((await a.send('POST', '/payroll/runs', { employerId, kind: 'off_cycle', periodStart: '2026-07-01' })).status).toBe(400);
    const run = await ok<{ id: string; status: string; employeeCount: number }>(
      a.send('POST', '/payroll/runs', { employerId, kind: 'regular', payScheduleId: scheduleId, periodStart: '2026-07-01', notes: 'July' }),
      201,
    );
    expect(run).toMatchObject({ status: 'draft', employeeCount: 2 });
    expect((await a.send('POST', '/payroll/runs', { employerId, kind: 'regular', payScheduleId: scheduleId, periodStart: '2026-07-01' })).status).toBe(409);
    expect((await a.get('/payroll/runs/hrpr_missing')).status).toBe(404);
    expect((await a.send('PATCH', `/payroll/runs/${run.id}`, { payDate: '2027-01-05' })).status).toBe(400);
    await ok(a.send('PATCH', `/payroll/runs/${run.id}`, { payDate: '2026-07-24', notes: 'July salaries' }));
    expect((await ok<unknown[]>(a.get('/payroll/runs?year=2026&status=draft,calculated'))).length).toBe(1);
    expect((await a.get('/payroll/runs?year=1999')).status).toBe(400);
    expect((await ok<unknown[]>(a.get(`/payroll/runs?employerId=${employerId}`))).length).toBe(1);

    // Inputs: collected from time and expenses, and typed.
    await ok(a.send('POST', `/payroll/runs/${run.id}/collect`));
    const collected = await ok<Array<{ id: string; code: string; source: string; employeeId: string }>>(a.get(`/payroll/runs/${run.id}/inputs`));
    expect(collected.map((i) => i.code).sort()).toEqual(
      ['hours.regular', 'hours.regular', 'hours.regular', 'hours.regular', 'hours.regular', 'hours.unpaid_leave', 'nl.sick_pay', 'reimbursement'].sort(),
    );
    expect((await ok<unknown[]>(a.get(`/payroll/runs/${run.id}/inputs?employeeId=hremp_eva`))).length).toBe(2);
    expect((await a.send('POST', `/payroll/runs/${run.id}/inputs`, { employeeId: 'hremp_eva', code: 'us.tips_cash', amount: 5 })).status).toBe(400);
    expect((await a.send('POST', `/payroll/runs/${run.id}/inputs`, { employeeId: 'hremp_eva', code: 'bonus' })).status).toBe(400);
    expect((await a.send('POST', `/payroll/runs/${run.id}/inputs`, { employeeId: 'hremp_lee', code: 'bonus', amount: 1 })).status).toBe(400);
    const bonus = await ok<{ id: string }>(a.send('POST', `/payroll/runs/${run.id}/inputs`, { employeeId: 'hremp_eva', code: 'bonus', amount: 250, label: 'Q2 bonus' }), 201);
    await ok(a.send('PATCH', `/payroll/runs/${run.id}/inputs/${bonus.id}`, { amount: 300, notes: 'Raised' }));
    const sick = collected.find((i) => i.code === 'nl.sick_pay')!;
    await ok(a.send('PATCH', `/payroll/runs/${run.id}/inputs/${sick.id}`, { rate: 70 }));
    const extra = await ok<{ id: string }>(a.send('POST', `/payroll/runs/${run.id}/inputs`, { employeeId: 'hremp_hans', code: 'hours.overtime', quantity: 3, workDate: '2026-07-08' }), 201);
    expect((await a.send('DELETE', `/payroll/runs/${run.id}/inputs/${extra.id}`)).status).toBe(204);
    expect((await a.send('PATCH', `/payroll/runs/${run.id}/inputs/hrpi_missing`, { amount: 1 })).status).toBe(404);
    // Collecting again keeps the edited line and the typed bonus.
    await ok(a.send('POST', `/payroll/runs/${run.id}/collect`));

    // Who is in the run.
    expect((await a.send('POST', `/payroll/runs/${run.id}/employees`, { employeeId: 'hremp_lee', excluded: true })).status).toBe(400);
    await ok(a.send('POST', `/payroll/runs/${run.id}/employees`, { employeeId: 'hremp_hans', excluded: true }));
    await ok(a.send('POST', `/payroll/runs/${run.id}/employees`, { employeeId: 'hremp_hans', excluded: false }));

    // Calculating and approving.
    expect((await errorOf(await a.send('POST', `/payroll/runs/${run.id}/approve`))).code).toBe('RUN_NOT_CALCULATED');
    const calculated = await ok<{ status: string; payslips: Array<{ id: string; employeeId: string }>; canApprove: boolean }>(
      a.send('POST', `/payroll/runs/${run.id}/calculate`),
    );
    expect(calculated.status).toBe('calculated');
    const evaDraft = calculated.payslips.find((p) => p.employeeId === 'hremp_eva')!;
    const draftPdf = await a.get(`/payroll/payslips/${evaDraft.id}/pdf`);
    expect(draftPdf.headers.get('Content-Type')).toBe('application/pdf');
    expect((await a.get(`/payroll/runs/${run.id}/payment-file`)).status).toBe(409);
    const report = await a.get(`/payroll/runs/${run.id}/report`);
    expect(report.status).toBe(200);
    expect(await report.text()).toContain('employee,employee_id,payslip_number');
    // A change after calculating sends the run back to draft.
    await ok(a.send('PATCH', `/payroll/runs/${run.id}/inputs/${bonus.id}`, { amount: 350 }));
    expect((await errorOf(await a.send('POST', `/payroll/runs/${run.id}/approve`))).code).toBe('RUN_NOT_CALCULATED');
    await ok(a.send('POST', `/payroll/runs/${run.id}/calculate`));
    const approved = await ok<{ status: string; journalStatus: string; payslips: Array<{ id: string; employeeId: string; number: string }> }>(
      a.send('POST', `/payroll/runs/${run.id}/approve`),
    );
    expect(approved).toMatchObject({ status: 'approved', journalStatus: 'posted' });
    expect(approved.payslips.map((p) => p.number).sort()).toEqual(['2026-0001', '2026-0002']);
    expect((await a.send('POST', `/payroll/runs/${run.id}/cancel`)).status).toBe(409);

    // Files of the approved run.
    const sepa = await a.get(`/payroll/runs/${run.id}/payment-file`);
    expect(sepa.status).toBe(200);
    expect(sepa.headers.get('Content-Type')).toBe('application/xml');
    const evaSlip = approved.payslips.find((p) => p.employeeId === 'hremp_eva')!;
    expect((await ok<{ number: string }>(a.get(`/payroll/payslips/${evaSlip.id}`))).number).toMatch(/^2026-000[12]$/);
    expect((await a.get(`/payroll/payslips/${evaSlip.id}/pdf`)).status).toBe(200);
    expect((await a.get('/payroll/payslips/hrps_missing')).status).toBe(404);
    expect((await ok<unknown[]>(a.get('/payroll/employees/hremp_eva/payslips'))).length).toBe(1);

    // The journal again, and paying.
    expect((await ok<{ journalStatus: string }>(a.send('POST', `/payroll/runs/${run.id}/post-journal`))).journalStatus).toBe('posted');
    expect((await a.send('POST', `/payroll/runs/${run.id}/mark-paid`, { paidOn: 'July' })).status).toBe(400);
    expect((await ok<{ status: string }>(a.send('POST', `/payroll/runs/${run.id}/mark-paid`, { paidOn: '2026-07-24' }))).status).toBe('paid');
    expect((await errorOf(await a.send('POST', `/payroll/runs/${run.id}/mark-paid`, {}))).code).toBe('CONFLICT');

    // The July loonaangifte.
    const filings = await ok<Array<{ id: string; kind: string; period: number; status: string }>>(a.get('/payroll/filings?year=2026'));
    const july = filings.find((f) => f.kind === 'nl_loonaangifte' && f.period === 7)!;
    expect(july.status).toBe('open');
    expect((await ok<unknown[]>(a.get('/payroll/filings?status=open&kind=nl_loonaangifte'))).length).toBe(1);
    expect((await a.get(`/payroll/filings/${july.id}/file`)).status).toBe(404);
    expect((await errorOf(await a.send('POST', `/payroll/filings/${july.id}/mark-filed`, {}))).code).toBe('CONFLICT');
    // A loonheffingennummer that fails the elfproef: the builder's issues are kept on the filing.
    const refused = await a.send('POST', `/payroll/filings/${july.id}/generate`);
    expect(refused.status).toBe(422);
    expect((await errorOf(refused)).code).toBe('FILING_INVALID');
    expect((await ok<{ issues: unknown[] }>(a.get(`/payroll/filings/${july.id}`))).issues.length).toBeGreaterThan(0);
    await ok(a.send('PATCH', `/payroll/employers/${employerId}`, { nlSettings: { loonheffingennummer: '111222333L01' } }));
    const generated = await ok<{ status: string; fileName: string; paymentReference: string | null }>(a.send('POST', `/payroll/filings/${july.id}/generate`));
    expect(generated.status).toBe('ready');
    const xml = await a.get(`/payroll/filings/${july.id}/file`);
    expect(xml.status).toBe(200);
    expect((await a.get(`/payroll/filings/${july.id}/file?name=loonaangifte-2026-07-summary.pdf`)).status).toBe(200);
    expect((await a.get(`/payroll/filings/${july.id}/file?name=missing.csv`)).status).toBe(404);
    expect((await errorOf(await a.send('POST', `/payroll/filings/${july.id}/submit`))).code).toBe('DIGIPOORT_NOT_CONFIGURED');
    expect((await a.send('POST', `/payroll/filings/${july.id}/refresh-status`)).status).toBe(409);
    expect((await ok<{ status: string }>(a.send('POST', `/payroll/filings/${july.id}/mark-filed`, { externalReference: 'BD-2026-07', filedOn: '2026-08-20' }))).status).toBe('filed');
    expect((await ok<{ status: string }>(a.get(`/payroll/filings/${july.id}`))).status).toBe('filed');
    expect((await a.get('/payroll/filings/hrpf_missing')).status).toBe(404);

    // August: the next regular run carries July's loonheffingen in its salary file.
    const august = await ok<{ id: string }>(a.send('POST', '/payroll/runs', { employerId, kind: 'regular', payScheduleId: scheduleId }), 201);
    await ok(a.send('POST', `/payroll/runs/${august.id}/calculate`));
    await ok(a.send('POST', `/payroll/runs/${august.id}/approve`));
    expect((await a.get(`/payroll/runs/${august.id}/payment-file`)).status).toBe(200);
    expect((await a.get(`/payroll/runs/${august.id}/payment-file`)).status).toBe(200);

    // A correction of July, paid in August: the difference only.
    expect((await a.send('POST', '/payroll/runs', { employerId, kind: 'correction', correctsRunId: run.id, employeeIds: ['hremp_lee'] })).status).toBe(400);
    const correction = await ok<{ id: string; kind: string }>(
      a.send('POST', '/payroll/runs', { employerId, kind: 'correction', correctsRunId: run.id, employeeIds: ['hremp_eva'], payDate: '2026-08-25' }),
      201,
    );
    expect((await a.send('POST', '/payroll/runs', { employerId, kind: 'correction', correctsRunId: run.id, payDate: '2026-08-25' })).status).toBe(409);
    expect((await a.send('POST', `/payroll/runs/${correction.id}/collect`)).status).toBe(409);
    await ok(a.send('POST', `/payroll/runs/${correction.id}/inputs`, { employeeId: 'hremp_eva', code: 'bonus', amount: 100, label: 'Correction' }), 201);
    const corrected = await ok<{ payslips: Array<{ netPay: string }> }>(a.send('POST', `/payroll/runs/${correction.id}/calculate`));
    expect(corrected.payslips).toHaveLength(1);
    await ok(a.send('POST', `/payroll/runs/${correction.id}/approve`));
    expect((await a.get(`/payroll/runs/${correction.id}/payment-file`)).status).toBe(200);

    // August's return holds the correction of July.
    const augustFiling = (await ok<Array<{ id: string; kind: string; period: number }>>(a.get('/payroll/filings?kind=nl_loonaangifte'))).find((f) => f.period === 8)!;
    const augustReturn = await ok<{ status: string; summary: Record<string, number> }>(a.send('POST', `/payroll/filings/${augustFiling.id}/generate`));
    expect(augustReturn.status).toBe('ready');
    expect((await a.get(`/payroll/filings/${augustFiling.id}/file`)).status).toBe(200);

    // The annual statement, for HR and for Eva.
    const statements = await ok<Array<{ year: number; employerId: string; kind: string }>>(a.get('/payroll/employees/hremp_eva/annual-statements'));
    expect(statements).toEqual([{ year: 2026, employerId, employerName: 'Acme BV', kind: 'jaaropgaaf' }]);
    expect((await a.get(`/payroll/employees/hremp_eva/annual-statements/2026?employerId=${employerId}`)).headers.get('Content-Disposition')).toBe(
      'attachment; filename="jaaropgaaf-2026.pdf"',
    );
    const mine = await ok<Array<{ id: string; viewedAt: string | null }>>(eva().get('/me/payslips'));
    expect(mine.length).toBe(3);
    expect((await eva().get(`/me/payslips/${mine[0]!.id}/pdf`)).status).toBe(200);
    expect((await ok<Array<{ viewedAt: string | null }>>(eva().get('/me/payslips')))[0]!.viewedAt).not.toBeNull();
    const hansSlip = approved.payslips.find((p) => p.employeeId === 'hremp_hans')!;
    expect((await eva().get(`/me/payslips/${hansSlip.id}/pdf`)).status).toBe(404);
    expect((await ok<unknown[]>(eva().get('/me/annual-statements'))).length).toBe(1);
    expect((await eva().get('/me/annual-statements/2026')).status).toBe(200);
    expect((await eva().get('/me/annual-statements/2025')).status).toBe(404);
    expect((await eva().get(`/me/annual-statements/2026?employerId=${employerId}`)).status).toBe(200);

    // The overview after it all.
    const overview = await ok<{ recentRuns: unknown[]; upcoming: unknown[] }>(a.get('/payroll/overview'));
    expect(overview.recentRuns.length).toBe(3);
  });

  it('cancels an off-cycle run and refuses a second approver only when four eyes is on', async () => {
    const { employerId, scheduleId } = await nlWorld();
    const a = admin();
    const offCycle = await ok<{ id: string; employeeCount: number }>(
      a.send('POST', '/payroll/runs', { employerId, kind: 'off_cycle', periodStart: '2026-07-01', periodEnd: '2026-07-31', payDate: '2026-07-15', employeeIds: ['hremp_eva', 'hremp_eva'] }),
      201,
    );
    expect(offCycle.employeeCount).toBe(1);
    expect((await a.send('POST', '/payroll/runs', { employerId, kind: 'off_cycle', periodStart: '2026-07-01', periodEnd: '2026-07-31', payDate: '2026-07-15', employeeIds: ['hremp_lee'] })).status).toBe(400);
    await ok(a.send('POST', `/payroll/runs/${offCycle.id}/inputs`, { employeeId: 'hremp_eva', code: 'nl.thirteenth_month', amount: 3000 }), 201);
    await ok(a.send('POST', `/payroll/runs/${offCycle.id}/calculate`));
    expect((await ok<{ status: string }>(a.send('POST', `/payroll/runs/${offCycle.id}/cancel`))).status).toBe('cancelled');
    expect((await a.send('POST', `/payroll/runs/${offCycle.id}/calculate`)).status).toBe(409);

    await ok(a.send('PATCH', `/payroll/employers/${employerId}`, { requireSeparateApprover: true }));
    const run = await ok<{ id: string }>(a.send('POST', '/payroll/runs', { employerId, kind: 'regular', payScheduleId: scheduleId, periodStart: '2026-03-01' }), 201);
    await ok(a.send('POST', `/payroll/runs/${run.id}/calculate`));
    expect((await ok<{ canApprove: boolean }>(a.get(`/payroll/runs/${run.id}`))).canApprove).toBe(false);
    expect((await errorOf(await a.send('POST', `/payroll/runs/${run.id}/approve`))).code).toBe('FOUR_EYES');
    const second = hrCaller(db, { grants: PAYROLL, userId: 'user_boss', flags: FLAGS, env: { STORAGE: bucket } });
    expect((await ok<{ canApprove: boolean }>(second.get(`/payroll/runs/${run.id}`))).canApprove).toBe(true);
    // Without the WeldBooks link the journal is skipped with a reason.
    expect((await ok<{ journalStatus: string; journalError: string | null }>(second.send('POST', `/payroll/runs/${run.id}/approve`))).journalStatus).toBe('skipped');
  });
});

// ---------------------------------------------------------------------------
// The United States
// ---------------------------------------------------------------------------

describe('a US pay run', () => {
  it('pays an hourly employee with overtime and produces the ACH file and the federal and state filings', async () => {
    const a = admin();
    const employer = await ok<{ id: string }>(
      a.send('POST', '/payroll/employers', {
        name: 'Acme Inc',
        legalName: 'Acme Inc.',
        country: 'US',
        address: { line1: '1 Main St', city: 'Sacramento', region: 'CA', postalCode: '95814', country: 'US' },
        usSettings: {
          ein: '12-3456789',
          depositSchedule: 'monthly',
          workweekStartDay: 1,
          states: { CA: { withholdingAccountNumber: '123-4567-8', suiAccountNumber: '987-6543-2', suiRates: { '2026': 3.4 } } },
        },
      }),
      201,
    );
    expect((await a.get(`/payroll/runs/hrpr_none/payment-file`)).status).toBe(404);
    await ok(
      a.send('PUT', `/payroll/employers/${employer.id}/bank`, {
        accountHolder: 'Acme Inc.',
        routingNumber: '021000021',
        accountNumber: '123456789',
        accountType: 'checking',
        nachaCompanyId: '1123456789',
        bankName: 'JPMorgan Chase',
      }),
    );
    const schedule = await ok<{ id: string; nextPeriod: { start: string; end: string } }>(
      a.send('POST', '/payroll/schedules', {
        employerId: employer.id,
        name: 'Biweekly',
        frequency: 'biweekly',
        anchorDate: '2026-01-05',
        payDateRule: { kind: 'offset_after_end', days: 5 },
      }),
      201,
    );
    await ok(
      a.send('PUT', '/payroll/employees/hremp_lee/profile', {
        employerId: employer.id,
        payScheduleId: schedule.id,
        startDate: '2026-01-01',
        us: { workState: 'CA', residenceState: 'CA', flsaStatus: 'nonexempt' },
      }),
    );
    await ok(
      a.send('PUT', '/payroll/employees/hremp_lee/payment-details', {
        nationalId: '123-45-6789',
        bankRoutingNumber: '021000021',
        bankAccountNumber: '987654321',
        bankAccountType: 'checking',
        homeAddress: { line1: '2 Oak Ave', city: 'Sacramento', region: 'CA', postalCode: '95816', country: 'US' },
      }),
    );
    await ok(a.send('POST', '/payroll/employees/hremp_lee/compensations', { effectiveFrom: '2026-01-01', payType: 'hourly', amount: 25, period: 'hour' }), 201);
    await ok(
      a.send('POST', '/payroll/employees/hremp_lee/tax-elections', {
        kind: 'us_w4',
        effectiveFrom: '2026-01-01',
        data: { formYear: 2026, filingStatus: 'single', multipleJobs: false, dependentsAmount: 0, otherIncome: 0, deductions: 0, extraWithholding: 0, exempt: false },
        signatureName: 'Lee Chen',
      }),
      201,
    );
    await ok(
      a.send('POST', '/payroll/employees/hremp_lee/tax-elections', {
        kind: 'us_state_certificate',
        state: 'CA',
        effectiveFrom: '2026-01-01',
        data: { filingStatus: 'single', allowances: 1 },
        signatureName: 'Lee Chen',
      }),
      201,
    );
    await ok(a.send('POST', '/payroll/employees/hremp_lee/components', { code: 'us.401k', params: { percent: 5 }, effectiveFrom: '2026-01-01' }), 201);

    // Ten-hour days in the first week: overtime past forty hours.
    const start = schedule.nextPeriod.start;
    const approvedAt = new Date('2026-02-01T08:00:00.000Z');
    for (let day = 0; day < 5; day += 1) {
      const date = new Date(`${start}T00:00:00Z`);
      date.setUTCDate(date.getUTCDate() + day);
      const iso = date.toISOString().slice(0, 10);
      await db.insert(schema.hrAttendanceRecords).values({
        id: `hratt_lee_${day}`,
        employeeId: 'hremp_lee',
        date: iso,
        workedMinutes: 600,
        approvedBy: HR_ADMIN,
        approvedAt,
        createdAt: new Date(`${iso}T18:00:00.000Z`),
        updatedAt: new Date(`${iso}T18:00:00.000Z`),
      });
    }

    const run = await ok<{ id: string; periodStart: string }>(a.send('POST', '/payroll/runs', { employerId: employer.id, kind: 'regular', payScheduleId: schedule.id }), 201);
    expect(run.periodStart).toBe(start);
    await ok(a.send('POST', `/payroll/runs/${run.id}/collect`));
    await ok(a.send('POST', `/payroll/runs/${run.id}/inputs`, { employeeId: 'hremp_lee', code: 'us.tips_cash', amount: 40 }), 201);
    const calculated = await ok<{ status: string; errorCount: number; totals: { grossCents: number } }>(a.send('POST', `/payroll/runs/${run.id}/calculate`));
    expect(calculated).toMatchObject({ status: 'calculated', errorCount: 0 });
    await ok(a.send('POST', `/payroll/runs/${run.id}/approve`));
    const ach = await a.get(`/payroll/runs/${run.id}/payment-file`);
    expect(ach.status).toBe(200);
    expect((await a.get(`/payroll/runs/${run.id}/report`)).status).toBe(200);

    const filings = await ok<Array<{ id: string; kind: string; state: string | null }>>(a.get(`/payroll/filings?employerId=${employer.id}`));
    expect(filings.map((f) => `${f.kind}${f.state ? `:${f.state}` : ''}`).sort()).toEqual(
      ['us_940', 'us_941', 'us_state_unemployment:CA', 'us_state_withholding:CA', 'us_w2'].sort(),
    );
    for (const filing of filings) {
      const generated = await a.send('POST', `/payroll/filings/${filing.id}/generate`);
      expect(generated.status, filing.kind).toBe(200);
      expect((await a.get(`/payroll/filings/${filing.id}/file`)).status, filing.kind).toBe(200);
    }
    const state = filings.find((f) => f.kind === 'us_state_withholding')!;
    expect((await errorOf(await a.send('POST', `/payroll/filings/${state.id}/submit`))).code).toBe('CONFLICT');

    const slips = await ok<Array<{ id: string }>>(a.get('/payroll/employees/hremp_lee/payslips'));
    expect((await a.get(`/payroll/payslips/${slips[0]!.id}/pdf`)).headers.get('Content-Disposition')).toMatch(/^attachment; filename="payslip-/);
    expect((await a.get(`/payroll/employees/hremp_lee/annual-statements/2026?employerId=${employer.id}`)).headers.get('Content-Disposition')).toBe(
      'attachment; filename="w2-2026.pdf"',
    );
  });
});
