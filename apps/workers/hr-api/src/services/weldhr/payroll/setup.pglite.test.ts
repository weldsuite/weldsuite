/**
 * Employers, schedules, payroll profiles, compensation, components, elections
 * and payment details against a real (pglite) tenant schema.
 */

import { eq } from 'drizzle-orm';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Database } from '@weldsuite/worker-kit/db';
import { schema } from '@weldsuite/worker-kit/db';
import { createPayrollDb, resetPayrollTables } from '../../../test/payroll-db';
import {
  TEST_KEYRING,
  VALID_BSN,
  VALID_IBAN,
  VALID_IBAN_2,
  VALID_ROUTING,
  VALID_SSN,
  createTestEmployee,
  putOnNlPayroll,
  setupNlEmployer,
} from '../../../test/payroll-fixtures';
import { HrConflictError, HrNotFoundError, HrValidationError } from '../shared';
import {
  createComponent,
  createCompensation,
  createElection,
  deleteCompensation,
  deleteComponent,
  getPayrollEmployee,
  listPayrollEmployees,
  myPayrollDetails,
  setPaymentDetails,
  updateComponent,
  upsertProfile,
} from './employees';
import { createEmployer, deleteEmployer, getEmployer, listEmployers, setEmployerBank, updateEmployer } from './employers';
import { createSchedule, deleteSchedule, listSchedules, updateSchedule } from './schedules';

let db: Database;

beforeAll(async () => {
  db = await createPayrollDb();
}, 120_000);

beforeEach(async () => {
  await resetPayrollTables(db);
});

