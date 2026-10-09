/**
 * Builder issues surfaced structurally, the loonheffingen payment in the
 * salary batch, correction bases, the Digipoort adapter, and the US path
 * against the real federal and state engines.
 */

import { eq } from 'drizzle-orm';
import { PDFDocument } from 'pdf-lib';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { betalingskenmerk } from '@weldsuite/payroll-domain/nl/loonaangifte';
import type { Database } from '@weldsuite/worker-kit/db';
import { schema } from '@weldsuite/worker-kit/db';
import { createPayrollDb, resetPayrollTables } from '../../../test/payroll-db';
import { TEST_KEYRING, VALID_ROUTING, VALID_SSN, createTestEmployee, nlWorld, testDeps, type NlWorld } from '../../../test/payroll-fixtures';
import { annualStatementPdf } from './annual';
import { approveRun } from './approve';
import { calculateRun } from './calculate';
import { defaultEngines } from './deps';
import { connectDigipoort, filingStatusFrom } from './digipoort';
import { createCompensation, createElection, listPayrollEmployees, setPaymentDetails, upsertProfile } from './employees';
import { createEmployer, setEmployerBank } from './employers';
import { buildPaymentFile } from './files';
import { generateFiling, getFiling } from './filings';
import { listEmployeePayslips } from './payslips';
import { createRun, createRunInput, getRunDetail } from './runs';
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

async function approveMonth(deps: ReturnType<typeof testDeps>['deps'], periodStart: string) {
  const run = await createRun(db, { employerId: world.employerId, kind: 'regular', payScheduleId: world.scheduleId, periodStart }, prep);
  await calculateRun(db, run.id, deps, prep);
  await approveRun(db, run.id, deps, boss);
  return run;
}

const filingOf = async (period: number) => (await db.select().from(schema.hrPayrollFilings)).find((f) => f.kind === 'nl_loonaangifte' && f.period === period)!;

