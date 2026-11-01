/**
 * Route tests for WeldHR payroll setup (/payroll: the flag, employers, pay
 * schedules, employees on payroll, compensation, components, tax elections,
 * payment details, the overview) and the payroll routes of My HR, through
 * the whole /api/weldhr router on a pglite tenant database.
 *
 * These are the requests the Rust port (rust/modules/hr/src/payroll) is
 * compared on in conformance mode, refusals included.
 */

import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createMemoryR2 } from '@weldsuite/worker-kit/testing/r2';
import type { Database } from '@weldsuite/worker-kit/db';
import { HR_ADMIN, data, errorOf, hrCaller, hrDb, resetHr, seedEmployee, seedMember } from '../../../test/hr-fixtures';

let db: Database;
let bucket: R2Bucket;

const PAYROLL = ['payroll:read', 'payroll:prepare', 'payroll:approve', 'payroll:manage'];
const FLAGS = ['weldhr-payroll'];

beforeAll(async () => {
  db = await hrDb();
}, 60_000);

beforeEach(async () => {
  bucket = createMemoryR2();
  await resetHr(db);
  await seedMember(db, HR_ADMIN, { name: 'Hanna Admin', email: 'hanna@example.com' });
  await seedMember(db, 'user_eva', { name: 'Eva Alder', email: 'eva@example.com' });
  await seedEmployee(db, { id: 'hremp_eva', userId: 'user_eva', firstName: 'Eva', lastName: 'Alder', email: 'eva@example.com', weeklyHours: 32 });
  await seedEmployee(db, { id: 'hremp_hans', firstName: 'Hans', lastName: 'Berg', email: 'hans@example.com' });
  await seedEmployee(db, { id: 'hremp_lee', firstName: 'Lee', lastName: 'Chen', email: 'lee@example.com' });
});

const admin = () => hrCaller(db, { grants: [...PAYROLL, 'employees:self'], flags: FLAGS, env: { STORAGE: bucket } });
const as = (grants: string[], userId = HR_ADMIN) => hrCaller(db, { grants, userId, flags: FLAGS, env: { STORAGE: bucket } });
const eva = () => hrCaller(db, { grants: ['employees:self'], userId: 'user_eva', flags: FLAGS, env: { STORAGE: bucket } });

const NL_EMPLOYER = {
  name: 'Acme BV',
  legalName: 'Acme B.V.',
  country: 'NL',
  address: { line1: 'Dorpsstraat', houseNumber: '1', postalCode: '1234 AB', city: 'Utrecht', country: 'NL' },
  nlSettings: {
    loonheffingennummer: '123456789L01',
    sectorCode: 52,
    contactName: 'Piet Puk',
    contactPhone: '0301234567',
    years: { '2026': { whkRate: 1.16, aofSmallEmployer: true } },
  },
};

async function nlEmployer(): Promise<{ employerId: string; scheduleId: string }> {
  const employer = await data<{ id: string }>(await admin().send('POST', '/payroll/employers', NL_EMPLOYER));
  await admin().send('PUT', `/payroll/employers/${employer.id}/bank`, { accountHolder: 'Acme B.V.', iban: 'NL91ABNA0417164300' });
  const schedule = await data<{ id: string }>(
    await admin().send('POST', '/payroll/schedules', {
      employerId: employer.id,
      name: 'Monthly',
      frequency: 'monthly',
      anchorDate: '2026-01-01',
      payDateRule: { kind: 'day_of_month', day: 25 },
    }),
  );
  return { employerId: employer.id, scheduleId: schedule.id };
}

describe('the weldhr-payroll flag', () => {
  it('answers 404 on payroll paths without it, before the permission check', async () => {
    const off = hrCaller(db, { grants: [...PAYROLL, 'employees:self'], env: { STORAGE: bucket } });
    for (const path of ['/payroll/overview', '/payroll/employers', '/payroll/runs', '/payroll/filings', '/me/payslips', '/me/payroll-details']) {
      const res = await off.get(path);
      expect(res.status, path).toBe(404);
    }
    const noGrant = hrCaller(db, { grants: ['employees:read'], env: { STORAGE: bucket } });
    expect((await noGrant.get('/payroll/employers')).status).toBe(404);
  });

  it('refuses a payroll path without its permission when the flag is on', async () => {
    expect((await as(['payroll:read']).send('POST', '/payroll/employers', NL_EMPLOYER)).status).toBe(403);
    expect((await as(['payroll:manage']).get('/payroll/employers')).status).toBe(403);
    expect((await as(['employees:read']).get('/me/payroll-details')).status).toBe(403);
  });
});

