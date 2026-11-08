/**
 * The payroll forms end to end in jsdom: fill them in, submit, and check the
 * request they would send. Data hooks are mocked; the forms, their zod schemas
 * and the field components are the real ones.
 */

import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { I18nProvider } from '@weldsuite/i18n/provider';
import { en } from '@weldsuite/i18n/locales/en';
import type { HrPayrollEmployer } from '@weldsuite/app-api-client/domains/weldhr-payroll';
import { STATE_CERTIFICATE_LABELS } from '@weldsuite/payroll-domain/us/states/certificate-labels';
import { polyfillRadixSelect } from '@/app/weldbooks/invoices/components/test-utils';
import { EmployerDialog } from './employer-dialog';
import { ScheduleDialog } from './schedule-dialog';
import { TaxElectionDialog } from './tax-election-dialog';
import { EmployerBankDialog } from './employer-bank-dialog';

const t = en.weldhr.payroll;

const mocks = vi.hoisted(() => ({
  createEmployer: vi.fn(),
  updateEmployer: vi.fn(),
  createSchedule: vi.fn(),
  updateSchedule: vi.fn(),
  setBank: vi.fn(),
  saveAccount: vi.fn(),
}));

const fixtures = vi.hoisted(() => ({
  legalEntities: [{ id: 'ent_1', name: 'Acme BV', jurisdictionCode: 'NL', baseCurrency: 'EUR', isActive: true }],
  registrations: [{ id: 'reg_1', type: 'nl_payroll_tax', number: '123456789L01', label: null }],
  bankAccounts: [{ id: 'bank_1', name: 'Salary', iban: null, accountNumberLast4: null, isActive: true }],
}));

vi.mock('@/lib/router', () => ({ useRouter: () => ({ push: vi.fn() }) }));

vi.mock('@/hooks/queries/use-weldhr-payroll-queries', () => ({
  useCreateHrPayrollEmployer: () => ({ mutateAsync: mocks.createEmployer, isPending: false }),
  useUpdateHrPayrollEmployer: () => ({ mutateAsync: mocks.updateEmployer, isPending: false }),
  useSetHrPayrollEmployerBank: () => ({ mutateAsync: mocks.setBank, isPending: false }),
  useCreateHrPaySchedule: () => ({ mutateAsync: mocks.createSchedule, isPending: false }),
  useUpdateHrPaySchedule: () => ({ mutateAsync: mocks.updateSchedule, isPending: false }),
}));

vi.mock('@/hooks/queries/use-legal-entities-queries', () => ({
  useLegalEntities: () => ({ data: fixtures.legalEntities, isLoading: false }),
  useLegalEntityRegistrations: (id: string | null | undefined) => ({ data: id ? fixtures.registrations : undefined }),
  useLegalEntityBankAccounts: (id: string | null | undefined) => ({ data: id ? fixtures.bankAccounts : undefined }),
  useSaveBankAccount: () => ({ mutateAsync: mocks.saveAccount, isPending: false }),
}));

function renderInProvider(ui: React.ReactElement) {
  return render(<I18nProvider initialLanguage="en">{ui}</I18nProvider>);
}

const employer: HrPayrollEmployer = {
  id: 'emp_1',
  legalEntityId: 'ent_1',
  legalEntityName: 'Acme BV',
  registrationId: 'reg_1',
  registrationNumber: '123456789L01',
  bankAccountId: null,
  label: null,
  booksEnabled: true,
  name: 'Acme',
  legalName: 'Acme BV',
  country: 'NL',
  currency: 'EUR',
  accountingEntityId: null,
  accountingEntityName: null,
  address: {},
  nlSettings: {},
  usSettings: {},
  requireSeparateApprover: false,
  isActive: true,
  bank: null,
  employeeCount: 0,
  issues: [],
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
};

beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset().mockResolvedValue(undefined);
});

