import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { PayrollConnection, PayrollImport, PayrollImportDetail, PayrollImportFilters } from '@/lib/api/domains/weldbooks-assets';

const navigate = vi.fn();
const reverseAsync = vi.fn();
const createAsync = vi.fn();
const syncAsync = vi.fn();
const mappingAsync = vi.fn();
const permissions = new Set(['journal:read', 'journal:create', 'journal:update', 'journal:delete']);
let imports: PayrollImport[] = [];
let connections: PayrollConnection[] = [];
let detail: PayrollImportDetail | undefined;
const importFilters: PayrollImportFilters[] = [];

vi.mock('@tanstack/react-router', () => ({
  Link: ({ to, children }: { to: string; children: React.ReactNode }) => <a href={to}>{children}</a>,
  useNavigate: () => navigate,
  useParams: () => ({ id: 'pri_1' }),
}));
vi.mock('@weldsuite/permissions/react', () => ({
  usePermissions: () => ({ can: (permission: string) => permissions.has(permission) }),
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('@/lib/weldbooks/use-weldbooks-format', () => ({
  useWeldbooksFormat: () => ({
    formatMoney: (value: number | string) => `$${Number(value).toFixed(2)}`,
    formatDate: (value: string) => value,
    formatDateTime: (value: string) => value.slice(0, 10),
    today: () => '2026-03-10',
  }),
}));
vi.mock('@/hooks/queries/use-accounting-queries', () => ({
  useAccountingAccounts: () => ({
    data: {
      data: [
        { id: 'acc_bank', code: '1000', name: 'Checking', type: 'asset', isActive: true },
        { id: 'acc_wages', code: '6000', name: 'Wages', type: 'expense', isActive: true },
      ],
    },
  }),
}));
vi.mock('@/hooks/queries/use-weldbooks-assets-queries', () => ({
  usePayrollImports: (filters: PayrollImportFilters) => {
    importFilters.push(filters);
    return {
      data: { data: imports, pagination: { totalCount: imports.length, hasMore: false, cursor: null } },
      isLoading: false,
      isError: false,
      refetch: vi.fn(),
    };
  },
  useReversePayrollImport: () => ({ mutateAsync: reverseAsync, isPending: false }),
  usePayrollImport: () => ({ data: detail, isLoading: false, isError: false, refetch: vi.fn() }),
  usePayrollConnections: () => ({ data: connections, isLoading: false, isError: false, refetch: vi.fn() }),
  useCreateGustoConnection: () => ({ mutateAsync: createAsync, isPending: false }),
  useSetPayrollConnectionMapping: () => ({ mutateAsync: mappingAsync, isPending: false }),
  useSyncPayrollConnection: () => ({ mutateAsync: syncAsync, isPending: false }),
  useDisconnectPayrollConnection: () => ({ mutateAsync: vi.fn(), isPending: false }),
  usePayrollCategories: () => ({ data: undefined }),
}));

import PayrollImportsPage from './page';
import PayrollConnectionsPage from './connections/page';
import PayrollImportDetailPage from './[id]/page';
import { polyfillRadixSelect, renderWithProviders } from '../fixed-assets/test-utils';

const payroll = (id: string, extra: Partial<PayrollImport> = {}): PayrollImport => ({
  id,
  createdAt: '2026-02-01T00:00:00.000Z',
  entityId: 'ent_1',
  source: 'csv',
  connectionId: null,
  externalId: null,
  periodStart: '2026-01-01',
  periodEnd: '2026-01-15',
  payDate: '2026-01-15',
  summary: { gross_wages: 10000, net_pay: 8000 },
  status: 'posted',
  journalEntryId: 'je_1',
  sourceFileName: 'january.csv',
  createdBy: null,
  ...extra,
});

describe('Payroll imports page', () => {
  beforeAll(polyfillRadixSelect);
  beforeEach(() => {
    navigate.mockReset();
    reverseAsync.mockReset().mockResolvedValue({});
    importFilters.length = 0;
    permissions.clear();
    ['journal:read', 'journal:create', 'journal:update', 'journal:delete'].forEach((permission) => permissions.add(permission));
    imports = [payroll('pri_1'), payroll('pri_2', { source: 'gusto', status: 'reversed', summary: null, sourceFileName: null })];
  });

  it('lists the payrolls with their source, amounts and status', () => {
    renderWithProviders(<PayrollImportsPage />);
    const row = screen.getByTestId('payroll-row-pri_1');
    expect(row).toHaveTextContent('2026-01-15');
    expect(row).toHaveTextContent('2026-01-01 – 2026-01-15');
    expect(row).toHaveTextContent('CSV file');
    expect(row).toHaveTextContent('january.csv');
    expect(row).toHaveTextContent('$10000.00');
    expect(row).toHaveTextContent('$8000.00');
    expect(row).toHaveTextContent('Posted');
    expect(screen.getByTestId('payroll-row-pri_2')).toHaveTextContent('Reversed');
    expect(screen.getByTestId('payroll-row-pri_2')).toHaveTextContent('Gusto');
  });

  it('offers to reverse only a posted payroll, and reverses it on the chosen date', async () => {
    const user = userEvent.setup();
    renderWithProviders(<PayrollImportsPage />);
    expect(within(screen.getByTestId('payroll-row-pri_2')).queryByRole('button', { name: 'Reverse' })).not.toBeInTheDocument();

    await user.click(within(screen.getByTestId('payroll-row-pri_1')).getByRole('button', { name: 'Reverse' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByLabelText('Reversal date')).toHaveValue('2026-01-15');
    await user.clear(within(dialog).getByLabelText('Reversal date'));
    await user.type(within(dialog).getByLabelText('Reversal date'), '2026-02-01');
    await user.click(within(dialog).getByTestId('reverse-submit'));

    await waitFor(() => expect(reverseAsync).toHaveBeenCalledWith({ id: 'pri_1', date: '2026-02-01' }));
    // Opening the dialog did not open the payroll behind it.
    expect(navigate).not.toHaveBeenCalled();
  });

  it('shows why a reversal failed and keeps the dialog open', async () => {
    reverseAsync.mockRejectedValueOnce(new Error('The period is locked'));
    const user = userEvent.setup();
    renderWithProviders(<PayrollImportsPage />);
    await user.click(within(screen.getByTestId('payroll-row-pri_1')).getByRole('button', { name: 'Reverse' }));
    await user.click(await screen.findByTestId('reverse-submit'));
    expect(await screen.findByTestId('reverse-error')).toHaveTextContent('The period is locked');
  });

  it('opens a payroll by its row, and filters by status', async () => {
    const user = userEvent.setup();
    renderWithProviders(<PayrollImportsPage />);
    await user.click(screen.getByTestId('payroll-row-pri_1'));
    expect(navigate).toHaveBeenCalledWith({ to: '/weldbooks/payroll/$id', params: { id: 'pri_1' } });

    await user.click(screen.getByRole('combobox', { name: 'Status' }));
    await user.click(await screen.findByRole('option', { name: 'Reversed' }));
    expect(importFilters.at(-1)).toMatchObject({ status: 'reversed' });
  });

  it('hides reversing and importing without the permissions', () => {
    permissions.delete('journal:delete');
    permissions.delete('journal:create');
    renderWithProviders(<PayrollImportsPage />);
    expect(screen.queryByRole('button', { name: 'Reverse' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Import CSV' })).not.toBeInTheDocument();
  });

  it('invites the first import when there are none', () => {
    imports = [];
    renderWithProviders(<PayrollImportsPage />);
    expect(screen.getByText('No payrolls imported yet')).toBeInTheDocument();
  });
});

const connection = (extra: Partial<PayrollConnection> = {}): PayrollConnection => ({
  id: 'prc_1',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  entityId: 'ent_1',
  provider: 'gusto',
  providerCompanyId: 'co-123',
  accountMapping: null,
  status: 'active',
  lastSyncedAt: null,
  lastError: null,
  hasCredentials: true,
  environment: 'production',
  ...extra,
});

describe('Gusto connections page', () => {
  beforeAll(polyfillRadixSelect);
  beforeEach(() => {
    createAsync.mockReset().mockResolvedValue(connection());
    syncAsync.mockReset();
    mappingAsync.mockReset().mockResolvedValue(connection());
    permissions.clear();
    ['journal:read', 'journal:create', 'journal:update', 'journal:delete'].forEach((permission) => permissions.add(permission));
    connections = [connection()];
  });

  it('never shows the access token, only that one is stored', () => {
    renderWithProviders(<PayrollConnectionsPage />);
    const card = screen.getByTestId('gusto-connection-prc_1');
    expect(card).toHaveTextContent('Company co-123');
    expect(card).toHaveTextContent('Access token stored (hidden)');
    expect(card).toHaveTextContent('Production');
    expect(card).toHaveTextContent('Not synced yet');
    expect(within(card).queryByRole('textbox')).not.toBeInTheDocument();
    // Nothing of the connection holds a field a token could be read from.
    expect(card.querySelector('input')).toBeNull();
  });

  it('types the token into a password field, sends it once and clears it', async () => {
    const user = userEvent.setup();
    renderWithProviders(<PayrollConnectionsPage />);

    const token = screen.getByLabelText('Access token');
    expect(token).toHaveAttribute('type', 'password');
    await user.type(token, 'super-secret-token-123');
    await user.type(screen.getByLabelText('Company ID'), 'co-456');
    await user.click(screen.getByTestId('gusto-connect-submit'));

    await waitFor(() => expect(createAsync).toHaveBeenCalledTimes(1));
    expect(createAsync).toHaveBeenCalledWith({
      provider: 'gusto',
      accessToken: 'super-secret-token-123',
      companyId: 'co-456',
      environment: 'production',
    });
    await waitFor(() => expect(screen.getByLabelText('Access token')).toHaveValue(''));
    expect(document.body.innerHTML).not.toContain('super-secret-token-123');
  });

  it('clears the token and shows the error when Gusto refuses it', async () => {
    createAsync.mockRejectedValueOnce(new Error('Gusto rejected the access token (expired or revoked)'));
    const user = userEvent.setup();
    renderWithProviders(<PayrollConnectionsPage />);
    await user.type(screen.getByLabelText('Access token'), 'expired-token-1234');
    await user.type(screen.getByLabelText('Company ID'), 'co-456');
    await user.click(screen.getByTestId('gusto-connect-submit'));

    expect(await screen.findByTestId('gusto-connect-error')).toHaveTextContent('Gusto rejected the access token');
    expect(screen.getByLabelText('Access token')).toHaveValue('');
  });

  it('validates the token and company before sending', async () => {
    const user = userEvent.setup();
    renderWithProviders(<PayrollConnectionsPage />);
    await user.click(screen.getByTestId('gusto-connect-submit'));
    expect(await screen.findByText('Enter the access token.')).toBeInTheDocument();
    expect(screen.getByText('Enter the company ID.')).toBeInTheDocument();
    expect(createAsync).not.toHaveBeenCalled();
  });

  it('cannot sync until the net pay account is mapped', async () => {
    const user = userEvent.setup();
    renderWithProviders(<PayrollConnectionsPage />);
    expect(screen.getByTestId('sync-open')).toBeDisabled();
    expect(screen.getByText('Choose the accounts the payrolls post to before you import.')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Account mapping' }));
    expect(await screen.findByTestId('mapping-needs-net-pay')).toBeInTheDocument();
    await user.click(screen.getByRole('combobox', { name: 'Net pay (bank or payroll clearing)' }));
    await user.click(await screen.findByRole('option', { name: '1000 — Checking' }));
    expect(screen.queryByTestId('mapping-needs-net-pay')).not.toBeInTheDocument();
    await user.click(screen.getByTestId('mapping-save'));

    await waitFor(() => expect(mappingAsync).toHaveBeenCalledWith({ id: 'prc_1', accountMapping: { net_pay: 'acc_bank' } }));
  });

  it('syncs a mapped company and shows what was imported, skipped and failed', async () => {
    connections = [connection({ accountMapping: { net_pay: 'acc_bank' }, lastSyncedAt: '2026-02-01T10:00:00.000Z' })];
    syncAsync.mockResolvedValue({
      from: '2026-01-01',
      to: '2026-03-10',
      fetched: 4,
      imported: [{ externalId: 'p1', payDate: '2026-01-15', importId: 'pri_5', journalEntryId: 'je_5' }],
      skipped: [{ externalId: 'p2', payDate: '2026-01-31', reason: 'Already imported' }],
      failed: [{ externalId: 'p3', payDate: '2026-02-15', error: 'The period is locked' }],
    });
    const user = userEvent.setup();
    renderWithProviders(<PayrollConnectionsPage />);

    expect(screen.getByTestId('gusto-connection-prc_1')).toHaveTextContent('Last synced 2026-02-01');
    await user.click(screen.getByTestId('sync-open'));
    await user.type(await screen.findByLabelText('From (optional)'), '2026-01-01');
    await user.click(screen.getByTestId('sync-submit'));

    await waitFor(() => expect(syncAsync).toHaveBeenCalledWith({ id: 'prc_1', input: { from: '2026-01-01' } }));
    const result = await screen.findByTestId('sync-result');
    expect(within(result).getByTestId('sync-imported')).toHaveTextContent('1');
    expect(result).toHaveTextContent('Already imported');
    expect(result).toHaveTextContent('The period is locked');
    expect(within(result).getByRole('link', { name: '2026-01-15' })).toHaveAttribute('href', '/weldbooks/payroll/$id');
  });

  it('shows the last error of a connection that needs attention', () => {
    connections = [connection({ status: 'error', lastError: '1 payroll(s) could not be imported: The period is locked' })];
    renderWithProviders(<PayrollConnectionsPage />);
    expect(screen.getByText('Needs attention')).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('The period is locked');
  });

  it('offers no connecting or syncing without journal:create', () => {
    permissions.delete('journal:create');
    renderWithProviders(<PayrollConnectionsPage />);
    expect(screen.queryByTestId('gusto-connect-form')).not.toBeInTheDocument();
    expect(screen.queryByTestId('sync-open')).not.toBeInTheDocument();
  });
});

describe('Payroll import detail page', () => {
  beforeEach(() => {
    reverseAsync.mockReset().mockResolvedValue({});
    permissions.clear();
    ['journal:read', 'journal:create', 'journal:update', 'journal:delete'].forEach((permission) => permissions.add(permission));
    detail = {
      ...payroll('pri_1'),
      lines: [
        { accountId: 'acc_wages', accountCode: '6000', accountName: 'Wages', debit: '10000.00', credit: null, description: 'Payroll 2026-01-15: Gross wages' },
        { accountId: 'acc_bank', accountCode: '1000', accountName: 'Checking', debit: null, credit: '10000.00', description: 'Payroll 2026-01-15: Net pay' },
      ],
    };
  });

  it('shows the totals, the journal entry lines and where it came from', () => {
    renderWithProviders(<PayrollImportDetailPage />);
    expect(screen.getByRole('heading', { name: 'Payroll of 2026-01-15' })).toBeInTheDocument();
    expect(screen.getByText('Gross wages').nextElementSibling).toHaveTextContent('$10000.00');
    expect(screen.getByText('6000 — Wages')).toBeInTheDocument();
    expect(screen.getByText('1000 — Checking')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'View journal entry' })).toHaveAttribute('href', '/weldbooks/journal/$id');
    expect(screen.getByText(/january.csv/)).toBeInTheDocument();
  });

  it('reverses a posted payroll from its page', async () => {
    const user = userEvent.setup();
    renderWithProviders(<PayrollImportDetailPage />);
    await user.click(screen.getByTestId('reverse-open'));
    await user.click(await screen.findByTestId('reverse-submit'));
    await waitFor(() => expect(reverseAsync).toHaveBeenCalledWith({ id: 'pri_1', date: '2026-01-15' }));
  });

  it('offers no reversal for a payroll that was already reversed', () => {
    detail = { ...detail!, status: 'reversed' };
    renderWithProviders(<PayrollImportDetailPage />);
    expect(screen.queryByTestId('reverse-open')).not.toBeInTheDocument();
    expect(screen.getByText(/This payroll was reversed/)).toBeInTheDocument();
  });

  it('says so when the payroll does not exist', () => {
    detail = undefined;
    renderWithProviders(<PayrollImportDetailPage />);
    expect(screen.getByText('This payroll import does not exist.')).toBeInTheDocument();
  });
});
