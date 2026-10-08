import { describe, expect, it } from 'vitest';
import { en } from '@weldsuite/i18n/locales/en';
import type { SalesTaxAgency } from '@/lib/api/domains/weldbooks-sales-tax-setup';
import { getSalesTaxState } from '@/lib/weldbooks/us-sales-tax-states';
import {
  agencyNameFor,
  agencyToEditValues,
  cashBasisAvailable,
  emptyAgencyForm,
  makeAgencyEditSchema,
  makeAgencySchema,
  stateHasLocalAgencies,
  statusTargets,
  toCreateAgencyInput,
  toUpdateAgencyInput,
  withLocal,
  withStateDefaults,
  type AgencyFormValues,
} from './agency-model';

const texts = en.weldbooksUs.salesTax.setup.validation;
const schema = makeAgencySchema(texts);

function texas(overrides: Partial<AgencyFormValues> = {}): AgencyFormValues {
  return { ...emptyAgencyForm('TX'), registeredFrom: '2026-01-01', ...overrides };
}

function issues(values: AgencyFormValues): Record<string, string> {
  const result = schema.safeParse(values);
  if (result.success) return {};
  return Object.fromEntries(result.error.issues.map((i) => [String(i.path[0]), i.message]));
}

describe('state defaults', () => {
  it('fills the due day, SST membership and portal from the state', () => {
    expect(emptyAgencyForm('WA')).toMatchObject({ stateCode: 'WA', dueDay: '25', sstMember: true, portalUrl: 'https://secure.dor.wa.gov' });
    expect(emptyAgencyForm('CA').dueDay).toBe('31');
    expect(emptyAgencyForm('TX')).toMatchObject({
      dueDay: '20',
      sstMember: false,
      portalUrl: 'https://comptroller.texas.gov/taxes/sales',
    });
  });

  it('keeps what the user typed when the state changes, but not a cash basis the new state forbids', () => {
    const typed: AgencyFormValues = { ...emptyAgencyForm('WA'), registrationNumber: '602-123', reportingBasis: 'cash', notes: 'hello' };
    expect(withStateDefaults(typed, 'TX')).toMatchObject({ registrationNumber: '602-123', notes: 'hello', reportingBasis: 'accrual' });
    expect(withStateDefaults(typed, 'AZ').reportingBasis).toBe('cash');
  });

  it('leaves an unknown state code as typed', () => {
    expect(withStateDefaults(emptyAgencyForm(), 'ZZ').stateCode).toBe('ZZ');
  });
});

describe('cash basis availability', () => {
  it('is offered only where the state allows it', () => {
    expect(cashBasisAvailable(getSalesTaxState('WA'), false)).toBe(true);
    expect(cashBasisAvailable(getSalesTaxState('TX'), false)).toBe(false);
    expect(cashBasisAvailable(undefined, false)).toBe(false);
  });

  it('is offered to a local agency in any state', () => {
    expect(cashBasisAvailable(getSalesTaxState('CO'), true)).toBe(true);
  });

  it('is turned off when the form goes back to a state-level agency in a state that forbids it', () => {
    const local = withLocal(emptyAgencyForm('CO'), true);
    const cash = { ...local, reportingBasis: 'cash' as const };
    expect(withLocal(cash, false).reportingBasis).toBe('accrual');
    expect(withLocal(cash, true).reportingBasis).toBe('cash');
  });

  it('is refused by the schema for a state that requires accrual', () => {
    expect(issues(texas({ reportingBasis: 'cash' })).reportingBasis).toBe('Texas requires the accrual basis.');
    expect(issues(texas({ reportingBasis: 'accrual' })).reportingBasis).toBeUndefined();
  });

  it('is never sent to a state that does not allow it', () => {
    expect(toCreateAgencyInput(texas({ reportingBasis: 'cash' })).reportingBasis).toBe('accrual');
    expect(
      toCreateAgencyInput({ ...emptyAgencyForm('WA'), registeredFrom: '2026-01-01', reportingBasis: 'cash' }).reportingBasis,
    ).toBe('cash');
  });
});

describe('registeredFrom', () => {
  it('is required for a registered agency', () => {
    expect(issues(texas({ registeredFrom: '' })).registeredFrom).toBe(texts.registeredFromRequired);
    expect(issues(texas({ registeredFrom: '2026-01-01' })).registeredFrom).toBeUndefined();
  });

  it('is required for a pending registration too', () => {
    expect(issues(texas({ status: 'pending', registeredFrom: '' })).registeredFrom).toBe(texts.registeredFromRequired);
  });

  it('is not needed to monitor a state', () => {
    expect(issues(texas({ status: 'monitoring', registeredFrom: '' }))).toEqual({});
  });

  it('must be a date', () => {
    expect(issues(texas({ registeredFrom: '01/01/2026' })).registeredFrom).toBe(texts.date);
  });
});

