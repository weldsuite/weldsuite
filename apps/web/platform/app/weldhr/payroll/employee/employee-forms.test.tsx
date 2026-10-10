/**
 * The employee-level payroll forms, the pay run forms and the bank and filing
 * dialogs in jsdom: submit them and check the request they would send. Data
 * hooks are mocked; forms, schemas and field components are the real ones.
 */

import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { I18nProvider } from '@weldsuite/i18n/provider';
import { en } from '@weldsuite/i18n/locales/en';
import type {
  HrPayComponent,
  HrPayRunDetail,
  HrPaySchedule,
  HrPayrollEmployeeDetail,
  HrPayrollEmployer,
  HrPayrollPaymentDetailsMasked,
  HrPayrollFiling,
} from '@weldsuite/app-api-client/domains/weldhr-payroll';
import { EmployerBankDialog } from '../components/employer-bank-dialog';
import { MarkFiledDialog } from '../components/mark-filed-dialog';
import { PaymentDetailsForm } from '../components/payment-details-form';
import { RunInputsSheet } from '../components/run-inputs-sheet';
import { StartRunDialog } from '../components/start-run-dialog';
import { ComponentDialog } from './component-dialog';
import { CompensationDialog } from './compensation-dialog';
import { ProfileDialog } from './profile-dialog';

const t = en.weldhr.payroll;
const common = en.weldhr.common;

const mocks = vi.hoisted(() => ({
  upsertProfile: vi.fn(),
  createCompensation: vi.fn(),
  createComponent: vi.fn(),
  updateComponent: vi.fn(),
  createRun: vi.fn(),
  markFiled: vi.fn(),
  setBank: vi.fn(),
  createInput: vi.fn(),
  updateInput: vi.fn(),
  deleteInput: vi.fn(),
  navigate: vi.fn(),
}));

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

const schedule: HrPaySchedule = {
  id: 'sch_1',
  employerId: 'emp_1',
  name: 'Monthly salaries',
  frequency: 'monthly',
  anchorDate: '2026-01-01',
  payDateRule: { kind: 'day_of_month', day: 25 },
  isActive: true,
  employeeCount: 3,
  nextPeriod: null,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
};

let employers: HrPayrollEmployer[] = [employer];

vi.mock('@tanstack/react-router', () => ({ useNavigate: () => mocks.navigate }));

vi.mock('@/hooks/queries/use-weldhr-payroll-queries', () => ({
  useHrPayrollEmployers: () => ({ data: employers }),
  useHrPayrollSchedules: () => ({ data: [schedule] }),
  useHrPayrollEmployees: () => ({ data: [] }),
  useUpsertHrPayrollProfile: () => ({ mutateAsync: mocks.upsertProfile, isPending: false }),
  useCreateHrCompensation: () => ({ mutateAsync: mocks.createCompensation, isPending: false }),
  useCreateHrPayComponent: () => ({ mutateAsync: mocks.createComponent, isPending: false }),
  useUpdateHrPayComponent: () => ({ mutateAsync: mocks.updateComponent, isPending: false }),
  useCreateHrPayRun: () => ({ mutateAsync: mocks.createRun, isPending: false }),
  useMarkHrPayrollFilingFiled: () => ({ mutateAsync: mocks.markFiled, isPending: false }),
  useSetHrPayrollEmployerBank: () => ({ mutateAsync: mocks.setBank, isPending: false }),
  useCreateHrPayRunInput: () => ({ mutateAsync: mocks.createInput, isPending: false }),
  useUpdateHrPayRunInput: () => ({ mutateAsync: mocks.updateInput, isPending: false }),
  useDeleteHrPayRunInput: () => ({ mutateAsync: mocks.deleteInput, isPending: false }),
  useHrPayRunInputs: () => ({ data: [], isLoading: false, error: null }),
}));

function renderInProvider(ui: React.ReactElement) {
  return render(<I18nProvider initialLanguage="en">{ui}</I18nProvider>);
}

