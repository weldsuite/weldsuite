/**
 * The payroll forms end to end in jsdom: fill them in, submit, and check the
 * request they would send. Data hooks are mocked; the forms, their zod schemas
 * and the field components are the real ones.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { I18nProvider } from '@weldsuite/i18n/provider';
import { en } from '@weldsuite/i18n/locales/en';
import type { HrPayrollEmployer } from '@weldsuite/app-api-client/domains/weldhr-payroll';
import { EmployerDialog } from './employer-dialog';
import { ScheduleDialog } from './schedule-dialog';
import { TaxElectionDialog } from './tax-election-dialog';

const t = en.weldhr.payroll;

const mocks = vi.hoisted(() => ({
  createEmployer: vi.fn(),
  updateEmployer: vi.fn(),
  createSchedule: vi.fn(),
  updateSchedule: vi.fn(),
}));

vi.mock('@/hooks/queries/use-weldhr-payroll-queries', () => ({
  useCreateHrPayrollEmployer: () => ({ mutateAsync: mocks.createEmployer, isPending: false }),
  useUpdateHrPayrollEmployer: () => ({ mutateAsync: mocks.updateEmployer, isPending: false }),
  useCreateHrPaySchedule: () => ({ mutateAsync: mocks.createSchedule, isPending: false }),
  useUpdateHrPaySchedule: () => ({ mutateAsync: mocks.updateSchedule, isPending: false }),
}));

vi.mock('@/hooks/use-current-entity-currency', () => ({
  useAccountingEntities: () => ({ data: [{ id: 'ent_1', name: 'Acme BV', baseCurrency: 'EUR' }] }),
}));

function renderInProvider(ui: React.ReactElement) {
  return render(<I18nProvider initialLanguage="en">{ui}</I18nProvider>);
}

const employer: HrPayrollEmployer = {
  id: 'emp_1',
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
  it('creates a Dutch employer with its loonheffingennummer', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    renderInProvider(<EmployerDialog onClose={onClose} />);

    await user.type(screen.getByLabelText(t.settings.employers.name), 'Acme');
    await user.type(screen.getByLabelText(t.settings.employers.legalName), 'Acme BV');
    await user.type(screen.getByLabelText(t.settings.employers.loonheffingennummer), '123456789L01');
    await user.click(screen.getByRole('button', { name: en.weldhr.common.save }));

    await waitFor(() => expect(mocks.createEmployer).toHaveBeenCalledTimes(1));
    expect(mocks.createEmployer.mock.calls[0][0]).toMatchObject({
      name: 'Acme',
      legalName: 'Acme BV',
      country: 'NL',
      nlSettings: { loonheffingennummer: '123456789L01' },
    });
    expect(onClose).toHaveBeenCalled();
  });

  it('does not submit an invalid loonheffingennummer and shows the problem', async () => {
    const user = userEvent.setup();
    renderInProvider(<EmployerDialog onClose={vi.fn()} />);

    await user.type(screen.getByLabelText(t.settings.employers.name), 'Acme');
    await user.type(screen.getByLabelText(t.settings.employers.legalName), 'Acme BV');
    await user.type(screen.getByLabelText(t.settings.employers.loonheffingennummer), '12345');
    await user.click(screen.getByRole('button', { name: en.weldhr.common.save }));

    expect(await screen.findByText(/Expected a loonheffingennummer/)).toBeTruthy();
    expect(mocks.createEmployer).not.toHaveBeenCalled();
  });

  it('edits an employer without sending its country', async () => {
    const user = userEvent.setup();
    renderInProvider(<EmployerDialog employer={employer} onClose={vi.fn()} />);

    await user.clear(screen.getByLabelText(t.settings.employers.name));
    await user.type(screen.getByLabelText(t.settings.employers.name), 'Acme Holding');
    await user.click(screen.getByRole('button', { name: en.weldhr.common.save }));

    await waitFor(() => expect(mocks.updateEmployer).toHaveBeenCalledTimes(1));
    const payload = mocks.updateEmployer.mock.calls[0][0];
    expect(payload).toMatchObject({ id: 'emp_1', name: 'Acme Holding' });
    expect(payload).not.toHaveProperty('country');
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

    // California has a certificate (DE 4); the form shows its name and the certificate's own fields.
    expect(screen.getByText(/DE 4/)).toBeTruthy();
    expect(screen.getByLabelText(t.elections.state.extraWithholding)).toBeTruthy();
  });

  it('tells the employee that a state without a certificate needs none', () => {
    renderInProvider(
      <TaxElectionDialog target={{ kind: 'us_state_certificate', state: 'TX' }} mode="self" defaultName="Sam Smith" onSubmit={vi.fn()} onClose={vi.fn()} />,
    );

    expect(screen.getByText(t.elections.state.noCertificate.replace('{state}', 'TX'))).toBeTruthy();
  });
});