describe('employers', () => {
  it('creates, lists, reads, updates and deletes employers, refusing invalid input', async () => {
    const invalid = await admin().send('POST', '/payroll/employers', { name: '', legalName: 'X', country: 'BE' });
    expect(invalid.status).toBe(400);
    const badLhn = await admin().send('POST', '/payroll/employers', { ...NL_EMPLOYER, nlSettings: { loonheffingennummer: 'nope' } });
    expect(badLhn.status).toBe(400);

    const created = await admin().send('POST', '/payroll/employers', NL_EMPLOYER);
    expect(created.status).toBe(201);
    const employer = await data<{ id: string; currency: string; issues: unknown[] }>(created);
    expect(employer.currency).toBe('EUR');

    const us = await data<{ id: string }>(
      await admin().send('POST', '/payroll/employers', {
        name: 'Acme Inc',
        legalName: 'Acme Inc.',
        country: 'US',
        usSettings: { ein: '12-3456789', depositSchedule: 'monthly', states: { CA: { suiRates: { '2026': 3.4 } } } },
      }),
    );

    const list = await data<Array<{ id: string; name: string }>>(await admin().get('/payroll/employers'));
    expect(list.map((e) => e.name)).toEqual(['Acme BV', 'Acme Inc']);
    expect((await admin().get(`/payroll/employers/${employer.id}`)).status).toBe(200);
    expect((await admin().get('/payroll/employers/hrpe_missing')).status).toBe(404);

    const updated = await admin().send('PATCH', `/payroll/employers/${employer.id}`, { name: 'Acme Nederland', requireSeparateApprover: true });
    expect(updated.status).toBe(200);
    expect((await data<{ name: string }>(updated)).name).toBe('Acme Nederland');

    const bank = await admin().send('PUT', `/payroll/employers/${employer.id}/bank`, { accountHolder: 'Acme B.V.', iban: 'NL91ABNA0417164300', bic: 'ABNANL2A' });
    expect(bank.status).toBe(200);
    const again = await admin().send('PUT', `/payroll/employers/${employer.id}/bank`, { accountHolder: 'Acme B.V.', iban: 'NL91ABNA0417164300', bic: 'ABNANL2A' });
    expect(again.status).toBe(200);
    const badIban = await admin().send('PUT', `/payroll/employers/${employer.id}/bank`, { iban: 'NL00XXXX0000000000' });
    expect(badIban.status).toBe(400);
    const usBank = await admin().send('PUT', `/payroll/employers/${us.id}/bank`, {
      routingNumber: '021000021',
      accountNumber: '123456789',
      accountType: 'checking',
      nachaCompanyId: '1234567890',
      bankName: 'Chase',
    });
    expect(usBank.status).toBe(200);

    expect((await admin().send('DELETE', `/payroll/employers/${us.id}`)).status).toBe(204);
    expect((await admin().send('DELETE', `/payroll/employers/${us.id}`)).status).toBe(404);
  });
});