const paymentDetails: HrPayrollPaymentDetailsMasked = {
  hasNationalId: false,
  nationalIdMasked: null,
  dateOfBirth: null,
  bankAccountHolder: null,
  bankIbanMasked: null,
  bankBic: null,
  bankRoutingNumber: null,
  bankAccountNumberMasked: null,
  bankAccountType: null,
  homeAddress: null,
  idDocumentType: null,
  idDocumentExpiresOn: null,
  idVerifiedAt: null,
};

function detailOf(country: 'NL' | 'US'): HrPayrollEmployeeDetail {
  return {
    employee: { id: 'e1', displayName: 'Anna de Vries', email: 'a@example.com', status: 'active', startDate: '2026-01-01', endDate: null, weeklyHours: 40 },
    profile: null,
    employer: { id: 'emp_1', name: 'Acme', country, currency: country === 'NL' ? 'EUR' : 'USD' },
    compensations: [],
    components: [],
    currentElections: [],
    paymentDetails,
    issues: [],
  };
}

beforeAll(() => {
  // Radix Select needs these in jsdom.
  Element.prototype.hasPointerCapture = () => false;
  Element.prototype.setPointerCapture = () => undefined;
  Element.prototype.releasePointerCapture = () => undefined;
  Element.prototype.scrollIntoView = () => undefined;
});

beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset().mockResolvedValue({ data: { id: 'run_9' } });
  employers = [employer];
});

describe('ProfileDialog', () => {
  it('puts a Dutch employee on payroll with the contract defaults', async () => {
    const user = userEvent.setup();
    renderInProvider(<ProfileDialog employeeId="e1" detail={detailOf('NL')} onClose={vi.fn()} />);

    await user.click(screen.getByRole('button', { name: common.save }));

    await waitFor(() => expect(mocks.upsertProfile).toHaveBeenCalledTimes(1));
    const payload = mocks.upsertProfile.mock.calls[0][0];
    expect(payload).toMatchObject({ employeeId: 'e1', employerId: 'emp_1', status: 'active', startDate: '2026-01-01' });
    expect(payload.nl).toMatchObject({ writtenContract: true, indefiniteContract: true, onCall: false, isDga: false, contractHoursPerWeek: 40, nationality: 'NL' });
    expect(payload).not.toHaveProperty('us');
  });

  it('sends only the US profile for a US employer', async () => {
    const user = userEvent.setup();
    employers = [{ ...employer, country: 'US', currency: 'USD' }];
    renderInProvider(<ProfileDialog employeeId="e1" detail={detailOf('US')} onClose={vi.fn()} />);

    await user.click(screen.getByRole('button', { name: common.save }));

    await waitFor(() => expect(mocks.upsertProfile).toHaveBeenCalledTimes(1));
    const payload = mocks.upsertProfile.mock.calls[0][0];
    expect(payload.us).toMatchObject({ flsaStatus: 'nonexempt', statutoryEmployee: false, exemptFica: false });
    expect(payload).not.toHaveProperty('nl');
  });
});

describe('CompensationDialog', () => {
  it('adds a monthly salary in the employer currency', async () => {
    const user = userEvent.setup();
    renderInProvider(<CompensationDialog employeeId="e1" detail={detailOf('NL')} onClose={vi.fn()} />);

    await user.type(screen.getByLabelText(t.employee.compensation.amount.replace('{currency}', 'EUR')), '3500,50');
    await user.click(screen.getByRole('button', { name: common.save }));

    await waitFor(() => expect(mocks.createCompensation).toHaveBeenCalledTimes(1));
    expect(mocks.createCompensation.mock.calls[0][0]).toMatchObject({
      employeeId: 'e1',
      payType: 'salary',
      amount: 3500.5,
      period: 'month',
      currency: 'EUR',
    });
  });

  it('asks for an amount before saving', async () => {
    const user = userEvent.setup();
    renderInProvider(<CompensationDialog employeeId="e1" detail={detailOf('NL')} onClose={vi.fn()} />);

    await user.click(screen.getByRole('button', { name: common.save }));

    expect(await screen.findAllByText(/Expected number|Required/)).not.toHaveLength(0);
    expect(mocks.createCompensation).not.toHaveBeenCalled();
  });
});