describe('structured builder issues', () => {
  it('returns payment file errors as issues with the employee attached', async () => {
    const base = testDeps();
    const run = await approveMonth(base.deps, '2026-07-01');
    const evaSlip = (await db.select().from(schema.hrPayslips).where(eq(schema.hrPayslips.employeeId, world.eva.id)))[0]!;
    const { deps } = testDeps({
      engines: {
        ...base.deps.engines,
        buildSepaSalaryBatch: () => ({
          fileName: 'x.xml',
          contentType: 'application/xml',
          content: '',
          issues: [
            { severity: 'warning', code: 'net_pay_zero', params: { endToEndId: 'unknown' } },
            { severity: 'error', code: 'invalid_iban', params: { endToEndId: evaSlip.id.replaceAll("_", "-") } },
          ],
        }),
      },
    });
    const error = await buildPaymentFile(db, run.id, deps).catch((e) => e);
    expect(error).toMatchObject({ code: 'PAYMENT_FILE_INVALID', status: 422 });
    // Errors first, the employee attached where the builder named the payment.
    expect(error.details.issues).toEqual([
      { severity: 'error', code: 'invalid_iban', employeeId: world.eva.id, params: { endToEndId: evaSlip.id.replaceAll("_", "-") } },
      { severity: 'warning', code: 'net_pay_zero', params: { endToEndId: 'unknown' } },
    ]);
  });

  it('returns missing bank details and an incomplete employer the same way', async () => {
    const { deps } = testDeps();
    const run = await approveMonth(deps, '2026-07-01');
    // As if the payslips were approved before the account was sealed into them: the current details are all there is.
    for (const slip of await db.select().from(schema.hrPayslips).where(eq(schema.hrPayslips.runId, run.id))) {
      await db.update(schema.hrPayslips).set({ snapshot: { ...slip.snapshot, bankEncrypted: null } }).where(eq(schema.hrPayslips.id, slip.id));
    }
    await setPaymentDetails(db, world.eva.id, { bankIban: null }, { keyring: TEST_KEYRING, selfService: false });
    const missing = await buildPaymentFile(db, run.id, deps).catch((e) => e);
    expect(missing).toMatchObject({ code: 'MISSING_BANK_ACCOUNT', status: 409 });
    expect(missing.details.issues).toEqual([{ severity: 'error', code: 'missing_bank_account', employeeId: world.eva.id }]);
    await setPaymentDetails(db, world.eva.id, { bankIban: 'NL02ABNA0123456789' }, { keyring: TEST_KEYRING, selfService: false });
    await db.update(schema.hrPayrollEmployers).set({ bankEncrypted: null }).where(eq(schema.hrPayrollEmployers.id, world.employerId));
    const employer = await buildPaymentFile(db, run.id, deps).catch((e) => e);
    expect(employer.details.issues).toEqual([{ severity: 'error', code: 'employer_incomplete', params: { field: 'bank_iban' } }]);
  });

  it('keeps a filing\'s errors on the filing, then replaces them with the warnings of a good build', async () => {
    const base = testDeps();
    await approveMonth(base.deps, '2026-07-01');
    const filing = await filingOf(7);
    const failing = testDeps({
      engines: {
        ...base.deps.engines,
        buildLoonaangifte: () => ({
          file: { fileName: 'x.xml', contentType: 'application/xml', content: '' },
          summary: {},
          amountDueCents: 0,
          issues: [
            { severity: 'error', code: 'invalid_bsn', params: { incomeRelationship: 1 } },
            { severity: 'warning', code: 'end_reason_defaulted', params: { incomeRelationship: 2 } },
          ],
        }),
      },
    }).deps;
    const error = await generateFiling(db, filing.id, failing, mgr).catch((e) => e);
    expect(error).toMatchObject({ code: 'FILING_INVALID', status: 422 });
    expect(error.details.issues).toEqual([
      { severity: 'error', code: 'invalid_bsn', employeeId: world.eva.id, params: { incomeRelationship: 1 } },
      { severity: 'warning', code: 'end_reason_defaulted', employeeId: world.hans.id, params: { incomeRelationship: 2 } },
    ]);
    const stored = await getFiling(db, filing.id, false);
    expect(stored).toMatchObject({ status: 'open', currency: 'EUR', fileName: null });
    expect(stored.issues).toEqual(error.details.issues);

    const warning = testDeps({
      engines: {
        ...base.deps.engines,
        buildLoonaangifte: () => ({
          file: { fileName: 'ok.xml', contentType: 'application/xml', content: '<a/>' },
          summary: { TotTeBet: 1 },
          amountDueCents: 1,
          issues: [{ severity: 'warning', code: 'nationality_unknown', params: { incomeRelationship: 2, nationality: 'XX' } }],
        }),
      },
    }).deps;
    await generateFiling(db, filing.id, warning, mgr);
    const ok = await getFiling(db, filing.id, false);
    expect(ok.status).toBe('ready');
    expect(ok.issues).toEqual([{ severity: 'warning', code: 'nationality_unknown', employeeId: world.hans.id, params: { incomeRelationship: 2, nationality: 'XX' } }]);
  });

  it('explains the summary currency and keeps the rest of the contract additive', async () => {
    const { deps } = testDeps();
    const run = await approveMonth(deps, '2026-07-01');
    await generateFiling(db, (await filingOf(7)).id, deps, mgr);
    const dto = await getFiling(db, (await filingOf(7)).id, false);
    expect(dto).toMatchObject({ currency: 'EUR', amountDue: '600.00', issues: [] });
    expect(dto.summary.TotTeBet).toBe(60_000);

    const detail = await getRunDetail(db, run.id, boss);
    const eva = detail.payslips.find((p) => p.employeeId === world.eva.id)!;
    expect(eva).toMatchObject({ runId: run.id, periodStart: '2026-07-01', periodEnd: '2026-07-31', payDate: '2026-07-24', currency: 'EUR', employeeDeductions: '0.00', reimbursements: '0.00' });
    const mine = (await listEmployeePayslips(db, world.eva.id))[0]!;
    expect(mine).toMatchObject({ runId: run.id, periodStart: '2026-07-01', payDate: '2026-07-24', currency: 'EUR', employeeDeductions: '0.00', reimbursements: '0.00' });
  });
});