describe('pay schedules', () => {
  it('creates, lists, updates and deletes schedules with their next period', async () => {
    const employer = await data<{ id: string }>(await admin().send('POST', '/payroll/employers', NL_EMPLOYER));
    const weekly = await admin().send('POST', '/payroll/schedules', {
      employerId: employer.id,
      name: 'Weekly',
      frequency: 'weekly',
      anchorDate: '2026-01-05',
      payDateRule: { kind: 'offset_after_end', days: 3 },
    });
    expect(weekly.status).toBe(400);
    const created = await admin().send('POST', '/payroll/schedules', {
      employerId: employer.id,
      name: 'Monthly',
      frequency: 'monthly',
      anchorDate: '2026-01-01',
      payDateRule: { kind: 'day_of_month', day: 25 },
    });
    expect(created.status).toBe(201);
    const schedule = await data<{ id: string; nextPeriod: { start: string } }>(created);
    expect(schedule.nextPeriod.start).toBe('2026-01-01');
    expect((await data<unknown[]>(await admin().get(`/payroll/schedules?employerId=${employer.id}`))).length).toBe(1);
    expect((await data<unknown[]>(await admin().get('/payroll/schedules'))).length).toBe(1);
    const renamed = await admin().send('PATCH', `/payroll/schedules/${schedule.id}`, { name: 'Maandelijks', payDateRule: { kind: 'last_business_day' } });
    expect(renamed.status).toBe(200);
    expect((await admin().send('DELETE', `/payroll/schedules/${schedule.id}`)).status).toBe(204);
    expect((await admin().send('PATCH', `/payroll/schedules/${schedule.id}`, { name: 'x' })).status).toBe(404);
  });
});

