/**
 * Fixtures for the payroll tests: a fake engine (so tests never depend on the
 * NL / US engines other packages are still writing), fake builders, and a
 * helper that sets up an employer, a schedule and employees ready to be paid.
 */

import { toCents } from '@weldsuite/payroll-domain/money';
import type { PayrollDocument } from '@weldsuite/payroll-domain/documents';
import type { NlFilingData, PayslipInput, PayslipLine, PayslipResult } from '@weldsuite/payroll-domain/types';
import type { Database } from '@weldsuite/worker-kit/db';
import { schema } from '@weldsuite/worker-kit/db';
import { generateId } from '@weldsuite/worker-kit/id';
import { basicDeps, defaultEngines, type PayrollDeps, type PayrollEngines } from '../services/weldhr/payroll/deps';
import { createEmployer, setEmployerBank } from '../services/weldhr/payroll/employers';
import {
  createCompensation,
  createElection,
  setPaymentDetails,
  upsertProfile,
} from '../services/weldhr/payroll/employees';
import { createSchedule } from '../services/weldhr/payroll/schedules';

export const TEST_KEYRING = { v1: '0123456789abcdef'.repeat(4) };

/** Dutch BSN that passes the elfproef, valid IBAN and ABA routing numbers. */
export const VALID_BSN = '111222333';
export const VALID_BSN_2 = '123456782';
export const VALID_IBAN = 'NL91ABNA0417164300';
export const VALID_IBAN_2 = 'NL02ABNA0123456789';
export const VALID_ROUTING = '021000021';
export const VALID_SSN = '123-45-6789';

function monthlyAmount(input: PayslipInput): number {
  const comp = input.compensation;
  if (!comp) return 0;
  const amount = toCents(comp.amount);
  if (comp.payType === 'hourly') {
    const hours = input.inputs.filter((i) => i.code === 'hours.regular').reduce((sum, i) => sum + (i.quantity ?? 0), 0);
    return Math.round(amount * hours);
  }
  if (comp.period === 'month') return amount;
  if (comp.period === 'year') return Math.round(amount / 12);
  if (comp.period === 'week') return Math.round((amount * 52) / 12);
  return amount;
}

/** A stand-in engine: 20% tax, 10% employer premium, inputs added as bonus / reimbursement / deduction. */
export function fakeCalculate(input: PayslipInput): PayslipResult {
  const salary = monthlyAmount(input);
  const bonus = input.inputs.filter((i) => i.code === 'bonus').reduce((sum, i) => sum + (i.amountCents ?? 0), 0);
  const reimbursements = input.inputs.filter((i) => i.code === 'reimbursement').reduce((sum, i) => sum + (i.amountCents ?? 0), 0);
  const deductions = input.inputs.filter((i) => i.code === 'deduction.net').reduce((sum, i) => sum + (i.amountCents ?? 0), 0);
  const gross = salary + bonus;
  const tax = Math.round(gross * 0.2);
  const employerTaxes = Math.round(gross * 0.1);
  const net = gross - tax - deductions + reimbursements;

  const lines: PayslipLine[] = [];
  if (salary) lines.push({ code: 'salary', section: 'earning', labelKey: 'nl.salary', amountCents: salary });
  if (bonus) lines.push({ code: 'bonus', section: 'earning', labelKey: 'bonus', amountCents: bonus });
  if (deductions) lines.push({ code: 'deduction.net', section: 'deduction', labelKey: 'deduction.net', amountCents: -deductions });
  lines.push({ code: 'wage_tax', section: 'tax', labelKey: 'nl.wage_tax', amountCents: -tax });
  if (reimbursements) lines.push({ code: 'reimbursement', section: 'reimbursement', labelKey: 'reimbursement', amountCents: reimbursements });
  lines.push({ code: 'employer_premium', section: 'employer', labelKey: 'nl.premium', amountCents: employerTaxes });

  const ytd = { ...input.ytd };
  ytd['gross'] = (ytd['gross'] ?? 0) + gross;
  ytd['tax'] = (ytd['tax'] ?? 0) + tax;
  ytd['nl.loon_lb'] = (ytd['nl.loon_lb'] ?? 0) + gross;

  return {
    lines,
    grossCents: gross,
    taxableWageCents: gross,
    employeeTaxesCents: tax,
    employeeDeductionsCents: deductions,
    reimbursementsCents: reimbursements,
    netCents: net,
    employerTaxesCents: employerTaxes,
    employerCostCents: gross + employerTaxes + reimbursements,
    ytd,
    filingData:
      input.country === 'NL'
        ? ({
            kind: 'nl',
            tableCode: '010',
            applyLoonheffingskorting: input.nl.applyLoonheffingskorting,
            anonymous: input.nl.anonymous,
            insured: { ww: true, zw: true, wao: true },
            awfRate: 'low',
            aofRate: 'low',
            zvw: 'employer_levy',
            contract: { written: true, indefinite: true, onCall: false },
            amounts: { loonLbPh: gross, loonSv: gross, wageTax: tax, awfPremium: employerTaxes },
            hoursPaid: 160,
            svDays: 21,
          } as unknown as PayslipResult['filingData'])
        : ({
            kind: 'us',
            federal: { fitWages: gross, federalIncomeTax: tax, ssWages: gross, ssTaxEmployee: 0, ssTaxEmployer: 0, medicareWages: gross, medicareTaxEmployee: 0, medicareTaxEmployer: 0, additionalMedicareWages: 0, additionalMedicareTax: 0, futaGrossWages: gross, futaWages: gross, futaTax: 0, ssTips: 0, box12: {}, dependentCare: 0 },
            states: {},
            qualifiedOvertimePremium: 0,
            hoursWorked: 160,
          } as unknown as PayslipResult['filingData']),
    issues: [],
    ruleSet: 'fake-1',
  };
}