describe('the loonheffingen payment', () => {
  it('rides in the salary batch of the following month, once that month\'s return is generated', async () => {
    const base = testDeps();
    const { deps, calls } = base;
    const july = await approveMonth(deps, '2026-07-01');
    const filing = await filingOf(7);
    const generated = await generateFiling(db, filing.id, deps, mgr);
    const reference = betalingskenmerk({ loonheffingennummer: '123456789L01', taxYear: 2026, month: 7 });
    expect(generated.paymentReference).toBe(reference);

    // July's own salaries carry no tax (June's return does not exist).
    await buildPaymentFile(db, july.id, deps);
    expect(calls.sepa.at(-1)!.tax).toBeNull();
    // August's salaries carry July's loonheffingen.
    const august = await approveMonth(deps, '2026-08-01');
    await buildPaymentFile(db, august.id, deps);
    expect(calls.sepa.at(-1)!.tax).toEqual({ amountCents: 60_000, betalingskenmerk: reference });
    // A correction run pays no tax.
    const correction = await createRun(db, { employerId: world.employerId, kind: 'correction', correctsRunId: august.id, employeeIds: [world.eva.id], payDate: '2026-09-01' }, prep);
    await createRunInput(db, correction.id, { employeeId: world.eva.id, code: 'bonus', amount: 100 }, prep);
    await calculateRun(db, correction.id, deps, prep);
    await approveRun(db, correction.id, deps, boss);
    await buildPaymentFile(db, correction.id, deps);
    expect(calls.sepa.at(-1)!.tax).toBeNull();
  });
});

describe('loonaangifte inputs', () => {
  it('passes the end-of-employment code and cao code, and the base of each correction\'s saldo', async () => {
    const { deps, calls } = testDeps();
    await upsertProfile(db, world.hans.id, { employerId: world.employerId, endDate: '2026-07-31', nl: { endReasonCode: '30', caoCode: 1234 } });
    const july = await approveMonth(deps, '2026-07-01');
    const julyFiling = await filingOf(7);
    await generateFiling(db, julyFiling.id, deps, mgr);
    const hans = calls.loonaangifte[0]!.ikvs.find((ikv) => ikv.identity.surname === 'Berg')!;
    expect(hans).toMatchObject({ employmentEnd: '2026-07-31', endReasonCode: '30', caoCode: 1234 });

    const correction = await createRun(db, { employerId: world.employerId, kind: 'correction', correctsRunId: july.id, employeeIds: [world.eva.id], payDate: '2026-08-05' }, prep);
    await createRunInput(db, correction.id, { employeeId: world.eva.id, code: 'bonus', amount: 100 }, prep);
    await calculateRun(db, correction.id, deps, prep);
    await approveRun(db, correction.id, deps, boss);
    await generateFiling(db, (await filingOf(8)).id, deps, mgr);
    // What July's return reported: its TotTeBet (600.00) is the base of the saldo.
    expect(calls.loonaangifte.at(-1)!.corrections[0]).toMatchObject({ period: { start: '2026-07-01' }, previouslyReportedTotTeBetCents: 60_000 });
  });

  it('gives a transitievergoeding its own income relationship number, once, and keeps it', async () => {
    const base = testDeps();
    const { calls } = base;
    const { deps } = testDeps({
      engines: {
        ...base.deps.engines,
        calculatePayslip: (input) => {
          const result = base.deps.engines.calculatePayslip(input);
          // Eva leaves: a transitievergoeding is paid with her last salary.
          if (input.compensation?.payType === 'salary' && input.employee.startDate === '2026-01-01' && input.country === 'NL') {
            return { ...result, lines: [...result.lines, { code: 'nl.transition_payment', section: 'earning' as const, labelKey: 'nl.transition_payment', amountCents: 500_000 }] };
          }
          return result;
        },
      },
    });
    await approveMonth(deps, '2026-07-01');
    const filing = await filingOf(7);
    await generateFiling(db, filing.id, deps, mgr);
    const ikvs = calls.loonaangifte.at(-1)!.ikvs;
    const eva = ikvs.find((ikv) => ikv.identity.surname === 'Alder')!;
    const hans = ikvs.find((ikv) => ikv.identity.surname === 'Berg')!;
    // Eva is relationship 1 and Hans 2: the next free number at the employer is 3.
    expect(eva).toMatchObject({ incomeRelationshipNumber: 1, transitionPaymentIncomeRelationshipNumber: 3 });
    // Only the employee who was paid a transitievergoeding gets one.
    expect(hans.transitionPaymentIncomeRelationshipNumber ?? null).toBeNull();
    const [profile] = await db.select().from(schema.hrPayrollProfiles).where(eq(schema.hrPayrollProfiles.employeeId, world.eva.id));
    expect(profile!.nl.transitionIncomeRelationshipNumber).toBe(3);

    // Regenerating keeps it; a new employee's normal number skips it.
    await generateFiling(db, filing.id, deps, mgr);
    expect(calls.loonaangifte.at(-1)!.ikvs.find((ikv) => ikv.identity.surname === 'Alder')!.transitionPaymentIncomeRelationshipNumber).toBe(3);
    const fresh = await createTestEmployee(db, { firstName: 'Nieuw' });
    const created = await upsertProfile(db, fresh.id, { employerId: world.employerId, payScheduleId: world.scheduleId });
    expect(created.nl.incomeRelationshipNumber).toBe(4);
  });

  it('flags the contact person and the sector the loonaangifte needs', async () => {
    await db.update(schema.hrPayrollEmployers).set({ nlSettings: { loonheffingennummer: '123456789L01' } }).where(eq(schema.hrPayrollEmployers.id, world.employerId));
    const list = await listPayrollEmployees(db, { onPayroll: true }, TEST_KEYRING, '2026-08-01');
    expect(list.every((e) => e.issues.some((i) => i.code === 'employer_incomplete' && i.severity === 'error'))).toBe(true);
  });
});