describe('EmployerDialog', () => {
  beforeAll(polyfillRadixSelect);

  async function pickEntity(user: ReturnType<typeof userEvent.setup>) {
    await user.click(screen.getByLabelText(t.settings.employers.legalEntity));
    await user.click(await screen.findByRole('option', { name: /Acme BV/ }));
  }

  it('asks for the legal entity, not for name, country, currency or address', () => {
    renderInProvider(<EmployerDialog onClose={vi.fn()} />);

    expect(screen.getByLabelText(t.settings.employers.legalEntity)).toBeTruthy();
    expect(screen.queryByLabelText(t.settings.employers.name)).toBeNull();
    expect(screen.queryByLabelText(t.settings.employers.legalName)).toBeNull();
    expect(screen.queryByLabelText(en.weldhr.payroll.common.country)).toBeNull();
    expect(screen.queryByLabelText(t.settings.employers.street)).toBeNull();
  });

  it('creates a Dutch employer from a legal entity with a new loonheffingennummer', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    renderInProvider(<EmployerDialog onClose={onClose} />);

    await pickEntity(user);
    await user.type(screen.getByLabelText(t.settings.employers.registrationNumber), '123456789l02');
    await user.click(screen.getByRole('button', { name: en.weldhr.common.save }));

    await waitFor(() => expect(mocks.createEmployer).toHaveBeenCalledTimes(1));
    const payload = mocks.createEmployer.mock.calls[0][0];
    expect(payload).toMatchObject({ legalEntityId: 'ent_1', registrationNumber: '123456789L02', country: 'NL' });
    expect(payload).not.toHaveProperty('name');
    expect(payload).not.toHaveProperty('address');
    expect(onClose).toHaveBeenCalled();
  });

  it('links an existing registration of the entity instead of a typed number', async () => {
    const user = userEvent.setup();
    renderInProvider(<EmployerDialog onClose={vi.fn()} />);

    await pickEntity(user);
    await user.click(screen.getByLabelText(t.settings.employers.loonheffingennummer));
    await user.click(await screen.findByRole('option', { name: /123456789L01/ }));
    await user.click(screen.getByRole('button', { name: en.weldhr.common.save }));

    await waitFor(() => expect(mocks.createEmployer).toHaveBeenCalledTimes(1));
    const payload = mocks.createEmployer.mock.calls[0][0];
    expect(payload).toMatchObject({ legalEntityId: 'ent_1', registrationId: 'reg_1' });
    expect(payload).not.toHaveProperty('registrationNumber');
  });

  it('does not submit an invalid loonheffingennummer and shows the problem', async () => {
    const user = userEvent.setup();
    renderInProvider(<EmployerDialog onClose={vi.fn()} />);

    await pickEntity(user);
    await user.type(screen.getByLabelText(t.settings.employers.registrationNumber), '12345');
    await user.click(screen.getByRole('button', { name: en.weldhr.common.save }));

    expect(await screen.findByText(/looks like 123456789L01/)).toBeTruthy();
    expect(mocks.createEmployer).not.toHaveBeenCalled();
  });

  it('does not create an employer without a legal entity', async () => {
    const user = userEvent.setup();
    renderInProvider(<EmployerDialog onClose={vi.fn()} />);

    await user.click(screen.getByRole('button', { name: en.weldhr.common.save }));

    expect(await screen.findByText(t.settings.employers.legalEntityRequired)).toBeTruthy();
    expect(mocks.createEmployer).not.toHaveBeenCalled();
  });

  it('edits an employer without sending its country or its entity details', async () => {
    const user = userEvent.setup();
    renderInProvider(<EmployerDialog employer={employer} onClose={vi.fn()} />);

    expect(screen.getByTestId('employer-legal-entity-locked')).toHaveTextContent('Acme BV');
    await user.type(screen.getByLabelText(t.settings.employers.label), 'L01 DGA');
    await user.click(screen.getByRole('button', { name: en.weldhr.common.save }));

    await waitFor(() => expect(mocks.updateEmployer).toHaveBeenCalledTimes(1));
    const payload = mocks.updateEmployer.mock.calls[0][0];
    expect(payload).toMatchObject({ id: 'emp_1', legalEntityId: 'ent_1', registrationId: 'reg_1', label: 'L01 DGA' });
    expect(payload).not.toHaveProperty('country');
    expect(payload).not.toHaveProperty('name');
  });
});