describe('employees on payroll', () => {
  it('puts employees on payroll and keeps their setup', async () => {
    const { employerId, scheduleId } = await nlEmployer();
    const before = await data<Array<{ employeeId: string; profile: unknown }>>(await admin().get('/payroll/employees'));
    expect(before.map((e) => e.employeeId)).toEqual(['hremp_eva', 'hremp_hans', 'hremp_lee']);

    expect((await admin().send('PUT', '/payroll/employees/hremp_eva/profile', { employerId: 'hrpe_missing' })).status).toBe(404);
    const profile = await admin().send('PUT', '/payroll/employees/hremp_eva/profile', {
      employerId,
      payScheduleId: scheduleId,
      startDate: '2026-01-01',
      nl: { writtenContract: true, indefiniteContract: true, initials: 'E.', nationality: 'NL', gender: 2 },
    });
    expect(profile.status).toBe(200);
    expect((await data<{ nl: { incomeRelationshipNumber: number } }>(profile)).nl.incomeRelationshipNumber).toBe(1);
    const hans = await admin().send('PUT', '/payroll/employees/hremp_hans/profile', { employerId, payScheduleId: scheduleId, startDate: '2026-01-01', nl: { incomeRelationshipNumber: 1 } });
    expect(hans.status).toBe(409);
    expect(
      (await admin().send('PUT', '/payroll/employees/hremp_hans/profile', { employerId, payScheduleId: scheduleId, startDate: '2026-01-01' })).status,
    ).toBe(200);

    // Payment details: validated, masked, audited.
    expect((await admin().send('PUT', '/payroll/employees/hremp_eva/payment-details', { nationalId: '123456789' })).status).toBe(400);
    const details = await admin().send('PUT', '/payroll/employees/hremp_eva/payment-details', {
      nationalId: '111222333',
      dateOfBirth: '1990-05-17',
      bankIban: 'NL02ABNA0123456789',
      bankAccountHolder: 'E. Alder',
      idVerifiedAt: '2026-01-02',
      homeAddress: { line1: 'Kerkstraat', houseNumber: '5', postalCode: '1000 AA', city: 'Amsterdam', country: 'NL' },
    });
    expect(details.status).toBe(200);
    expect(await data(details)).toMatchObject({ hasNationalId: true, nationalIdMasked: '•••••2333' });
    // The same details again change nothing.
    expect(
      (await admin().send('PUT', '/payroll/employees/hremp_eva/payment-details', { nationalId: '111222333', bankIban: 'NL02ABNA0123456789' })).status,
    ).toBe(200);

    // Compensation.
    expect(
      (await admin().send('POST', '/payroll/employees/hremp_eva/compensations', { effectiveFrom: '2026-01-01', payType: 'hourly', amount: 20, period: 'month' })).status,
    ).toBe(400);
    const first = await admin().send('POST', '/payroll/employees/hremp_eva/compensations', { effectiveFrom: '2026-01-01', payType: 'salary', amount: 3000, period: 'month' });
    expect(first.status).toBe(201);
    const raise = await admin().send('POST', '/payroll/employees/hremp_eva/compensations', {
      effectiveFrom: '2026-06-01',
      payType: 'salary',
      amount: 3250.5,
      period: 'month',
      reason: 'Raise',
    });
    expect(raise.status).toBe(201);
    expect((await admin().send('POST', '/payroll/employees/hremp_eva/compensations', { effectiveFrom: '2026-03-01', payType: 'salary', amount: 1, period: 'month' })).status).toBe(400);
    const raiseId = (await data<{ id: string }>(raise)).id;
    expect((await admin().send('DELETE', `/payroll/compensations/${(await data<{ id: string }>(first)).id}`)).status).toBe(409);
    expect((await admin().send('DELETE', `/payroll/compensations/${raiseId}`)).status).toBe(204);

    // Components.
    expect((await admin().send('POST', '/payroll/employees/hremp_lee/components', { code: 'allowance.taxable', amount: 50, effectiveFrom: '2026-01-01' })).status).toBe(400);
    expect((await admin().send('POST', '/payroll/employees/hremp_eva/components', { code: 'nope', amount: 50, effectiveFrom: '2026-01-01' })).status).toBe(400);
    expect((await admin().send('POST', '/payroll/employees/hremp_eva/components', { code: 'nl.company_car', effectiveFrom: '2026-01-01' })).status).toBe(400);
    const travel = await admin().send('POST', '/payroll/employees/hremp_eva/components', {
      code: 'nl.travel_allowance',
      label: 'Woon-werk',
      params: { km_per_day: 20, days_per_month: 16 },
      effectiveFrom: '2026-01-01',
    });
    expect(travel.status).toBe(201);
    const component = await data<{ id: string }>(travel);
    const pension = await admin().send('POST', '/payroll/employees/hremp_eva/components', {
      code: 'nl.pension_employee',
      params: { percent: 5, franchise_per_year: 17545 },
      effectiveFrom: '2026-01-01',
      effectiveTo: '2026-12-31',
    });
    expect(pension.status).toBe(201);
    expect((await admin().send('PATCH', `/payroll/components/${component.id}`, { label: 'Reiskosten', params: { km_per_day: 25, days_per_month: 16 } })).status).toBe(200);
    expect((await admin().send('PATCH', `/payroll/components/${component.id}`, { effectiveTo: '2025-01-01' })).status).toBe(400);
    expect((await admin().send('DELETE', `/payroll/components/${(await data<{ id: string }>(pension)).id}`)).status).toBe(204);
    expect((await admin().send('DELETE', '/payroll/components/hrpc_missing')).status).toBe(404);

    // Tax elections.
    expect(
      (
        await admin().send('POST', '/payroll/employees/hremp_eva/tax-elections', {
          kind: 'us_w4',
          effectiveFrom: '2026-01-01',
          data: { formYear: 2026, filingStatus: 'single', multipleJobs: false, dependentsAmount: 0, otherIncome: 0, deductions: 0, extraWithholding: 0, exempt: false },
          signatureName: 'Eva',
        })
      ).status,
    ).toBe(400);
    const election = await admin().send('POST', '/payroll/employees/hremp_eva/tax-elections', {
      kind: 'nl_loonheffingskorting',
      effectiveFrom: '2026-01-01',
      data: { applyCredit: true },
      signatureName: 'Eva Alder',
    });
    expect(election.status).toBe(201);
    expect((await data<unknown[]>(await admin().get('/payroll/employees/hremp_eva/tax-elections'))).length).toBe(1);

    const detail = await data<{ issues: unknown[]; compensations: unknown[] }>(await admin().get('/payroll/employees/hremp_eva'));
    expect(detail.compensations).toHaveLength(1);
    expect((await admin().get('/payroll/employees/hremp_missing')).status).toBe(404);
    const onPayroll = await data<Array<{ employeeId: string; issues: unknown[] }>>(await admin().get('/payroll/employees?onPayroll=true'));
    expect(onPayroll.map((e) => e.employeeId)).toEqual(['hremp_eva', 'hremp_hans']);
    expect((await data<unknown[]>(await admin().get(`/payroll/employees?onPayroll=false&employerId=${employerId}`))).length).toBe(0);
    expect((await admin().get('/payroll/employees?onPayroll=maybe')).status).toBe(400);

    // Nothing paid yet.
    expect(await data(await admin().get('/payroll/employees/hremp_eva/payslips'))).toEqual([]);
    expect(await data(await admin().get('/payroll/employees/hremp_eva/annual-statements'))).toEqual([]);
    expect((await admin().get('/payroll/employees/hremp_eva/annual-statements/2026')).status).toBe(400);
    expect((await admin().get(`/payroll/employees/hremp_eva/annual-statements/2026?employerId=${employerId}`)).status).toBe(404);
    expect((await admin().get('/payroll/employees/hremp_missing/payslips')).status).toBe(404);

    const overview = await admin().get('/payroll/overview');
    expect(overview.status).toBe(200);
    expect((await data<{ setup: unknown }>(overview)).setup).toMatchObject({ hasEmployer: true, hasSchedule: true, employeesOnPayroll: 2 });
  });

  it('puts a US employee on payroll with a W-4 and a state certificate', async () => {
    const employer = await data<{ id: string }>(
      await admin().send('POST', '/payroll/employers', {
        name: 'Acme Inc',
        legalName: 'Acme Inc.',
        country: 'US',
        address: { line1: '1 Main St', city: 'Sacramento', region: 'CA', postalCode: '95814', country: 'US' },
        usSettings: { ein: '12-3456789', depositSchedule: 'monthly', states: { CA: { suiRates: { '2026': 3.4 } } } },
      }),
    );
    const schedule = await data<{ id: string }>(
      await admin().send('POST', '/payroll/schedules', {
        employerId: employer.id,
        name: 'Biweekly',
        frequency: 'biweekly',
        anchorDate: '2026-01-02',
        payDateRule: { kind: 'offset_after_end', days: 5 },
      }),
    );
    expect(
      (
        await admin().send('PUT', '/payroll/employees/hremp_lee/profile', {
          employerId: employer.id,
          payScheduleId: schedule.id,
          startDate: '2026-01-01',
          us: { workState: 'CA', residenceState: 'CA', flsaStatus: 'nonexempt' },
        })
      ).status,
    ).toBe(200);
    expect((await admin().send('PUT', '/payroll/employees/hremp_lee/payment-details', { nationalId: '123-45-678' })).status).toBe(400);
    const details = await admin().send('PUT', '/payroll/employees/hremp_lee/payment-details', {
      nationalId: '123-45-6789',
      bankRoutingNumber: '021000021',
      bankAccountNumber: '987654321',
      bankAccountType: 'checking',
      homeAddress: { line1: '2 Oak Ave', city: 'Sacramento', region: 'CA', postalCode: '95816', country: 'US' },
    });
    expect(details.status).toBe(200);
    expect((await admin().send('PUT', '/payroll/employees/hremp_lee/payment-details', { bankRoutingNumber: '021000022' })).status).toBe(400);
    expect((await admin().send('POST', '/payroll/employees/hremp_lee/compensations', { effectiveFrom: '2026-01-01', payType: 'hourly', amount: 25, period: 'hour' })).status).toBe(201);
    const w4 = await admin().send('POST', '/payroll/employees/hremp_lee/tax-elections', {
      kind: 'us_w4',
      effectiveFrom: '2026-01-01',
      data: { formYear: 2026, filingStatus: 'single', multipleJobs: false, dependentsAmount: 0, otherIncome: 0, deductions: 0, extraWithholding: 0, exempt: false },
      signatureName: 'Lee Chen',
    });
    expect(w4.status).toBe(201);
    const de4 = await admin().send('POST', '/payroll/employees/hremp_lee/tax-elections', {
      kind: 'us_state_certificate',
      state: 'CA',
      effectiveFrom: '2026-01-01',
      data: { filingStatus: 'single', allowances: 1 },
      signatureName: 'Lee Chen',
    });
    expect(de4.status).toBe(201);
    expect(
      (
        await admin().send('POST', '/payroll/employees/hremp_lee/tax-elections', {
          kind: 'us_state_certificate',
          state: 'TX',
          effectiveFrom: '2026-01-01',
          data: {},
          signatureName: 'Lee Chen',
        })
      ).status,
    ).toBe(400);
    expect((await admin().send('POST', '/payroll/employees/hremp_lee/components', { code: 'us.401k', params: { percent: 5 }, effectiveFrom: '2026-01-01' })).status).toBe(201);
    const detail = await data<{ issues: unknown[] }>(await admin().get('/payroll/employees/hremp_lee'));
    expect(detail.issues).toEqual([]);
    expect((await data<unknown[]>(await admin().get(`/payroll/employees?employerId=${employer.id}`))).length).toBe(1);
  });
});