describe('ComponentDialog', () => {
  const component: HrPayComponent = {
    id: 'cmp_1',
    employeeId: 'e1',
    code: 'us.401k',
    label: null,
    amount: null,
    params: { percent: 5 },
    effectiveFrom: '2026-01-01',
    effectiveTo: null,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  };

  it('updates a component and keeps only its own parameters', async () => {
    const user = userEvent.setup();
    renderInProvider(<ComponentDialog employeeId="e1" country="US" currency="USD" component={{ ...component, params: { percent: 5, stale: 1 } }} onClose={vi.fn()} />);

    await user.click(screen.getByRole('button', { name: common.save }));

    await waitFor(() => expect(mocks.updateComponent).toHaveBeenCalledTimes(1));
    expect(mocks.updateComponent.mock.calls[0][0]).toMatchObject({ id: 'cmp_1', params: { percent: 5 } });
  });

  it('requires the parameters that the catalog marks as required', async () => {
    const user = userEvent.setup();
    const car: HrPayComponent = { ...component, code: 'nl.company_car', params: {} };
    renderInProvider(<ComponentDialog employeeId="e1" country="NL" currency="EUR" component={car} onClose={vi.fn()} />);

    await user.click(screen.getByRole('button', { name: common.save }));

    expect((await screen.findAllByText(t.employee.components.paramRequired)).length).toBeGreaterThan(0);
    expect(mocks.updateComponent).not.toHaveBeenCalled();
  });
});

describe('StartRunDialog', () => {
  it('needs a schedule for a regular run, then starts it', async () => {
    const user = userEvent.setup();
    renderInProvider(<StartRunDialog onClose={vi.fn()} />);

    await user.click(screen.getByRole('button', { name: t.runs.start.submit }));
    expect(await screen.findByText('A regular run needs a pay schedule')).toBeTruthy();
    expect(mocks.createRun).not.toHaveBeenCalled();

    await user.click(screen.getByRole('combobox', { name: t.common.schedule }));
    await user.click(await screen.findByRole('option', { name: schedule.name }));
    await user.click(screen.getByRole('button', { name: t.runs.start.submit }));

    await waitFor(() => expect(mocks.createRun).toHaveBeenCalledTimes(1));
    expect(mocks.createRun.mock.calls[0][0]).toMatchObject({ employerId: 'emp_1', kind: 'regular', payScheduleId: 'sch_1' });
    expect(mocks.navigate).toHaveBeenCalledWith({ to: '/weldhr/payroll/runs/$runId', params: { runId: 'run_9' } });
  });
});

describe('PaymentDetailsForm', () => {
  it('sends only what was filled in, and keeps stored numbers when they are left empty', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    renderInProvider(<PaymentDetailsForm country="NL" details={paymentDetails} isHr saving={false} failure={null} onSubmit={onSubmit} onCancel={vi.fn()} />);

    await user.type(screen.getByLabelText(t.details.bsn), '111222333');
    await user.click(screen.getByRole('button', { name: common.save }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    const payload = onSubmit.mock.calls[0][0];
    expect(payload.nationalId).toBe('111222333');
    expect(payload.bankIban).toBeUndefined();
    expect(payload.homeAddress).toBeNull();
    expect(payload.dateOfBirth).toBeNull();
  });

  it('rejects a malformed social security number', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    renderInProvider(<PaymentDetailsForm country="US" details={paymentDetails} isHr={false} saving={false} failure={null} onSubmit={onSubmit} onCancel={vi.fn()} />);

    await user.type(screen.getByLabelText(t.details.ssn), '12-34');
    await user.click(screen.getByRole('button', { name: common.save }));

    expect(await screen.findByText('Expected a BSN or SSN')).toBeTruthy();
    expect(onSubmit).not.toHaveBeenCalled();
  });
});