describe('EmployerDialog rates per year', () => {
  it('keeps the Dutch rates per year as an object, not an array', async () => {
    const user = userEvent.setup();
    renderInProvider(<EmployerDialog employer={{ ...employer, nlSettings: { years: { '2026': { whkRate: 1.2 } } } }} onClose={vi.fn()} />);

    await user.click(screen.getByRole('button', { name: en.weldhr.common.save }));

    await waitFor(() => expect(mocks.updateEmployer).toHaveBeenCalledTimes(1));
    const years = mocks.updateEmployer.mock.calls[0][0].nlSettings.years;
    expect(Array.isArray(years)).toBe(false);
    expect(years['2026']).toMatchObject({ whkRate: 1.2 });
  });

  it('keeps the SUI rates of a state per year, and drops a cleared rate', async () => {
    const user = userEvent.setup();
    const usEmployer: HrPayrollEmployer = {
      ...employer,
      country: 'US',
      currency: 'USD',
      usSettings: { states: { CA: { suiRates: { '2026': 3.4, '2027': 3.4 } } } },
    };
    renderInProvider(<EmployerDialog employer={usEmployer} onClose={vi.fn()} />);

    await user.clear(screen.getByLabelText(t.settings.employers.suiRate.replace('{year}', '2027')));
    await user.click(screen.getByRole('button', { name: en.weldhr.common.save }));

    await waitFor(() => expect(mocks.updateEmployer).toHaveBeenCalledTimes(1));
    const rates = mocks.updateEmployer.mock.calls[0][0].usSettings.states.CA.suiRates;
    expect(Array.isArray(rates)).toBe(false);
    expect(rates).toEqual({ '2026': 3.4 });
  });

  it('shows what is wrong with a rate that is not a number', async () => {
    const user = userEvent.setup();
    const usEmployer: HrPayrollEmployer = { ...employer, country: 'US', currency: 'USD', usSettings: { states: { CA: {} } } };
    renderInProvider(<EmployerDialog employer={usEmployer} onClose={vi.fn()} />);

    await user.type(screen.getByLabelText(t.settings.employers.suiRate.replace('{year}', '2026')), 'abc');

    expect(screen.getByText(t.common.invalidNumber)).toBeTruthy();
  });
});

describe('ScheduleDialog', () => {
  it('creates a monthly schedule paid on the 25th by default', async () => {
    const user = userEvent.setup();
    renderInProvider(<ScheduleDialog employers={[employer]} onClose={vi.fn()} />);

    await user.type(screen.getByLabelText(t.settings.schedules.name), 'Monthly salaries');
    await user.click(screen.getByRole('button', { name: en.weldhr.common.save }));

    await waitFor(() => expect(mocks.createSchedule).toHaveBeenCalledTimes(1));
    expect(mocks.createSchedule.mock.calls[0][0]).toMatchObject({
      employerId: 'emp_1',
      name: 'Monthly salaries',
      frequency: 'monthly',
      payDateRule: { kind: 'day_of_month', day: 25 },
    });
  });
});

describe('TaxElectionDialog', () => {
  it('signs the Dutch loonheffingskorting with the typed name', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    renderInProvider(
      <TaxElectionDialog target={{ kind: 'nl_loonheffingskorting', state: null }} mode="self" defaultName="Anna de Vries" onSubmit={onSubmit} onClose={vi.fn()} />,
    );

    expect(screen.getByText(t.elections.nl.explanation)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: t.elections.sign }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit.mock.calls[0][0]).toMatchObject({
      kind: 'nl_loonheffingskorting',
      data: { applyCredit: true },
      signatureName: 'Anna de Vries',
    });
  });

  it('refuses a W-4 without a signature', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    renderInProvider(<TaxElectionDialog target={{ kind: 'us_w4', state: null }} mode="hr" defaultName="" onSubmit={onSubmit} onClose={vi.fn()} />);

    await user.click(screen.getByRole('button', { name: t.elections.record }));

    expect(await screen.findAllByText('Required')).not.toHaveLength(0);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('records a W-4 with the standard values', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    renderInProvider(<TaxElectionDialog target={{ kind: 'us_w4', state: null }} mode="hr" defaultName="Sam Smith" onSubmit={onSubmit} onClose={vi.fn()} />);

    await user.click(screen.getByRole('button', { name: t.elections.record }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit.mock.calls[0][0]).toMatchObject({
      kind: 'us_w4',
      signatureName: 'Sam Smith',
      data: { filingStatus: 'single', multipleJobs: false, dependentsAmount: 0, exempt: false },
    });
  });

  it('renders the fields of a state certificate from the state module', async () => {
    renderInProvider(
      <TaxElectionDialog target={{ kind: 'us_state_certificate', state: 'CA' }} mode="self" defaultName="Sam Smith" onSubmit={vi.fn()} onClose={vi.fn()} />,
    );

    // California has a certificate (DE 4); the form shows its name and every line of the form once,
    // with the DE 4's own labels (line 1a, line 2…), including the ones bound to the election itself.
    expect(screen.getByText(/DE 4/)).toBeTruthy();
    for (const key of ['allowances', 'estimated_deduction_allowances', 'extraWithholding']) {
      expect(screen.getAllByLabelText(STATE_CERTIFICATE_LABELS[`CA.${key}`]!.en)).toHaveLength(1);
    }
  });

  it('tells the employee that a state without a certificate needs none', () => {
    renderInProvider(
      <TaxElectionDialog target={{ kind: 'us_state_certificate', state: 'TX' }} mode="self" defaultName="Sam Smith" onSubmit={vi.fn()} onClose={vi.fn()} />,
    );

    expect(screen.getByText(t.elections.state.noCertificate.replace('{state}', 'TX'))).toBeTruthy();
  });
});