/** Calls the fake builders received, so tests can assert what hr-api passed them. */
export interface BuilderCalls {
  sepa: Array<Parameters<PayrollEngines['buildSepaSalaryBatch']>[0]>;
  nacha: Array<Parameters<PayrollEngines['buildNachaFile']>[0]>;
  loonaangifte: Array<Parameters<PayrollEngines['buildLoonaangifte']>[0]>;
  annual: Array<Parameters<PayrollEngines['nlAnnualStatement']>[0]>;
  w2: Array<Parameters<PayrollEngines['formW2']>[0]>;
  f941: Array<Parameters<PayrollEngines['form941']>[0]>;
  states: Array<{ kind: string; state: string; employees: number }>;
}

function sumAmounts(items: NlFilingData[]): NlFilingData {
  const first = items[0]!;
  const amounts: Record<string, number> = {};
  for (const item of items) {
    for (const [key, value] of Object.entries(item.amounts as unknown as Record<string, number>)) amounts[key] = (amounts[key] ?? 0) + value;
  }
  return { ...first, amounts: amounts as unknown as NlFilingData['amounts'], hoursPaid: items.reduce((n, i) => n + i.hoursPaid, 0), svDays: items.reduce((n, i) => n + i.svDays, 0) };
}

export function fakeEngines(overrides: Partial<PayrollEngines> = {}, calls?: BuilderCalls): PayrollEngines {
  const doc = (title: string, language: 'en' | 'nl' = 'en'): PayrollDocument => ({
    title,
    language,
    sections: [{ kind: 'fields', fields: [{ label: 'Test', value: title }] }],
  });
  return {
    ...defaultEngines,
    calculatePayslip: fakeCalculate,
    sumNlFilingData: sumAmounts,
    loonaangifteDueDate: (year, month) => (month === 12 ? `${year + 1}-01-31` : `${year}-${String(month + 1).padStart(2, '0')}-28`),
    buildSepaSalaryBatch: (input) => {
      calls?.sepa.push(input);
      return { fileName: 'salary.xml', contentType: 'application/xml', content: `<sepa count="${input.salaries.length}"/>`, issues: [] };
    },
    buildNachaFile: (input) => {
      calls?.nacha.push(input);
      return { fileName: 'payroll.ach', contentType: 'text/plain', content: `ach ${input.credits.length}`, issues: [] };
    },
    buildLoonaangifte: (input) => {
      calls?.loonaangifte.push(input);
      const wageTax = input.ikvs.reduce((n, ikv) => n + ikv.filing.amounts.wageTax, 0);
      return {
        file: { fileName: `loonaangifte-${input.taxYear}.xml`, contentType: 'application/xml', content: `<aangifte ikvs="${input.ikvs.length}" corrections="${input.corrections.length}"/>` },
        summary: { TotLnLbPh: input.ikvs.reduce((n, ikv) => n + ikv.filing.amounts.loonLbPh, 0), TotTeBet: wageTax },
        amountDueCents: wageTax,
        issues: [],
      };
    },
    loonaangifteSummaryDocument: () => doc('Loonaangifte', 'nl'),
    nlAnnualStatement: (input) => {
      calls?.annual.push(input);
      return doc(`Jaaropgaaf ${input.year}`, input.lang);
    },
    form941: (input) => {
      calls?.f941.push(input);
      return { summary: { line2: input.payslips.reduce((n, p) => n + p.filingData.federal.fitWages, 0) }, amountDueCents: 12_345, dueDate: '2026-10-31', document: doc('Form 941') };
    },
    form940: () => ({ summary: { line3: 1 }, amountDueCents: 0, dueDate: '2027-01-31', document: doc('Form 940') }),
    formW2: (input) => {
      calls?.w2.push(input);
      return { summary: { box1: 1 }, amountDueCents: 0, dueDate: '2027-01-31', document: doc(`W-2 ${input.taxYear}`) };
    },
    formW3: () => ({ summary: { box1: 1 }, amountDueCents: 0, dueDate: '2027-01-31', document: doc('Form W-3') }),
    stateWithholdingReport: (input) => {
      calls?.states.push({ kind: 'withholding', state: input.state, employees: input.employees.length });
      return { summary: { wages: 1 }, amountDueCents: 0, dueDate: '2026-10-31', document: doc('State withholding'), files: [{ fileName: `${input.state}-wh.csv`, contentType: 'text/csv', content: 'a,b\n1,2\n' }] };
    },
    stateUnemploymentReport: (input) => {
      calls?.states.push({ kind: 'unemployment', state: input.state, employees: input.employees.length });
      return { summary: { wages: 1 }, amountDueCents: 0, dueDate: '2026-10-31', document: doc('State unemployment') };
    },
    ...overrides,
  };
}

