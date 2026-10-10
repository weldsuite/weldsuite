import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { I18nProvider } from '@weldsuite/i18n/provider';
import { en } from '@weldsuite/i18n/locales/en';
import type { HrMyPayrollDetails, HrMyPayslip } from '@weldsuite/app-api-client/domains/weldhr-payroll';
import { MyPayrollTab, unsignedElections } from './payroll-tab';

const t = en.weldhr.payroll;

const mocks = vi.hoisted(() => ({ sign: vi.fn(), update: vi.fn() }));

let details: HrMyPayrollDetails;
let payslips: HrMyPayslip[] = [];

vi.mock('@/hooks/queries/use-weldhr-payroll-queries', () => ({
  useMyPayrollDetails: () => ({ data: details, isLoading: false, error: null }),
  useMyPayslips: () => ({ data: payslips, error: null }),
  useMyAnnualStatements: () => ({ data: [{ year: 2025, employerId: 'emp_1', employerName: 'Acme BV', kind: 'jaaropgaaf' }] }),
  useDownloadMyPayslipPdf: () => ({ mutate: vi.fn(), isPending: false }),
  useDownloadMyAnnualStatementPdf: () => ({ mutate: vi.fn(), isPending: false }),
  useUpdateMyPayrollDetails: () => ({ mutateAsync: mocks.update, isPending: false }),
  useSignMyTaxElection: () => ({ mutateAsync: mocks.sign, isPending: false }),
}));

const masked = {
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
} as const;

function renderTab() {
  return render(
    <I18nProvider initialLanguage="en">
      <MyPayrollTab employeeName="Anna de Vries" />
    </I18nProvider>,
  );
}

beforeEach(() => {
  mocks.sign.mockReset().mockResolvedValue(undefined);
  payslips = [
    {
      id: 'ps_1',
      number: '2026-10-001',
      employerName: 'Acme BV',
      currency: 'EUR',
      periodStart: '2026-10-01',
      periodEnd: '2026-10-31',
      payDate: '2026-10-25',
      grossPay: '3000.00',
      netPay: '2100.00',
      viewedAt: null,
    },
  ];
  details = {
    country: 'NL',
    employerName: 'Acme BV',
    paymentDetails: { ...masked },
    elections: [],
    requiredElections: [{ kind: 'nl_loonheffingskorting', state: null }],
    missing: ['nationalId', 'bankIban', 'somethingNew'],
  };
});

describe('unsignedElections', () => {
  it('leaves out forms that already have an election in force', () => {
    const result = unsignedElections({
      ...details,
      requiredElections: [
        { kind: 'us_w4', state: null },
        { kind: 'us_state_certificate', state: 'CA' },
      ],
      elections: [{ id: 'el_1', employeeId: 'e1', kind: 'us_w4', state: null, effectiveFrom: '2026-01-01', data: {}, signedBy: null, signatureName: 'A', signedAt: null, source: 'employee', createdAt: '' }],
    });
    expect(result).toEqual([{ kind: 'us_state_certificate', state: 'CA' }]);
  });
});

describe('MyPayrollTab', () => {
  it('lists what payroll still needs, with readable names for known and unknown fields', () => {
    renderTab();

    expect(screen.getByText(t.me.missing.nationalId)).toBeTruthy();
    expect(screen.getByText(t.me.missing.bankIban)).toBeTruthy();
    expect(screen.getByText('Something new')).toBeTruthy();
    expect(screen.getByText(`Sign: ${t.elections.titles.nl_loonheffingskorting}`)).toBeTruthy();
  });

  it('shows the payslips and the annual statements', () => {
    renderTab();

    expect(screen.getByText(t.me.payslips.new)).toBeTruthy();
    expect(screen.getByRole('button', { name: t.annualStatement.jaaropgaaf.replace('{year}', '2025') + ' · Acme BV' })).toBeTruthy();
  });

  it('signs the loonheffingskorting with the typed name', async () => {
    const user = userEvent.setup();
    renderTab();

    await user.click(screen.getByRole('button', { name: t.me.forms.sign }));
    await user.click(screen.getByRole('button', { name: t.elections.sign }));

    await waitFor(() => expect(mocks.sign).toHaveBeenCalledTimes(1));
    expect(mocks.sign.mock.calls[0][0]).toMatchObject({
      kind: 'nl_loonheffingskorting',
      data: { applyCredit: true },
      signatureName: 'Anna de Vries',
    });
  });

  it('hides the details and the forms for an employee who is not on payroll', () => {
    details = { ...details, country: null, employerName: null, requiredElections: [], missing: [] };
    renderTab();

    expect(screen.queryByText(t.me.details.title)).toBeNull();
    expect(screen.queryByText(t.me.forms.title)).toBeNull();
    expect(screen.getByText(t.me.payslips.title)).toBeTruthy();
  });
});