describe('EmployerBankDialog', () => {
  beforeAll(polyfillRadixSelect);

  async function chooseNewAccount(user: ReturnType<typeof userEvent.setup>) {
    await user.click(screen.getByLabelText(t.settings.bank.entityAccount));
    await user.click(await screen.findByRole('option', { name: t.settings.bank.addAccount }));
  }

  it('creates a new core account on the entity and links it, leaving the shared account alone', async () => {
    const user = userEvent.setup();
    mocks.saveAccount.mockResolvedValue({ id: 'bank_new' });
    const onClose = vi.fn();
    renderInProvider(<EmployerBankDialog employer={{ ...employer, bankAccountId: 'bank_1' }} onClose={onClose} />);

    await chooseNewAccount(user);
    const holder = screen.getByLabelText(t.settings.bank.accountHolder);
    await user.clear(holder);
    await user.type(holder, 'Acme Payroll');
    await user.type(screen.getByLabelText('IBAN'), 'NL91ABNA0417164300');
    await user.click(screen.getByRole('button', { name: en.weldhr.common.save }));

    await waitFor(() => expect(mocks.updateEmployer).toHaveBeenCalledWith({ id: 'emp_1', bankAccountId: 'bank_new' }));
    expect(mocks.saveAccount).toHaveBeenCalledWith({
      create: expect.objectContaining({ accountHolderName: 'Acme Payroll', iban: 'NL91ABNA0417164300' }),
    });
    expect(mocks.setBank).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });

  it('keeps the NACHA company id on the new core account', async () => {
    const user = userEvent.setup();
    mocks.saveAccount.mockResolvedValue({ id: 'bank_new' });
    renderInProvider(<EmployerBankDialog employer={{ ...employer, country: 'US', bankAccountId: 'bank_1' }} onClose={vi.fn()} />);

    await chooseNewAccount(user);
    await user.type(screen.getByLabelText(t.settings.bank.nachaCompanyId), '1234567890');
    await user.click(screen.getByRole('button', { name: en.weldhr.common.save }));

    await waitFor(() => expect(mocks.saveAccount).toHaveBeenCalled());
    expect(mocks.saveAccount.mock.calls[0][0].create.achSettings).toEqual({ companyIdentification: '1234567890' });
  });

  it('shows a failure inline and does not link when creating the account fails', async () => {
    const user = userEvent.setup();
    mocks.saveAccount.mockRejectedValue(new Error('IBAN rejected'));
    renderInProvider(<EmployerBankDialog employer={{ ...employer, bankAccountId: 'bank_1' }} onClose={vi.fn()} />);

    await chooseNewAccount(user);
    await user.click(screen.getByRole('button', { name: en.weldhr.common.save }));

    expect(await screen.findByText('IBAN rejected')).toBeTruthy();
    expect(mocks.updateEmployer).not.toHaveBeenCalled();
  });

  it('keeps the plain bank PUT for an employer without a legal entity', async () => {
    const user = userEvent.setup();
    renderInProvider(<EmployerBankDialog employer={{ ...employer, legalEntityId: null }} onClose={vi.fn()} />);

    await user.type(screen.getByLabelText(t.settings.bank.accountHolder), 'Acme');
    await user.click(screen.getByRole('button', { name: en.weldhr.common.save }));

    await waitFor(() => expect(mocks.setBank).toHaveBeenCalled());
    expect(mocks.saveAccount).not.toHaveBeenCalled();
  });
});