export function newBuilderCalls(): BuilderCalls {
  return { sepa: [], nacha: [], loonaangifte: [], annual: [], w2: [], f941: [], states: [] };
}

/** Deps with the fake engine and recorders for the bridge and the meter. */
export function testDeps(overrides: Partial<PayrollDeps> = {}) {
  const calls = newBuilderCalls();
  const meterCalls: Array<Parameters<NonNullable<PayrollDeps['meter']>>[0]> = [];
  const booksCalls: Array<{ workspaceKey: string; input: Parameters<NonNullable<PayrollDeps['books']>['postPayroll']>[1] }> = [];
  const stored = new Map<string, { body: Uint8Array; contentType: string }>();
  const bucket = {
    put: async (key: string, value: ArrayBuffer | Uint8Array | string, options?: { httpMetadata?: { contentType?: string } }) => {
      const body = typeof value === 'string' ? new TextEncoder().encode(value) : value instanceof Uint8Array ? value : new Uint8Array(value);
      stored.set(key, { body, contentType: options?.httpMetadata?.contentType ?? 'application/octet-stream' });
    },
    get: async (key: string) => {
      const hit = stored.get(key);
      if (!hit) return null;
      return {
        body: new Response(hit.body).body,
        arrayBuffer: async () => hit.body.buffer.slice(hit.body.byteOffset, hit.body.byteOffset + hit.body.byteLength),
        text: async () => new TextDecoder().decode(hit.body),
        httpMetadata: { contentType: hit.contentType },
      };
    },
    delete: async (key: string) => {
      stored.delete(key);
    },
    list: async (options?: { prefix?: string }) => ({
      objects: [...stored.keys()].filter((k) => k.startsWith(options?.prefix ?? '')).map((key) => ({ key, size: stored.get(key)!.body.byteLength })),
      truncated: false,
    }),
  } as unknown as R2Bucket;

  const deps = basicDeps({
    keyring: TEST_KEYRING,
    engines: fakeEngines({}, calls),
    bucket,
    workspaceKey: 'org_test',
    meter: async (events) => {
      meterCalls.push(events);
    },
    books: {
      postPayroll: async (workspaceKey, input) => {
        booksCalls.push({ workspaceKey, input });
        return { status: 'posted', importId: 'pri_fake', journalEntryId: 'je_fake', duplicate: false };
      },
    },
    nlSoftwareRelationNumber: 'SWO12345',
    now: () => new Date('2026-08-01T10:00:00Z'),
    ...overrides,
  });
  return { deps, meterCalls, booksCalls, stored, calls };
}

let counter = 0;
const uid = (prefix: string) => `${prefix}_${Date.now().toString(36)}${(counter += 1).toString(36)}`;

export interface TestEmployee {
  id: string;
  firstName: string;
}

/** An HR employee (and workspace member row) in the tenant DB. */
export async function createTestEmployee(
  db: Database,
  input: { firstName: string; lastName?: string; weeklyHours?: number; startDate?: string; userId?: string; email?: string },
): Promise<TestEmployee> {
  const id = uid('hremp');
  const userId = input.userId ?? uid('user');
  await db.insert(schema.workspaceMembers).values({
    id: uid('wm'),
    userId,
    name: `${input.firstName} ${input.lastName ?? 'Tester'}`,
    email: input.email ?? `${id}@example.com`,
    status: 'ACTIVE',
    memberType: 'INTERNAL',
  });
  await db.insert(schema.hrEmployees).values({
    id,
    firstName: input.firstName,
    lastName: input.lastName ?? 'Tester',
    email: input.email ?? `${id}@example.com`,
    userId,
    status: 'active',
    weeklyHours: input.weeklyHours ?? 40,
    startDate: input.startDate ?? '2025-01-01',
  });
  return { id, firstName: input.firstName };
}