describe('employers', () => {
  it('defaults the currency by country and masks the bank account', async () => {
    const nl = await createEmployer(db, { name: 'A', legalName: 'A BV', country: 'NL' }, { createdBy: 'u', keyring: TEST_KEYRING });
    const us = await createEmployer(db, { name: 'B', legalName: 'B Inc', country: 'US' }, { createdBy: 'u', keyring: TEST_KEYRING });
    expect(nl.currency).toBe('EUR');
    expect(us.currency).toBe('USD');

    const { employer, changedFields } = await setEmployerBank(db, nl.id, { iban: 'nl91 abna 0417 1643 00', accountHolder: 'A BV' }, TEST_KEYRING);
    expect(changedFields.sort()).toEqual(['accountHolder', 'iban']);
    expect(employer.bank?.ibanMasked).toBe('NL91 •••• •••• 4300');
    expect(JSON.stringify(employer)).not.toContain('0417');
    // The stored column is ciphertext, not the IBAN.
    const [row] = await db.select().from(schema.hrPayrollEmployers).where(eq(schema.hrPayrollEmployers.id, nl.id));
    expect(row!.bankEncrypted).toBeTruthy();
    expect(row!.bankEncrypted).not.toContain('NL91');
  });

  it('rejects a bad IBAN and a bad routing number', async () => {
    const nl = await createEmployer(db, { name: 'A', legalName: 'A BV', country: 'NL' }, { createdBy: 'u', keyring: TEST_KEYRING });
    await expect(setEmployerBank(db, nl.id, { iban: 'NL91ABNA0417164301' }, TEST_KEYRING)).rejects.toBeInstanceOf(HrValidationError);
    await expect(setEmployerBank(db, nl.id, { routingNumber: '123456789' }, TEST_KEYRING)).rejects.toBeInstanceOf(HrValidationError);
    const ok = await setEmployerBank(db, nl.id, { routingNumber: VALID_ROUTING, accountNumber: '123456789' }, TEST_KEYRING);
    expect(ok.employer.bank?.accountNumberMasked).toBe('•••• 6789');
  });

  it('computes what is missing', async () => {
    const nl = await createEmployer(db, { name: 'A', legalName: 'A BV', country: 'NL' }, { createdBy: 'u', keyring: TEST_KEYRING });
    const fields = nl.issues.map((i) => `${i.severity}:${(i.params as { field: string }).field}`);
    expect(fields).toContain('error:loonheffingennummer');
    expect(fields).toContain('error:sectorCode');
    expect(fields).toContain('warning:whk_rate');
    expect(fields).toContain('warning:contactName');
    expect(fields).toContain('warning:bank_iban');

    const complete = await updateEmployer(db, nl.id, { nlSettings: { loonheffingennummer: '123456789L01', sectorCode: 52 } }, TEST_KEYRING);
    // Only warnings are left: the individual Whk rate, the contact person and the salary account.
    expect(complete.issues.every((i) => i.severity === 'warning')).toBe(true);
    expect(complete.issues.map((i) => (i.params as { field: string }).field).sort()).toEqual(['bank_iban', 'contactName', 'contactPhone', 'whk_rate']);

    const us = await createEmployer(db, { name: 'B', legalName: 'B Inc', country: 'US' }, { createdBy: 'u', keyring: TEST_KEYRING });
    expect(us.issues.map((i) => (i.params as { field: string }).field)).toContain('ein');
  });

  it('requires a SUI rate per state with employees', async () => {
    const us = await createEmployer(db, { name: 'B', legalName: 'B Inc', country: 'US', usSettings: { ein: '12-3456789' } }, { createdBy: 'u', keyring: TEST_KEYRING });
    const emp = await createTestEmployee(db, { firstName: 'Pat' });
    await upsertProfile(db, emp.id, { employerId: us.id, us: { workState: 'TX' } });
    const withState = await getEmployer(db, us.id, TEST_KEYRING);
    expect(withState.issues.some((i) => (i.params as { field: string; state?: string }).field === 'sui_rate' && (i.params as { state?: string }).state === 'TX')).toBe(true);
    const fixed = await updateEmployer(db, us.id, { usSettings: { states: { TX: { suiRates: { [String(new Date().getUTCFullYear())]: 2.7 } } } } }, TEST_KEYRING);
    expect(fixed.issues.some((i) => (i.params as { field: string }).field === 'sui_rate')).toBe(false);
  });

  it('merges year settings instead of replacing them', async () => {
    const nl = await createEmployer(db, { name: 'A', legalName: 'A BV', country: 'NL', nlSettings: { years: { '2026': { whkRate: 1.16 } } } }, { createdBy: 'u', keyring: TEST_KEYRING });
    const next = await updateEmployer(db, nl.id, { nlSettings: { years: { '2027': { whkRate: 1.3 } } } }, TEST_KEYRING);
    expect(Object.keys(next.nlSettings.years ?? {}).sort()).toEqual(['2026', '2027']);
  });

  it('refuses to delete an employer with employees or runs, deletes an empty one', async () => {
    const setup = await setupNlEmployer(db);
    const emp = await createTestEmployee(db, { firstName: 'Eva' });
    await upsertProfile(db, emp.id, { employerId: setup.employerId, payScheduleId: setup.scheduleId });
    await expect(deleteEmployer(db, setup.employerId)).rejects.toBeInstanceOf(HrConflictError);
    const empty = await createEmployer(db, { name: 'Empty', legalName: 'Empty BV', country: 'NL' }, { createdBy: 'u', keyring: TEST_KEYRING });
    await deleteEmployer(db, empty.id);
    expect((await listEmployers(db, TEST_KEYRING)).map((e) => e.id)).not.toContain(empty.id);
    await expect(getEmployer(db, empty.id, TEST_KEYRING)).rejects.toBeInstanceOf(HrNotFoundError);
  });

  it('checks the accounting entity exists and matches the country', async () => {
    await expect(
      createEmployer(db, { name: 'A', legalName: 'A BV', country: 'NL', accountingEntityId: 'ent_missing' }, { createdBy: 'u', keyring: TEST_KEYRING }),
    ).rejects.toBeInstanceOf(HrValidationError);
    await db.insert(schema.entities).values({ id: 'ent_nl', name: 'Acme Books NL', jurisdictionCode: 'NL' });
    await db.insert(schema.entities).values({ id: 'ent_us', name: 'Acme Books US', jurisdictionCode: 'US' });
    const linked = await createEmployer(db, { name: 'A', legalName: 'A BV', country: 'NL', accountingEntityId: 'ent_nl' }, { createdBy: 'u', keyring: TEST_KEYRING });
    expect(linked.accountingEntityName).toBe('Acme Books NL');
    await expect(updateEmployer(db, linked.id, { accountingEntityId: 'ent_us' }, TEST_KEYRING)).rejects.toBeInstanceOf(HrValidationError);
  });
});