describe('My HR payroll', () => {
  it('shows the employee their details, lets them change them and sign elections', async () => {
    // Not on payroll yet: nothing required.
    const empty = await eva().get('/me/payroll-details');
    expect(empty.status).toBe(200);
    expect(await data(empty)).toMatchObject({ country: null, requiredElections: [], missing: [] });

    const { employerId, scheduleId } = await nlEmployer();
    await admin().send('PUT', '/payroll/employees/hremp_eva/profile', { employerId, payScheduleId: scheduleId, startDate: '2026-01-01' });
    const required = await data<{ requiredElections: unknown[]; missing: string[] }>(await eva().get('/me/payroll-details'));
    expect(required.missing).toEqual(['nationalId', 'dateOfBirth', 'bankIban', 'idDocument']);

    expect((await eva().send('PUT', '/me/payroll-details', { bankIban: 'NL00' })).status).toBe(400);
    expect((await eva().send('PUT', '/me/payroll-details', { dateOfBirth: 'yesterday' })).status).toBe(400);
    const updated = await eva().send('PUT', '/me/payroll-details', {
      nationalId: '111222333',
      dateOfBirth: '1990-05-17',
      bankIban: 'NL02ABNA0123456789',
      idDocumentType: 'passport',
      idDocumentNumber: 'XR1234567',
      idDocumentExpiresOn: '2030-01-01',
      idVerifiedAt: '2026-01-02',
    });
    expect(updated.status).toBe(200);
    expect((await data<{ missing: string[] }>(updated)).missing).toEqual([]);

    // HR verifies the ID; an identity change by the employee clears it.
    await admin().send('PUT', '/payroll/employees/hremp_eva/payment-details', { idVerifiedAt: '2026-01-03' });
    const changed = await eva().send('PUT', '/me/payroll-details', { dateOfBirth: '1990-05-18' });
    expect((await data<{ paymentDetails: { idVerifiedAt: unknown } }>(changed)).paymentDetails.idVerifiedAt).toBeNull();

    const far = await eva().send('POST', '/me/tax-elections', { kind: 'nl_loonheffingskorting', effectiveFrom: '2099-01-01', data: { applyCredit: true }, signatureName: 'Eva' });
    expect(far.status).toBe(400);
    const signed = await eva().send('POST', '/me/tax-elections', { kind: 'nl_loonheffingskorting', effectiveFrom: '2026-01-01', data: { applyCredit: false }, signatureName: 'Eva Alder' });
    expect(signed.status).toBe(201);
    expect((await data<{ elections: unknown[] }>(signed)).elections).toHaveLength(1);

    expect(await data(await eva().get('/me/payslips'))).toEqual([]);
    expect(await data(await eva().get('/me/annual-statements'))).toEqual([]);
    expect((await eva().get('/me/annual-statements/abc')).status).toBe(400);
    expect((await eva().get('/me/annual-statements/2026')).status).toBe(404);
    expect((await eva().get('/me/payslips/hrps_missing/pdf')).status).toBe(404);

    // Someone without an employee record.
    const stranger = hrCaller(db, { grants: ['employees:self'], userId: 'user_nobody', flags: FLAGS, env: { STORAGE: bucket } });
    expect((await errorOf(await stranger.get('/me/payroll-details'))).code).toBe('NOT_FOUND');
  });
});
