import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { I18nProvider } from '@weldsuite/i18n/provider';
import { en } from '@weldsuite/i18n/locales/en';
import type { HrPayRunDetail } from '@weldsuite/app-api-client/domains/weldhr-payroll';
import WeldHrPayrollRunPage from './page';

const t = en.weldhr.payroll;

function renderPage() {
  return render(
    <I18nProvider initialLanguage="en">
      <WeldHrPayrollRunPage />
    </I18nProvider>,
  );
}

let run: HrPayRunDetail;
let permissions: string[] = [];

vi.mock('@tanstack/react-router', () => ({
  useParams: () => ({ runId: 'run_1' }),
  useNavigate: () => () => undefined,
  Link: ({ children, ...props }: { children?: React.ReactNode }) => <a {...(props as object)}>{children}</a>,
}));

vi.mock('@weldsuite/permissions/react', () => ({
  usePermissions: () => ({ can: (permission: string) => permissions.includes(permission), isLoading: false }),
}));

vi.mock('@/contexts/breadcrumb-context', () => ({ useBreadcrumbs: () => undefined }));

const { mutation } = vi.hoisted(() => ({
  mutation: () => ({ mutate: () => undefined, mutateAsync: () => Promise.resolve(), isPending: false, variables: undefined }),
}));

vi.mock('@/hooks/queries/use-weldhr-payroll-queries', () => ({
  useHrPayrollFlag: () => ({ enabled: true, isLoading: false }),
  useHrPayRun: () => ({ data: run, isLoading: false, error: null }),
  useApproveHrPayRun: mutation,
  useCalculateHrPayRun: mutation,
  useCancelHrPayRun: mutation,
  useCollectHrPayRunInputs: mutation,
  useCreateHrPayRun: mutation,
  useDownloadHrPayRunPaymentFile: mutation,
  useDownloadHrPayRunReport: mutation,
  usePostHrPayRunJournal: mutation,
  useSetHrPayRunEmployee: mutation,
  useMarkHrPayRunPaid: mutation,
  useUpdateHrPayRun: mutation,
  useHrPayRunInputs: () => ({ data: [], isLoading: false, error: null }),
  useCreateHrPayRunInput: mutation,
  useUpdateHrPayRunInput: mutation,
  useDeleteHrPayRunInput: mutation,
  useHrPayslip: () => ({ data: undefined, isLoading: true, error: null }),
  useDownloadHrPayslipPdf: mutation,
}));

function makeRun(overrides: Partial<HrPayRunDetail> = {}): HrPayRunDetail {
  return {
    id: 'run_1',
    employerId: 'emp_1',
    employerName: 'Acme BV',
    payScheduleId: 'sch_1',
    payScheduleName: 'Monthly',
    country: 'NL',
    currency: 'EUR',
    kind: 'regular',
    correctsRunId: null,
    periodStart: '2026-10-01',
    periodEnd: '2026-10-31',
    payDate: '2026-10-25',
    taxYear: 2026,
    periodNumber: 10,
    status: 'calculated',
    employeeCount: 2,
    totals: {
      grossCents: 600000,
      netCents: 420000,
      employeeTaxesCents: 150000,
      employeeDeductionsCents: 30000,
      employerTaxesCents: 90000,
      reimbursementsCents: 0,
      employerCostCents: 690000,
    },
    issues: [],
    errorCount: 0,
    warningCount: 0,
    notes: null,
    preparedBy: null,
    preparedByName: null,
    calculatedAt: null,
    calculatedByName: null,
    approvedAt: null,
    approvedByName: null,
    paidAt: null,
    journalStatus: 'not_linked',
    journalEntryId: null,
    journalError: null,
    createdAt: '2026-10-01T00:00:00Z',
    updatedAt: '2026-10-01T00:00:00Z',
    employees: [
      { employeeId: 'e1', displayName: 'Anna de Vries', excluded: false, issues: [] },
      { employeeId: 'e2', displayName: 'Bram Jansen', excluded: true, issues: [] },
    ],
    payslips: [
      {
        id: 'ps_1',
        employeeId: 'e1',
        employeeName: 'Anna de Vries',
        status: 'draft',
        number: null,
        grossPay: '3000.00',
        employeeTaxes: '750.00',
        netPay: '2100.00',
        employerCost: '3450.00',
        issues: [],
        previousNetPay: '2000.00',
      },
    ],
    canApprove: true,
    paymentFile: { format: 'sepa', available: false },
    ...overrides,
  };
}