describe('schedules', () => {
  it('limits Dutch employers to monthly schedules paid on a day or the last business day', async () => {
    const nl = await createEmployer(db, { name: 'A', legalName: 'A BV', country: 'NL' }, { createdBy: 'u', keyring: TEST_KEYRING });
    await expect(
      createSchedule(db, { employerId: nl.id, name: 'Weekly', frequency: 'weekly', anchorDate: '2026-01-05', payDateRule: { kind: 'offset_after_end', days: 3 } }),
    ).rejects.toBeInstanceOf(HrValidationError);
    await expect(
      createSchedule(db, { employerId: nl.id, name: 'Monthly', frequency: 'monthly', anchorDate: '2026-01-01', payDateRule: { kind: 'offset_after_end', days: 3 } }),
    ).rejects.toBeInstanceOf(HrValidationError);
    const ok = await createSchedule(db, { employerId: nl.id, name: 'Monthly', frequency: 'monthly', anchorDate: '2026-01-01', payDateRule: { kind: 'last_business_day' } });
    expect(ok.nextPeriod).toMatchObject({ start: '2026-01-01', end: '2026-01-31', periodNumber: 1, taxYear: 2026 });
  });

  it('lets a US employer pick any frequency and computes the next period', async () => {
    const us = await createEmployer(db, { name: 'B', legalName: 'B Inc', country: 'US' }, { createdBy: 'u', keyring: TEST_KEYRING });
    const biweekly = await createSchedule(db, { employerId: us.id, name: 'Biweekly', frequency: 'biweekly', anchorDate: '2026-01-05', payDateRule: { kind: 'offset_after_end', days: 5 } });
    expect(biweekly.nextPeriod).toMatchObject({ start: '2026-01-05', end: '2026-01-18' });
    const updated = await updateSchedule(db, biweekly.id, { name: 'Every two weeks' });
    expect(updated.name).toBe('Every two weeks');
  });

  it('does not delete a schedule that has employees', async () => {
    const setup = await setupNlEmployer(db);
    const emp = await createTestEmployee(db, { firstName: 'Eva' });
    await upsertProfile(db, emp.id, { employerId: setup.employerId, payScheduleId: setup.scheduleId });
    await expect(deleteSchedule(db, setup.scheduleId)).rejects.toBeInstanceOf(HrConflictError);
    expect((await listSchedules(db, { employerId: setup.employerId }))[0]!.employeeCount).toBe(1);
  });
});

describe('payroll profile', () => {
  it('hands out income relationship numbers per employer and defaults the contract hours', async () => {
    const setup = await setupNlEmployer(db);
    const a = await createTestEmployee(db, { firstName: 'A', weeklyHours: 32 });
    const b = await createTestEmployee(db, { firstName: 'B' });
    const first = await upsertProfile(db, a.id, { employerId: setup.employerId, payScheduleId: setup.scheduleId });
    const second = await upsertProfile(db, b.id, { employerId: setup.employerId, payScheduleId: setup.scheduleId });
    expect(first.nl.incomeRelationshipNumber).toBe(1);
    expect(second.nl.incomeRelationshipNumber).toBe(2);
    expect(first.nl.contractHoursPerWeek).toBe(32);

    // Updating keeps the number.
    const again = await upsertProfile(db, a.id, { employerId: setup.employerId, nl: { writtenContract: true } });
    expect(again.nl.incomeRelationshipNumber).toBe(1);
    expect(again.nl.writtenContract).toBe(true);

    await expect(upsertProfile(db, b.id, { employerId: setup.employerId, nl: { incomeRelationshipNumber: 1 } })).rejects.toBeInstanceOf(HrConflictError);
  });

  it('rejects a schedule of another employer', async () => {
    const setup = await setupNlEmployer(db);
    const other = await createEmployer(db, { name: 'Other', legalName: 'Other BV', country: 'NL' }, { createdBy: 'u', keyring: TEST_KEYRING });
    const emp = await createTestEmployee(db, { firstName: 'A' });
    await expect(upsertProfile(db, emp.id, { employerId: other.id, payScheduleId: setup.scheduleId })).rejects.toBeInstanceOf(HrValidationError);
  });
});