describe('EmployerBankDialog', () => {
  it('keeps the stored IBAN when the field is left empty', async () => {
    const user = userEvent.setup();
    const withBank: HrPayrollEmployer = {
      ...employer,
      bank: { accountHolder: 'Acme BV', ibanMasked: 'NL91 •••• •••• 4300', bic: null, routingNumber: null, accountNumberMasked: null, accountType: null, nachaCompanyId: null, bankName: null },
    };
    renderInProvider(<EmployerBankDialog employer={withBank} onClose={vi.fn()} />);

    await user.click(screen.getByRole('button', { name: common.save }));

    await waitFor(() => expect(mocks.setBank).toHaveBeenCalledTimes(1));
    const payload = mocks.setBank.mock.calls[0][0];
    expect(payload).toMatchObject({ id: 'emp_1', accountHolder: 'Acme BV' });
    expect(payload.iban).toBeUndefined();
  });

  it('sends a new IBAN', async () => {
    const user = userEvent.setup();
    renderInProvider(<EmployerBankDialog employer={employer} onClose={vi.fn()} />);

    await user.type(screen.getByLabelText('IBAN'), 'NL91ABNA0417164300');
    await user.click(screen.getByRole('button', { name: common.save }));

    await waitFor(() => expect(mocks.setBank).toHaveBeenCalledTimes(1));
    expect(mocks.setBank.mock.calls[0][0]).toMatchObject({ id: 'emp_1', iban: 'NL91ABNA0417164300' });
  });
});

describe('MarkFiledDialog', () => {
  it('marks a filing as filed with an optional reference', async () => {
    const user = userEvent.setup();
    const filing = { id: 'fil_1' } as HrPayrollFiling;
    renderInProvider(<MarkFiledDialog filing={filing} onClose={vi.fn()} />);

    await user.type(screen.getByLabelText(t.filings.markFiled.reference), 'EFTPS-123');
    await user.click(screen.getByRole('button', { name: t.filings.actions.markFiled }));

    await waitFor(() => expect(mocks.markFiled).toHaveBeenCalledTimes(1));
    expect(mocks.markFiled.mock.calls[0][0]).toMatchObject({ id: 'fil_1', externalReference: 'EFTPS-123' });
    expect(mocks.markFiled.mock.calls[0][0].filedOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe('RunInputsSheet', () => {
  const run = {
    id: 'run_1',
    country: 'NL',
    currency: 'EUR',
    employees: [{ employeeId: 'e1', displayName: 'Anna de Vries', excluded: false, issues: [] }],
  } as unknown as HrPayRunDetail;

  it('adds a one-off bonus as an amount', async () => {
    const user = userEvent.setup();
    renderInProvider(<RunInputsSheet run={run} employeeId="e1" employeeName="Anna de Vries" editable onClose={vi.fn()} />);

    await user.click(screen.getByRole('button', { name: t.inputs.add }));
    await user.click(screen.getByRole('combobox', { name: t.inputs.type }));
    await user.click(await screen.findByRole('option', { name: t.components.bonus }));
    await user.type(screen.getByLabelText(t.inputs.amount.replace('{currency}', 'EUR')), '250');
    await user.click(screen.getByRole('button', { name: common.save }));

    await waitFor(() => expect(mocks.createInput).toHaveBeenCalledTimes(1));
    expect(mocks.createInput.mock.calls[0][0]).toMatchObject({ runId: 'run_1', employeeId: 'e1', code: 'bonus', amount: 250 });
  });

  it('hides adding inputs when the run can no longer change', () => {
    renderInProvider(<RunInputsSheet run={run} employeeId="e1" employeeName="Anna de Vries" editable={false} onClose={vi.fn()} />);

    expect(screen.queryByRole('button', { name: t.inputs.add })).toBeNull();
  });
});