describe('the Digipoort adapter', () => {
  async function signingKeyPem() {
    const pair = (await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify'])) as CryptoKeyPair;
    const der = new Uint8Array((await crypto.subtle.exportKey('pkcs8', pair.privateKey)) as ArrayBuffer);
    let binary = '';
    for (const byte of der) binary += String.fromCharCode(byte);
    return `-----BEGIN PRIVATE KEY-----\n${btoa(binary)}\n-----END PRIVATE KEY-----`;
  }

  it('sends the signed message through the certificate binding and maps the statuses', async () => {
    const requests: Array<{ url: string; action: string; body: string }> = [];
    const gateway = connectDigipoort({
      aanleverUrl: 'https://digipoort.example/aanleveren',
      statusUrl: 'https://digipoort.example/status',
      signingKeyPem: await signingKeyPem(),
      certificateDerBase64: btoa('certificate'),
      fetch: async (url, init) => {
        requests.push({ url, action: init.headers.SOAPAction ?? '', body: init.body });
        if (url.endsWith('/aanleveren')) return { ok: true, status: 200, text: async () => '<aanleverResponse><kenmerk>KEN-1</kenmerk></aanleverResponse>' };
        return {
          ok: true,
          status: 200,
          text: async () =>
            '<r><StatusResultaat><kenmerk>KEN-1</kenmerk><statuscode>100</statuscode><statusomschrijving>Ontvangen</statusomschrijving></StatusResultaat>' +
            '<StatusResultaat><kenmerk>KEN-1</kenmerk><statuscode>400</statuscode><statusomschrijving>Verwerkt</statusomschrijving></StatusResultaat></r>',
        };
      },
    });
    expect(await gateway.submit({ xml: '<aangifte/>', fileName: 'l.xml', loonheffingennummer: '123456789L01', messageId: 'WS-1' })).toEqual({ reference: 'KEN-1' });
    expect(requests[0]).toMatchObject({ url: 'https://digipoort.example/aanleveren' });
    expect(requests[0]!.body).toContain('123456789L01');
    expect(requests[0]!.body).toContain('Signature');
    expect(await gateway.status('KEN-1')).toEqual({ status: 'accepted', message: 'Verwerkt' });
  });

  it('treats a fault code as a rejection and anything else as still on its way', () => {
    const base = { kenmerk: 'K', statuscode: '1', tijdstempelStatus: '', statusdetails: null };
    expect(filingStatusFrom([])).toEqual({ status: 'submitted', message: null });
    expect(filingStatusFrom([{ ...base, statusomschrijving: 'Ontvangen', statusFoutcode: null }])).toEqual({ status: 'submitted', message: 'Ontvangen' });
    expect(filingStatusFrom([{ ...base, statusomschrijving: 'Afgekeurd', statusFoutcode: { foutcode: 'X1', foutbeschrijving: 'Ongeldig' } }])).toEqual({ status: 'rejected', message: 'X1 Ongeldig' });
  });
});

describe('US payroll on the real engines', () => {
  it('calculates, approves, files and pays a Texas employee', async () => {
    await resetPayrollTables(db);
    const employer = await createEmployer(
      db,
      {
        name: 'Acme Inc',
        legalName: 'Acme Inc.',
        country: 'US',
        address: { line1: '1 Main St', city: 'Austin', region: 'TX', postalCode: '78701', country: 'US' },
        usSettings: { ein: '12-3456789', depositSchedule: 'monthly', states: { TX: { suiAccountNumber: 'S-1', suiRates: { '2026': 2.7 } } } },
      },
      { createdBy: 'u', keyring: TEST_KEYRING },
    );
    await setEmployerBank(db, employer.id, { routingNumber: VALID_ROUTING, accountNumber: '987654321', accountType: 'checking', nachaCompanyId: '1123456789', bankName: 'First Bank' }, TEST_KEYRING);
    const schedule = await createSchedule(db, { employerId: employer.id, name: 'Biweekly', frequency: 'biweekly', anchorDate: '2026-01-05', payDateRule: { kind: 'offset_after_end', days: 5 } });
    const pat = await createTestEmployee(db, { firstName: 'Pat', lastName: 'Doe' });
    await upsertProfile(db, pat.id, { employerId: employer.id, payScheduleId: schedule.id, startDate: '2025-06-01', us: { workState: 'TX', flsaStatus: 'exempt' } });
    await createCompensation(db, pat.id, { effectiveFrom: '2025-06-01', payType: 'salary', amount: 52_000, period: 'year' }, { createdBy: 'u' });
    await setPaymentDetails(db, pat.id, { nationalId: VALID_SSN, bankRoutingNumber: VALID_ROUTING, bankAccountNumber: '123456789', bankAccountType: 'savings', homeAddress: { line1: '9 Oak St', city: 'Austin', region: 'TX', postalCode: '78702' } }, { keyring: TEST_KEYRING, selfService: false });
    await createElection(db, pat.id, { kind: 'us_w4', effectiveFrom: '2026-01-01', data: { formYear: 2026, filingStatus: 'single', multipleJobs: false, dependentsAmount: 0, otherIncome: 0, deductions: 0, extraWithholding: 0, exempt: false }, signatureName: 'Pat Doe' }, { signedBy: 'u', source: 'admin' });

    // The real engines and builders, not the fakes the other tests use.
    const { deps, stored } = testDeps({ engines: { ...defaultEngines } });
    const run = await createRun(db, { employerId: employer.id, kind: 'regular', payScheduleId: schedule.id }, prep);
    const calculated = await calculateRun(db, run.id, deps, prep);
    expect(calculated.issues.filter((i) => i.severity === 'error')).toEqual([]);
    // 52,000 / 26 = 2,000.00 gross; federal and state (none in Texas) withholding, FICA 7.65%.
    expect(calculated.totals).toMatchObject({ grossCents: 200_000 });
    expect(calculated.totals!.employeeTaxesCents).toBeGreaterThan(15_300);
    expect(calculated.totals!.netCents).toBe(200_000 - calculated.totals!.employeeTaxesCents);

    const approved = await approveRun(db, run.id, deps, boss);
    expect(approved.payslips).toHaveLength(1);
    const filings = await db.select().from(schema.hrPayrollFilings);
    expect(filings.map((f) => f.kind).sort()).toEqual(['us_940', 'us_941', 'us_state_unemployment', 'us_state_withholding', 'us_w2']);

    for (const filing of filings) {
      const built = await generateFiling(db, filing.id, deps, mgr);
      expect(built.status).toBe('ready');
      expect(built.fileKey).toBeTruthy();
    }
    const f941 = await getFiling(db, filings.find((f) => f.kind === 'us_941')!.id, false);
    expect(f941).toMatchObject({ currency: 'USD', fileName: '941-2026-q1.pdf', issues: [] });
    expect(f941.summary).toBeDefined();
    const pdf = [...stored.entries()].find(([key]) => key.endsWith('941-2026-q1.pdf'))!;
    expect((await PDFDocument.load(pdf[1].body)).getPageCount()).toBeGreaterThanOrEqual(1);

    const ach = await buildPaymentFile(db, run.id, deps);
    expect(ach.fileName).toMatch(/\.ach$|\.txt$|nacha/i);
    expect(ach.content.split('\n')[0]!.startsWith('1')).toBe(true);
    expect(ach.content).toContain(VALID_ROUTING.slice(0, 8));

    const statement = await annualStatementPdf(db, pat.id, 2026, employer.id, deps);
    expect(statement.fileName).toBe('w2-2026.pdf');
    expect(new TextDecoder().decode(statement.bytes.slice(0, 5))).toBe('%PDF-');
  });
});