describe('compensation', () => {
  it('closes the previous row the day before and rejects overlaps', async () => {
    const setup = await setupNlEmployer(db);
    const emp = await createTestEmployee(db, { firstName: 'A' });
    await upsertProfile(db, emp.id, { employerId: setup.employerId, payScheduleId: setup.scheduleId });
    await createCompensation(db, emp.id, { effectiveFrom: '2026-01-01', payType: 'salary', amount: 3000, period: 'month' }, { createdBy: 'u' });
    await createCompensation(db, emp.id, { effectiveFrom: '2026-07-01', payType: 'salary', amount: 3200, period: 'month' }, { createdBy: 'u' });
    const detail = await getPayrollEmployee(db, emp.id, TEST_KEYRING, '2026-08-01');
    expect(detail.compensations.map((c) => [c.effectiveFrom, c.effectiveTo])).toEqual([
      ['2026-07-01', null],
      ['2026-01-01', '2026-06-30'],
    ]);
    await expect(
      createCompensation(db, emp.id, { effectiveFrom: '2026-07-01', payType: 'salary', amount: 3300, period: 'month' }, { createdBy: 'u' }),
    ).rejects.toBeInstanceOf(HrValidationError);
    await expect(
      createCompensation(db, emp.id, { effectiveFrom: '2026-03-01', payType: 'salary', amount: 3300, period: 'month' }, { createdBy: 'u' }),
    ).rejects.toBeInstanceOf(HrValidationError);
  });

  it('checks pay type against period, and re-opens the previous row on delete', async () => {
    const setup = await setupNlEmployer(db);
    const emp = await createTestEmployee(db, { firstName: 'A' });
    await upsertProfile(db, emp.id, { employerId: setup.employerId, payScheduleId: setup.scheduleId });
    await expect(createCompensation(db, emp.id, { effectiveFrom: '2026-01-01', payType: 'hourly', amount: 20, period: 'month' }, { createdBy: 'u' })).rejects.toBeInstanceOf(HrValidationError);
    await expect(createCompensation(db, emp.id, { effectiveFrom: '2026-01-01', payType: 'salary', amount: 20, period: 'hour' }, { createdBy: 'u' })).rejects.toBeInstanceOf(HrValidationError);
    await createCompensation(db, emp.id, { effectiveFrom: '2026-01-01', payType: 'salary', amount: 3000, period: 'month' }, { createdBy: 'u' });
    const second = await createCompensation(db, emp.id, { effectiveFrom: '2026-07-01', payType: 'salary', amount: 3200, period: 'month' }, { createdBy: 'u' });
    await deleteCompensation(db, second.id);
    const detail = await getPayrollEmployee(db, emp.id, TEST_KEYRING, '2026-08-01');
    expect(detail.compensations).toHaveLength(1);
    expect(detail.compensations[0]!.effectiveTo).toBeNull();
  });

  it('refuses to start before an approved period unless the caller confirms', async () => {
    const setup = await setupNlEmployer(db);
    const emp = await createTestEmployee(db, { firstName: 'A' });
    await upsertProfile(db, emp.id, { employerId: setup.employerId, payScheduleId: setup.scheduleId });
    await createCompensation(db, emp.id, { effectiveFrom: '2026-01-01', payType: 'salary', amount: 3000, period: 'month' }, { createdBy: 'u' });
    await db.insert(schema.hrPayRuns).values({ id: 'run_1', employerId: setup.employerId, country: 'NL', currency: 'EUR', periodStart: '2026-03-01', periodEnd: '2026-03-31', payDate: '2026-03-25', taxYear: 2026, periodNumber: 3, status: 'approved' });
    await db.insert(schema.hrPayslips).values({ id: 'slip_1', runId: 'run_1', employeeId: emp.id, employerId: setup.employerId, country: 'NL', currency: 'EUR', status: 'final', number: '2026-0001', periodStart: '2026-03-01', periodEnd: '2026-03-31', payDate: '2026-03-25', taxYear: 2026, periodNumber: 3 });
    await expect(
      createCompensation(db, emp.id, { effectiveFrom: '2026-03-15', payType: 'salary', amount: 3200, period: 'month' }, { createdBy: 'u' }),
    ).rejects.toMatchObject({ code: 'RETROACTIVE_COMPENSATION' });
    await expect(
      createCompensation(db, emp.id, { effectiveFrom: '2026-03-15', payType: 'salary', amount: 3200, period: 'month', allowRetroactive: true }, { createdBy: 'u' }),
    ).resolves.toMatchObject({ effectiveFrom: '2026-03-15' });
  });
});