describe('WeldHR pay run page', () => {
  beforeEach(() => {
    permissions = ['payroll:read', 'payroll:prepare', 'payroll:approve'];
    run = makeRun();
  });

  it('shows the totals, the employees and the approve action of a calculated run', () => {
    renderPage();

    expect(screen.getByRole('heading', { level: 1 }).textContent).toContain('Pay run');
    expect(screen.getByText('Anna de Vries')).toBeTruthy();
    expect(screen.getByText('Bram Jansen')).toBeTruthy();
    expect(screen.getByRole('button', { name: t.run.approve })).toBeEnabled();
    expect(screen.getByRole('button', { name: t.run.recalculate })).toBeTruthy();
    expect(screen.getByRole('button', { name: t.run.collect })).toBeTruthy();
  });

  it('blocks approval while the run has errors and says why', () => {
    run = makeRun({
      errorCount: 2,
      issues: [
        { severity: 'error', code: 'missing_bank_account', employeeId: 'e1' },
        { severity: 'error', code: 'missing_tax_id', employeeId: 'e1' },
      ],
    });
    renderPage();

    expect(screen.getByRole('button', { name: t.run.approve })).toBeDisabled();
    expect(screen.getByText(t.run.approveBlocked.errors.replace('{count}', '2'))).toBeTruthy();
    expect(screen.getByText(t.issues.missing_bank_account, { exact: false })).toBeTruthy();
  });

  it('blocks approval for the person who calculated the run under four eyes', () => {
    run = makeRun({ canApprove: false });
    renderPage();

    expect(screen.getByRole('button', { name: t.run.approve })).toBeDisabled();
    expect(screen.getByText(t.run.approveBlocked.fourEyes)).toBeTruthy();
  });

  it('hides approving and the payment file without payroll:approve', () => {
    permissions = ['payroll:read', 'payroll:prepare'];
    run = makeRun({ status: 'approved', paymentFile: { format: 'sepa', available: true } });
    renderPage();

    expect(screen.queryByRole('button', { name: t.run.approve })).toBeNull();
    expect(screen.queryByRole('button', { name: t.run.downloadSepa })).toBeNull();
    expect(screen.queryByRole('button', { name: t.run.markPaid })).toBeNull();
  });

  it('offers the payment file, mark as paid and a correction on an approved run', () => {
    run = makeRun({ status: 'approved', paymentFile: { format: 'sepa', available: true } });
    renderPage();

    expect(screen.getByRole('button', { name: t.run.downloadSepa })).toBeTruthy();
    expect(screen.getByRole('button', { name: t.run.markPaid })).toBeTruthy();
    expect(screen.getByRole('button', { name: t.run.correction })).toBeTruthy();
    expect(screen.queryByRole('button', { name: t.run.calculate })).toBeNull();
    expect(screen.queryByRole('button', { name: t.run.cancel })).toBeNull();
  });

  it('offers a retry when the WeldBooks journal failed', () => {
    run = makeRun({ status: 'approved', journalStatus: 'failed', journalError: 'Period is locked' });
    renderPage();

    expect(screen.getByText(t.run.journalFailed)).toBeTruthy();
    expect(screen.getByText('Period is locked')).toBeTruthy();
    expect(screen.getByRole('button', { name: t.run.journalRetry })).toBeTruthy();
  });

  it('does not offer collecting inputs on a correction run', () => {
    run = makeRun({ status: 'draft', kind: 'correction', correctsRunId: 'run_0', totals: null });
    renderPage();

    expect(screen.queryByRole('button', { name: t.run.collect })).toBeNull();
    expect(screen.getByRole('button', { name: t.run.calculate })).toBeTruthy();
  });
});