export interface PayrollSetup {
  employerId: string;
  scheduleId: string;
}

/** An NL employer with everything it needs, and a monthly schedule paying on the 25th. */
export async function setupNlEmployer(db: Database, opts: { requireSeparateApprover?: boolean; accountingEntityId?: string | null } = {}): Promise<PayrollSetup> {
  const employer = await createEmployer(
    db,
    {
      name: 'Acme BV',
      legalName: 'Acme B.V.',
      country: 'NL',
      accountingEntityId: opts.accountingEntityId ?? null,
      address: { line1: 'Dorpsstraat', houseNumber: '1', postalCode: '1234 AB', city: 'Utrecht', country: 'NL' },
      nlSettings: {
        loonheffingennummer: '123456789L01',
        sectorCode: 52,
        contactName: 'Piet Puk',
        contactPhone: '0301234567',
        years: { '2026': { whkRate: 1.16, aofSmallEmployer: true } },
      },
      requireSeparateApprover: opts.requireSeparateApprover ?? false,
    },
    { createdBy: 'user_admin', keyring: TEST_KEYRING },
  );
  await setEmployerBank(db, employer.id, { accountHolder: 'Acme B.V.', iban: VALID_IBAN }, TEST_KEYRING);
  const schedule = await createSchedule(db, {
    employerId: employer.id,
    name: 'Monthly',
    frequency: 'monthly',
    anchorDate: '2026-01-01',
    payDateRule: { kind: 'day_of_month', day: 25 },
  });
  return { employerId: employer.id, scheduleId: schedule.id };
}

/** Put an employee on the NL payroll with pay, bank, BSN, DOB, ID check and a loonheffingskorting election. */
export async function putOnNlPayroll(
  db: Database,
  employeeId: string,
  setup: PayrollSetup,
  opts: { salary?: number; hourly?: number; from?: string; iban?: string; bsn?: string; withElection?: boolean } = {},
): Promise<void> {
  await upsertProfile(db, employeeId, {
    employerId: setup.employerId,
    payScheduleId: setup.scheduleId,
    startDate: opts.from ?? '2025-01-01',
    nl: { writtenContract: true, indefiniteContract: true, surnamePrefix: null },
  });
  await createCompensation(
    db,
    employeeId,
    opts.hourly
      ? { effectiveFrom: opts.from ?? '2025-01-01', payType: 'hourly', amount: opts.hourly, period: 'hour' }
      : { effectiveFrom: opts.from ?? '2025-01-01', payType: 'salary', amount: opts.salary ?? 3000, period: 'month' },
    { createdBy: 'user_admin' },
  );
  await setPaymentDetails(
    db,
    employeeId,
    {
      nationalId: opts.bsn ?? VALID_BSN,
      dateOfBirth: '1990-05-17',
      bankIban: opts.iban ?? VALID_IBAN_2,
      bankAccountHolder: 'Test Employee',
      idVerifiedAt: '2025-01-02',
    },
    { keyring: TEST_KEYRING, selfService: false },
  );
  if (opts.withElection !== false) {
    await createElection(
      db,
      employeeId,
      { kind: 'nl_loonheffingskorting', effectiveFrom: opts.from ?? '2025-01-01', data: { applyCredit: true }, signatureName: 'Test Employee' },
      { signedBy: 'user_admin', source: 'admin' },
    );
  }
}

export { generateId };

export interface NlWorld extends PayrollSetup {
  eva: TestEmployee;
  hans: TestEmployee;
}

/** An NL employer with a salaried employee (Eva, 3000 a month) and an hourly one (Hans, 20 an hour), both ready to be paid. */
export async function nlWorld(db: Database, opts: { requireSeparateApprover?: boolean; accountingEntityId?: string | null } = {}): Promise<NlWorld> {
  const setup = await setupNlEmployer(db, opts);
  const eva = await createTestEmployee(db, { firstName: 'Eva', lastName: 'Alder' });
  const hans = await createTestEmployee(db, { firstName: 'Hans', lastName: 'Berg' });
  await putOnNlPayroll(db, eva.id, setup, { from: '2026-01-01', salary: 3000, bsn: VALID_BSN });
  await putOnNlPayroll(db, hans.id, setup, { from: '2026-01-01', hourly: 20, bsn: VALID_BSN_2, iban: VALID_IBAN });
  return { ...setup, eva, hans };
}