describe('components', () => {
  it('validates the code against the catalog, the country and the recurring flag', async () => {
    const setup = await setupNlEmployer(db);
    const emp = await createTestEmployee(db, { firstName: 'A' });
    await expect(createComponent(db, emp.id, { code: 'nl.company_car', effectiveFrom: '2026-01-01', params: { list_price: 40000, percent: 22 } }, { createdBy: 'u' })).rejects.toBeInstanceOf(HrValidationError);
    await upsertProfile(db, emp.id, { employerId: setup.employerId, payScheduleId: setup.scheduleId });

    await expect(createComponent(db, emp.id, { code: 'nope', effectiveFrom: '2026-01-01', amount: 10 }, { createdBy: 'u' })).rejects.toBeInstanceOf(HrValidationError);
    await expect(createComponent(db, emp.id, { code: 'us.401k', effectiveFrom: '2026-01-01', amount: 10 }, { createdBy: 'u' })).rejects.toBeInstanceOf(HrValidationError);
    await expect(createComponent(db, emp.id, { code: 'bonus', effectiveFrom: '2026-01-01', amount: 10 }, { createdBy: 'u' })).rejects.toBeInstanceOf(HrValidationError);
    await expect(createComponent(db, emp.id, { code: 'nl.company_car', effectiveFrom: '2026-01-01', params: { percent: 22 } }, { createdBy: 'u' })).rejects.toBeInstanceOf(HrValidationError);

    const car = await createComponent(db, emp.id, { code: 'nl.company_car', effectiveFrom: '2026-01-01', params: { list_price: 40000, percent: 22 } }, { createdBy: 'u' });
    expect(car.params).toEqual({ list_price: 40000, percent: 22 });
    const allowance = await createComponent(db, emp.id, { code: 'allowance.taxable', effectiveFrom: '2026-01-01', amount: 50 }, { createdBy: 'u' });
    expect(allowance.amount).toBe('50.00');
    const updated = await updateComponent(db, allowance.id, { amount: 75, effectiveTo: '2026-12-31' });
    expect(updated.amount).toBe('75.00');
    await deleteComponent(db, allowance.id);
    expect((await getPayrollEmployee(db, emp.id, TEST_KEYRING)).components.map((c) => c.id)).toEqual([car.id]);
  });
});

