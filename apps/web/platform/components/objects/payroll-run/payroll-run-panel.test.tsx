import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { PayrollImportDetail } from '@/lib/api/domains/weldbooks-assets';

const reverseAsync = vi.fn();
const refetch = vi.fn();
const permissions = new Set<string>();
let query: { data: PayrollImportDetail | undefined; isLoading: boolean; isError: boolean };

vi.mock('@/components/object-panel', () => import('@/components/objects/_shared/object-panel-test-mock'));
vi.mock('@tanstack/react-router', () => ({
  Link: ({ to, params, children }: { to: string; params?: Record<string, string>; children: React.ReactNode }) => (
    <a href={params ? Object.entries(params).reduce((acc, [key, value]) => acc.replace(`$${key}`, value), to) : to}>
      {children}
    </a>
  ),
}));
vi.mock('@weldsuite/permissions/react', () => ({
  usePermissions: () => ({ can: (permission: string) => permissions.has(permission) }),
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('@/hooks/use-workspace-url', () => ({ useWorkspaceUrl: () => (path: string) => `https://app.test${path}` }));
vi.mock('@/lib/weldbooks/use-weldbooks-format', () => ({
  useWeldbooksFormat: () => ({
    formatMoney: (value: number | string) => `$${Number(value).toFixed(2)}`,
    formatDate: (value: string) => value,
    formatDateTime: (value: string) => value.slice(0, 10),
    today: () => '2026-03-10',
  }),
}));
vi.mock('@/components/entity-audit-panel', () => ({
  EntityAuditPanel: ({ entityType, entityId }: { entityType: string; entityId: string }) => (
    <div data-testid="audit-panel">{`${entityType}:${entityId}`}</div>
  ),
}));
vi.mock('@/hooks/queries/use-weldbooks-assets-queries', () => ({
  usePayrollImport: () => ({ ...query, refetch }),
  useReversePayrollImport: () => ({ mutateAsync: reverseAsync, isPending: false }),
}));

import { PayrollRunPanel } from './payroll-run-panel';
import { polyfillRadixSelect, renderWithProviders } from '@/app/weldbooks/fixed-assets/test-utils';

function payroll(extra: Partial<PayrollImportDetail> = {}): PayrollImportDetail {
  return {
    id: 'pri_1',
    createdAt: '2026-02-01T00:00:00.000Z',
    entityId: 'ent_1',
    source: 'csv',
    connectionId: null,
    externalId: null,
    periodStart: '2026-01-01',
    periodEnd: '2026-01-15',
    payDate: '2026-01-15',
    summary: { gross_wages: 10000, net_pay: 8000, employer_taxes: 0 },
    status: 'posted',
    journalEntryId: 'je_1',
    sourceFileName: 'january.csv',
    createdBy: null,
    lines: [
      { accountId: 'acc_wages', accountCode: '6000', accountName: 'Wages', debit: '10000.00', credit: null, description: 'Payroll 2026-01-15: Gross wages' },
      { accountId: 'acc_bank', accountCode: '1000', accountName: 'Checking', debit: null, credit: '10000.00', description: 'Payroll 2026-01-15: Net pay' },
    ],
    ...extra,
  };
}

function renderPanel() {
  return renderWithProviders(
    <PayrollRunPanel id="pri_1" isOpen onClose={vi.fn()} mode="fullscreen" onModeChange={vi.fn()} />,
  );
}

describe('PayrollRunPanel', () => {
  beforeAll(polyfillRadixSelect);
  beforeEach(() => {
    reverseAsync.mockReset().mockResolvedValue({});
    refetch.mockReset();
    permissions.clear();
    ['journal:read', 'journal:create', 'journal:update', 'journal:delete'].forEach((p) => permissions.add(p));
    query = { data: payroll(), isLoading: false, isError: false };
  });

  it('shows the pay date and status in the header and the payroll in the Details tab', () => {
    renderPanel();
    expect(screen.getByText('Payroll of 2026-01-15')).toBeInTheDocument();
    expect(screen.getAllByText('Posted').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('CSV file')).toBeInTheDocument();
    expect(screen.getByText('2026-01-01 – 2026-01-15')).toBeInTheDocument();
    expect(screen.getByText('january.csv')).toBeInTheDocument();
    expect(screen.getByText('2026-02-01')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'View journal entry' })).toHaveAttribute('href', '/weldbooks/journal/je_1');
  });

  it('shows the totals, leaving out the zero ones', () => {
    renderPanel();
    expect(screen.getByText('Gross wages').nextElementSibling).toHaveTextContent('$10000.00');
    expect(screen.getByText('Net pay (bank or payroll clearing)').nextElementSibling).toHaveTextContent('$8000.00');
    expect(screen.queryByText('Employer payroll taxes')).not.toBeInTheDocument();
  });

  it('lists the journal entry lines with their totals in the Journal entry tab', async () => {
    const user = userEvent.setup();
    renderPanel();
    await user.click(screen.getByRole('tab', { name: 'Journal entry' }));

    expect(screen.getByRole('link', { name: '6000 — Wages' })).toHaveAttribute('href', '/weldbooks/accounts/acc_wages');
    expect(screen.getByRole('link', { name: '1000 — Checking' })).toHaveAttribute('href', '/weldbooks/accounts/acc_bank');
    expect(screen.getByText('Payroll 2026-01-15: Net pay')).toBeInTheDocument();
    const total = screen.getByText('Total').parentElement as HTMLElement;
    expect(total).toHaveTextContent('$10000.00$10000.00');
  });

  it('says so when the payroll has no journal lines', async () => {
    const user = userEvent.setup();
    query = { data: payroll({ lines: [] }), isLoading: false, isError: false };
    renderPanel();
    await user.click(screen.getByRole('tab', { name: 'Journal entry' }));
    expect(screen.getByText('No journal lines')).toBeInTheDocument();
    expect(screen.getByText('This payroll has no journal lines.')).toBeInTheDocument();
  });

  it('shows the audit log of the payroll import in the History tab', async () => {
    const user = userEvent.setup();
    renderPanel();
    await user.click(screen.getByRole('tab', { name: 'Audit Log' }));
    expect(screen.getByTestId('audit-panel')).toHaveTextContent('payroll_import:pri_1');
  });

  it('reverses a posted payroll from the menu, on the date chosen in the dialog', async () => {
    const user = userEvent.setup();
    renderPanel();
    await user.click(screen.getByRole('button', { name: 'Open menu' }));
    await user.click(await screen.findByTestId('reverse-open'));

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByLabelText('Reversal date')).toHaveValue('2026-01-15');
    await user.click(within(dialog).getByTestId('reverse-submit'));
    await waitFor(() => expect(reverseAsync).toHaveBeenCalledWith({ id: 'pri_1', date: '2026-01-15' }));
  });

  it('offers no reversal for a payroll that was already reversed, and says it was', async () => {
    const user = userEvent.setup();
    query = { data: payroll({ status: 'reversed' }), isLoading: false, isError: false };
    renderPanel();
    expect(screen.getByText(/This payroll was reversed/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Open menu' }));
    await screen.findByRole('menuitem', { name: 'Copy link' });
    expect(screen.queryByTestId('reverse-open')).not.toBeInTheDocument();
  });

  it('offers no reversal without journal:delete', async () => {
    const user = userEvent.setup();
    permissions.delete('journal:delete');
    renderPanel();
    await user.click(screen.getByRole('button', { name: 'Open menu' }));
    await screen.findByRole('menuitem', { name: 'Copy link' });
    expect(screen.queryByTestId('reverse-open')).not.toBeInTheDocument();
  });

  it('says so when the payroll does not exist', () => {
    query = { data: undefined, isLoading: false, isError: false };
    renderPanel();
    expect(screen.getByText('This payroll import does not exist.')).toBeInTheDocument();
  });

  it('says so when the payroll cannot be loaded, and offers to try again', async () => {
    const user = userEvent.setup();
    query = { data: undefined, isLoading: false, isError: true };
    renderPanel();
    expect(screen.getByRole('alert')).toHaveTextContent('The payroll could not be loaded.');
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(refetch).toHaveBeenCalled();
  });
});
