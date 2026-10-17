import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { en } from '@weldsuite/i18n/locales/en';

const mocks = vi.hoisted(() => ({
  account: { data: undefined as unknown, isLoading: false, isError: false },
  update: vi.fn(),
  can: new Set<string>(),
  toast: { success: vi.fn(), error: vi.fn() },
  jurisdiction: { code: 'NL', features: { form1099: false } },
}));

vi.mock('@tanstack/react-router', () => ({
  Link: ({
    to,
    params: _params,
    children,
    ...rest
  }: {
    to: string;
    params?: Record<string, string>;
    children: React.ReactNode;
  }) => (
    <a href={to} {...rest}>
      {children}
    </a>
  ),
}));
vi.mock('sonner', () => ({ toast: mocks.toast }));
vi.mock('@weldsuite/permissions/react', () => ({
  usePermissions: () => ({ can: (permission: string) => mocks.can.has(permission) }),
}));
vi.mock('@/hooks/queries/use-accounting-queries', () => ({
  useAccountingAccount: () => mocks.account,
  useTaxLineCatalog: () => ({ data: undefined }),
  useUpdateAccount: () => ({
    isPending: false,
    mutate: (vars: unknown, options: { onSuccess?: () => void; onError?: (err: Error) => void }) =>
      mocks.update(vars, options),
  }),
}));
vi.mock('@/hooks/use-current-entity-currency', () => ({
  useCurrentEntityCurrency: () => ({
    formatMoney: (value: string | null) => `$${value ?? '0'}`,
    entityCurrency: 'USD',
  }),
}));
vi.mock('@/lib/weldbooks/use-jurisdiction', () => ({
  useCurrentJurisdiction: () => mocks.jurisdiction,
}));
vi.mock('@/hooks/use-workspace-url', () => ({ useWorkspaceUrl: () => (path: string) => `https://app.test${path}` }));
// Tab visibility is a per-user setting; the defaults are all these tests need.
vi.mock('@/hooks/queries/use-settings-queries', () => ({
  useGridViewSettings: () => ({ data: undefined, isLoading: false }),
  useUpdateGridView: () => ({ mutate: vi.fn() }),
}));
vi.mock('@/components/entity-audit-panel', () => ({
  EntityAuditPanel: ({ entityType, entityId }: { entityType: string; entityId: string }) => (
    <div data-testid="audit-panel">{`${entityType}:${entityId}`}</div>
  ),
}));

import { LedgerAccountPanel } from './ledger-account-panel';
import { installPointerPolyfills, renderWithProviders } from '@/app/weldbooks/sales-tax/setup/test-support';

const ta = en.accounting.accounts;

const account = {
  id: 'acc_1',
  code: '6100',
  name: 'Office supplies',
  type: 'expense',
  subtype: 'operating_expense',
  description: 'Pens and paper',
  normalSide: 'debit',
  isActive: true,
  isSystemAccount: false,
  openingBalance: '10',
  currentBalance: '125.50',
  currency: 'EUR',
};

function show(overrides: Record<string, unknown> = {}) {
  mocks.account = { data: { data: { ...account, ...overrides } }, isLoading: false, isError: false };
}

function renderPanel() {
  return renderWithProviders(
    <LedgerAccountPanel id="acc_1" isOpen onClose={vi.fn()} mode="fullscreen" onModeChange={vi.fn()} />,
  );
}

beforeAll(installPointerPolyfills);

beforeEach(() => {
  mocks.update.mockReset();
  mocks.toast.success.mockReset();
  mocks.toast.error.mockReset();
  mocks.can = new Set(['accounts:update']);
  mocks.jurisdiction = { code: 'NL', features: { form1099: false } };
  show();
});