describe('payment details', () => {
  it('validates BSN, IBAN and date of birth, encrypts them and returns them masked', async () => {
    const setup = await setupNlEmployer(db);
    const emp = await createTestEmployee(db, { firstName: 'A' });
    await upsertProfile(db, emp.id, { employerId: setup.employerId, payScheduleId: setup.scheduleId });

    await expect(setPaymentDetails(db, emp.id, { nationalId: '123456789' }, { keyring: TEST_KEYRING, selfService: false })).rejects.toBeInstanceOf(HrValidationError);
    await expect(setPaymentDetails(db, emp.id, { bankIban: 'NL00BANK0000000000' }, { keyring: TEST_KEYRING, selfService: false })).rejects.toBeInstanceOf(HrValidationError);
    await expect(setPaymentDetails(db, emp.id, { dateOfBirth: '2999-01-01' }, { keyring: TEST_KEYRING, selfService: false })).rejects.toBeInstanceOf(HrValidationError);

    const result = await setPaymentDetails(
      db,
      emp.id,
      { nationalId: VALID_BSN, dateOfBirth: '1990-05-17', bankIban: VALID_IBAN, bankAccountHolder: 'A Tester' },
      { keyring: TEST_KEYRING, selfService: false },
    );
    expect(result.changedFields.sort()).toEqual(['bankAccountHolder', 'bankIban', 'dateOfBirth', 'nationalId']);
    expect(result.bankChanged).toBe(true);
    expect(result.details.nationalIdMasked).toBe('•••••2333');
    expect(result.details.bankIbanMasked).toBe('NL91 •••• •••• 4300');
    expect(JSON.stringify(result.details)).not.toContain(VALID_BSN);

    const [row] = await db.select().from(schema.hrEmployees);
    expect(row!.sensitiveEncrypted).toBeTruthy();
    expect(row!.sensitiveEncrypted).not.toContain(VALID_BSN);

    const same = await setPaymentDetails(db, emp.id, { bankIban: VALID_IBAN }, { keyring: TEST_KEYRING, selfService: false });
    expect(same.changedFields).toEqual([]);
    expect(same.bankChanged).toBe(false);
  });

  it('ignores idVerifiedAt from self-service', async () => {
    const setup = await setupNlEmployer(db);
    const emp = await createTestEmployee(db, { firstName: 'A' });
    await upsertProfile(db, emp.id, { employerId: setup.employerId, payScheduleId: setup.scheduleId });
    const mine = await setPaymentDetails(db, emp.id, { nationalId: VALID_BSN, idVerifiedAt: '2026-01-01' }, { keyring: TEST_KEYRING, selfService: true });
    expect(mine.details.idVerifiedAt).toBeNull();
    const hr = await setPaymentDetails(db, emp.id, { idVerifiedAt: '2026-01-01' }, { keyring: TEST_KEYRING, selfService: false });
    expect(hr.details.idVerifiedAt).toBe('2026-01-01');
  });

  it('validates SSN and routing numbers for a US employee', async () => {
    const us = await createEmployer(db, { name: 'B', legalName: 'B Inc', country: 'US' }, { createdBy: 'u', keyring: TEST_KEYRING });
    const emp = await createTestEmployee(db, { firstName: 'Pat' });
    await upsertProfile(db, emp.id, { employerId: us.id, us: { workState: 'TX' } });
    await expect(setPaymentDetails(db, emp.id, { nationalId: '000-12-3456' }, { keyring: TEST_KEYRING, selfService: false })).rejects.toBeInstanceOf(HrValidationError);
    await expect(setPaymentDetails(db, emp.id, { nationalId: VALID_BSN }, { keyring: TEST_KEYRING, selfService: false })).resolves.toBeDefined();
    const ok = await setPaymentDetails(db, emp.id, { nationalId: VALID_SSN, bankRoutingNumber: VALID_ROUTING, bankAccountNumber: '123456789', bankAccountType: 'checking' }, { keyring: TEST_KEYRING, selfService: false });
    expect(ok.details.nationalIdMasked).toBe('•••••6789');
    expect(ok.details.bankAccountNumberMasked).toBe('•••• 6789');
  });
});

describe('tax elections', () => {
  it('are append-only, kind-checked and signed', async () => {
    const setup = await setupNlEmployer(db);
    const emp = await createTestEmployee(db, { firstName: 'A' });
    await upsertProfile(db, emp.id, { employerId: setup.employerId, payScheduleId: setup.scheduleId });
    await expect(
      createElection(db, emp.id, { kind: 'us_w4', effectiveFrom: '2026-01-01', signatureName: 'A', data: { formYear: 2026, filingStatus: 'single', multipleJobs: false, dependentsAmount: 0, otherIncome: 0, deductions: 0, extraWithholding: 0, exempt: false } }, { signedBy: 'u', source: 'admin' }),
    ).rejects.toBeInstanceOf(HrValidationError);

    await createElection(db, emp.id, { kind: 'nl_loonheffingskorting', effectiveFrom: '2026-01-01', data: { applyCredit: true }, signatureName: 'A Tester' }, { signedBy: 'user_hr', source: 'admin' });
    const second = await createElection(db, emp.id, { kind: 'nl_loonheffingskorting', effectiveFrom: '2026-07-01', data: { applyCredit: false }, signatureName: 'A Tester' }, { signedBy: emp.id, source: 'employee' });
    expect(second.source).toBe('employee');
    expect(second.signedAt).toBeTruthy();

    const june = await getPayrollEmployee(db, emp.id, TEST_KEYRING, '2026-06-15');
    expect((june.currentElections[0]!.data as { applyCredit: boolean }).applyCredit).toBe(true);
    const august = await getPayrollEmployee(db, emp.id, TEST_KEYRING, '2026-08-15');
    expect((august.currentElections[0]!.data as { applyCredit: boolean }).applyCredit).toBe(false);
    expect(await db.select().from(schema.hrTaxElections)).toHaveLength(2);
  });
});