describe('create payload', () => {
  it('sends the registration with the state, level and the date it starts', () => {
    expect(
      toCreateAgencyInput(texas({ registrationNumber: ' 32-1234567 ', filingFrequency: 'monthly', notes: ' via accountant ' })),
    ).toEqual({
      stateCode: 'TX',
      level: 'state',
      status: 'registered',
      filingFrequency: 'monthly',
      dueDay: 20,
      reportingBasis: 'accrual',
      sstMember: false,
      registrationNumber: '32-1234567',
      registeredFrom: '2026-01-01',
      portalUrl: 'https://comptroller.texas.gov/taxes/sales',
      notes: 'via accountant',
    });
  });

  it('leaves blanks out so the server fills in its defaults', () => {
    const input = toCreateAgencyInput({ ...texas(), portalUrl: '', registrationNumber: '', notes: '', firstPeriodStart: '' });
    expect(input).not.toHaveProperty('name');
    expect(input).not.toHaveProperty('registrationNumber');
    expect(input).not.toHaveProperty('firstPeriodStart');
    expect(input).not.toHaveProperty('portalUrl');
    expect(input).not.toHaveProperty('notes');
    expect(input).not.toHaveProperty('localJurisdictionCode');
  });

  it('sends a typed agency name and first period', () => {
    expect(toCreateAgencyInput(texas({ name: ' Texas Comptroller ', firstPeriodStart: '2026-01-01' }))).toMatchObject({
      name: 'Texas Comptroller',
      firstPeriodStart: '2026-01-01',
    });
  });

  it('turns the last-day due day into 31', () => {
    expect(toCreateAgencyInput({ ...emptyAgencyForm('CA'), registeredFrom: '2026-01-01' }).dueDay).toBe(31);
  });

  it('sends a local agency with its code and name', () => {
    const local = withLocal(
      { ...emptyAgencyForm('CO'), registeredFrom: '2026-01-01', name: 'City of Denver', localJurisdictionCode: '0820000' },
      true,
    );
    expect(stateHasLocalAgencies(getSalesTaxState('CO'))).toBe(true);
    expect(toCreateAgencyInput(local)).toMatchObject({ level: 'local', localJurisdictionCode: '0820000', name: 'City of Denver' });
  });
});

describe('validation', () => {
  it('needs a state and a due day of the month', () => {
    expect(issues({ ...emptyAgencyForm(), registeredFrom: '2026-01-01' }).stateCode).toBe(texts.state);
    expect(issues(texas({ dueDay: '0' })).dueDay).toBe(texts.dueDay);
    expect(issues(texas({ dueDay: '32' })).dueDay).toBe(texts.dueDay);
    expect(issues(texas({ dueDay: '31' })).dueDay).toBeUndefined();
  });

  it('needs a full web address for the portal', () => {
    expect(issues(texas({ portalUrl: 'comptroller.texas.gov' })).portalUrl).toBe(texts.url);
    expect(issues(texas({ portalUrl: 'https://comptroller.texas.gov' })).portalUrl).toBeUndefined();
  });

  it('needs a name and a code for a local agency', () => {
    const local = withLocal({ ...emptyAgencyForm('CO'), registeredFrom: '2026-01-01' }, true);
    expect(issues(local)).toMatchObject({ name: texts.localName, localJurisdictionCode: texts.localCode });
  });

  it('names a blank agency after the state', () => {
    expect(agencyNameFor(texas())).toBe('Texas Comptroller of Public Accounts');
    expect(agencyNameFor(texas({ name: 'My agency' }))).toBe('My agency');
  });
});

describe('editing a registration', () => {
  const agency: SalesTaxAgency = {
    id: 'sta_1',
    entityId: 'ent_1',
    stateCode: 'WA',
    level: 'state',
    localJurisdictionCode: null,
    name: 'Washington State Department of Revenue',
    registrationNumber: null,
    registeredFrom: '2026-01-01',
    registeredUntil: null,
    status: 'registered',
    filingFrequency: 'quarterly',
    firstPeriodStart: null,
    dueDay: 25,
    reportingBasis: 'accrual',
    sstMember: true,
    liabilityAccountId: null,
    useTaxAccountId: null,
    portalUrl: null,
    providerRegistrationRef: null,
    notes: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    liabilityAccount: null,
    useTaxAccount: null,
  };
  const editSchema = makeAgencyEditSchema(texts, agency);

  it('turns what is saved into form values and back, with blanks as null', () => {
    const values = agencyToEditValues(agency);
    expect(values).toMatchObject({ registrationNumber: '', registeredFrom: '2026-01-01', dueDay: '25' });
    expect(toUpdateAgencyInput({ ...values, registrationNumber: ' 602-1 ', registeredUntil: '' })).toEqual({
      name: 'Washington State Department of Revenue',
      registrationNumber: '602-1',
      registeredFrom: '2026-01-01',
      registeredUntil: null,
      filingFrequency: 'quarterly',
      firstPeriodStart: null,
      dueDay: 25,
      reportingBasis: 'accrual',
      sstMember: true,
      portalUrl: null,
      notes: null,
    });
  });

  it('still needs the start date of a registered agency', () => {
    expect(editSchema.safeParse({ ...agencyToEditValues(agency), registeredFrom: '' }).success).toBe(false);
  });

  it('refuses an end date before the start date', () => {
    expect(editSchema.safeParse({ ...agencyToEditValues(agency), registeredUntil: '2025-12-31' }).success).toBe(false);
  });

  it('offers every other status', () => {
    expect(statusTargets('registered')).toEqual(['pending', 'monitoring', 'closed']);
    expect(statusTargets('closed')).toEqual(['registered', 'pending', 'monitoring']);
  });
});