describe('ledger account panel: details', () => {
  it('shows the account record with its balances', () => {
    renderPanel();

    // In the header and in the Name row.
    expect(screen.getAllByText('Office supplies')).toHaveLength(2);
    expect(screen.getByText('Pens and paper')).toBeInTheDocument();
    expect(screen.getByText(ta.types.expense)).toBeInTheDocument();
    expect(screen.getByText('operating expense')).toBeInTheDocument();
    expect(screen.getByText(ta.debit)).toBeInTheDocument();
    expect(screen.getByText('EUR')).toBeInTheDocument();
    expect(screen.getByText('$10')).toBeInTheDocument();
    expect(screen.getByText('$125.50')).toBeInTheDocument();
    expect(screen.queryByText(en.weldbooksUs.setup.accounts.reportingTitle)).not.toBeInTheDocument();
  });

  it('adds the tax reporting section for a US entity', () => {
    mocks.jurisdiction = { code: 'US', features: { form1099: true } };
    show({ taxLine: null, form1099Box: 'omit' });
    renderPanel();

    const tus = en.weldbooksUs.setup.accounts;
    expect(screen.getByText(tus.reportingTitle)).toBeInTheDocument();
    expect(screen.getByText(tus.form1099Omit)).toBeInTheDocument();
    expect(screen.getAllByText(tus.notSet).length).toBeGreaterThan(0);
  });

  it('links to the edit page', () => {
    renderPanel();
    expect(screen.getByRole('link', { name: ta.editing })).toHaveAttribute('href', '/weldbooks/accounts/$id/edit');
  });

  it('shows the audit trail of the account in the History tab', async () => {
    const user = userEvent.setup();
    renderPanel();

    await user.click(screen.getByRole('tab', { name: en.sweep.entities.auditLogTab }));
    expect(screen.getByTestId('audit-panel')).toHaveTextContent('account:acc_1');
  });

  it('says so when the account does not exist', () => {
    mocks.account = { data: undefined, isLoading: false, isError: false };
    renderPanel();
    expect(screen.getByText(ta.notFound)).toBeInTheDocument();
  });
});

describe('ledger account panel: deactivate and reactivate', () => {
  it('deactivates after a confirmation', async () => {
    const user = userEvent.setup();
    mocks.update.mockImplementation((_vars, options) => options.onSuccess?.());
    renderPanel();

    await user.click(screen.getByTestId('account-toggle-active'));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(ta.deactivateTitle)).toBeInTheDocument();
    expect(mocks.update).not.toHaveBeenCalled();

    await user.click(within(dialog).getByRole('button', { name: ta.deactivate }));
    expect(mocks.update).toHaveBeenCalledWith({ id: 'acc_1', data: { isActive: false } }, expect.any(Object));
    expect(mocks.toast.success).toHaveBeenCalledWith(ta.deactivated);
  });

  it("shows the server's reason when the account still has a balance", async () => {
    const user = userEvent.setup();
    mocks.update.mockImplementation((_vars, options) =>
      options.onError?.(new Error('This account still has a balance of 125.50. Clear the balance before deactivating it.')),
    );
    renderPanel();

    await user.click(screen.getByTestId('account-toggle-active'));
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: ta.deactivate }));
    await waitFor(() =>
      expect(mocks.toast.error).toHaveBeenCalledWith(ta.deactivateFailed, {
        description: 'This account still has a balance of 125.50. Clear the balance before deactivating it.',
      }),
    );
  });

  it('reactivates an inactive account and marks it as inactive', async () => {
    const user = userEvent.setup();
    show({ isActive: false });
    renderPanel();

    expect(screen.getByText(ta.inactive)).toBeInTheDocument();
    await user.click(screen.getByTestId('account-toggle-active'));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(ta.reactivateTitle)).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: ta.reactivate }));
    expect(mocks.update).toHaveBeenCalledWith({ id: 'acc_1', data: { isActive: true } }, expect.any(Object));
  });

  it('marks a system account, and does not offer to deactivate it', () => {
    show({ isSystemAccount: true });
    renderPanel();
    expect(screen.getByText(ta.system)).toBeInTheDocument();
    expect(screen.queryByTestId('account-toggle-active')).not.toBeInTheDocument();
  });

  it('does not offer deactivation without accounts:update', () => {
    mocks.can = new Set();
    renderPanel();
    expect(screen.queryByTestId('account-toggle-active')).not.toBeInTheDocument();
  });

  it('still lets an inactive system account be reactivated', () => {
    show({ isSystemAccount: true, isActive: false });
    renderPanel();
    expect(screen.getByTestId('account-toggle-active')).toBeInTheDocument();
  });
});