describe('readiness', () => {
  it('lists blocking problems first and treats a missing election as a warning', async () => {
    const setup = await setupNlEmployer(db);
    const emp = await createTestEmployee(db, { firstName: 'A' });
    await upsertProfile(db, emp.id, { employerId: setup.employerId, payScheduleId: setup.scheduleId });
    const [item] = (await listPayrollEmployees(db, { onPayroll: true }, TEST_KEYRING, '2026-08-01'))!;
    const codes = item!.issues.map((i) => `${i.severity}:${i.code}`);
    expect(codes).toEqual(expect.arrayContaining(['error:missing_compensation', 'error:missing_tax_id', 'error:missing_bank_account', 'error:missing_date_of_birth', 'warning:missing_tax_election']));
    expect(item!.issues[0]!.severity).toBe('error');
    expect(item!.employerName).toBe('Acme BV');

  });

  it('is clean for a fully set up employee and filters by onPayroll', async () => {
    const setup = await setupNlEmployer(db);
    const ready = await createTestEmployee(db, { firstName: 'Ready' });
    const outsider = await createTestEmployee(db, { firstName: 'Outsider' });
    await putOnNlPayroll(db, ready.id, setup, { from: '2026-01-01' });
    const onPayroll = await listPayrollEmployees(db, { onPayroll: true }, TEST_KEYRING, '2026-08-01');
    expect(onPayroll.map((e) => e.employeeId)).toEqual([ready.id]);
    expect(onPayroll[0]!.issues).toEqual([]);
    expect(onPayroll[0]!.currentCompensation?.amount).toBe('3000.0000');
    const all = await listPayrollEmployees(db, {}, TEST_KEYRING, '2026-08-01');
    expect(all.map((e) => e.employeeId).sort()).toEqual([ready.id, outsider.id].sort());
    const notOnPayroll = await listPayrollEmployees(db, { onPayroll: false }, TEST_KEYRING, '2026-08-01');
    expect(notOnPayroll.map((e) => e.employeeId)).toEqual([outsider.id]);
  });

  it('tells the employee what is missing and which elections to sign', async () => {
    const setup = await setupNlEmployer(db);
    const emp = await createTestEmployee(db, { firstName: 'A' });
    await upsertProfile(db, emp.id, { employerId: setup.employerId, payScheduleId: setup.scheduleId });
    const before = await myPayrollDetails(db, emp.id, TEST_KEYRING, '2026-08-01');
    expect(before.country).toBe('NL');
    expect(before.missing.sort()).toEqual(['bankIban', 'dateOfBirth', 'idDocument', 'nationalId']);
    expect(before.requiredElections).toEqual([{ kind: 'nl_loonheffingskorting', state: null }]);
    await setPaymentDetails(db, emp.id, { nationalId: VALID_BSN, dateOfBirth: '1990-05-17', bankIban: VALID_IBAN_2, idDocumentType: 'passport', idDocumentNumber: 'NP1234567' }, { keyring: TEST_KEYRING, selfService: true });
    await createElection(db, emp.id, { kind: 'nl_loonheffingskorting', effectiveFrom: '2026-01-01', data: { applyCredit: true }, signatureName: 'A' }, { signedBy: emp.id, source: 'employee' });
    const after = await myPayrollDetails(db, emp.id, TEST_KEYRING, '2026-08-01');
    expect(after.missing).toEqual([]);
    expect(after.requiredElections).toEqual([]);
    expect(after.elections).toHaveLength(1);
  });
});

