import type { ReactElement, ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { I18nProvider } from '@weldsuite/i18n/provider';
import type { BankDepositDetail } from '@/lib/api/domains/weldbooks-banking';

const voidMutateAsync = vi.fn();
const memoMutate = vi.fn();
const openPanel = vi.fn();
const permissions = new Set(['banking:update']);
const jurisdiction: { code: string | null; isError: boolean } = { code: 'US', isError: false };
const deposit: { current: BankDepositDetail | undefined; requestedId: string | undefined } = {
  current: undefined,
  requestedId: undefined,
};

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('@weldsuite/permissions/react', () => ({
  usePermissions: () => ({ can: (permission: string) => permissions.has(permission) }),
}));
vi.mock('@/hooks/use-workspace-url', () => ({ useWorkspaceUrl: () => (path: string) => `https://app.test${path}` }));
vi.mock('@/lib/weldbooks/use-jurisdiction', () => ({
  useCurrentJurisdiction: () => ({ code: jurisdiction.code, isError: jurisdiction.isError }),
}));
vi.mock('@/lib/weldbooks/use-weldbooks-format', () => ({
  useWeldbooksFormat: () => ({
    formatMoney: (value: number | string) => `$${Number(value).toFixed(2)}`,
    formatDate: (value: string) => value,
    entityCurrency: 'USD',
  }),
}));
vi.mock('@/hooks/queries/use-weldbooks-banking-queries', () => ({
  useBankDeposit: (id: string | undefined) => {
    deposit.requestedId = id;
    return { data: id ? deposit.current : undefined, isLoading: false, isError: false };
  },
  useUpdateBankDepositMemo: () => ({ mutate: memoMutate, isPending: false }),
  useVoidBankDeposit: () => ({ mutateAsync: voidMutateAsync, isPending: false }),
}));
vi.mock('@weldsuite/ui/components/drawer-field-settings', () => ({ DrawerFieldSettings: () => null }));
vi.mock('@weldsuite/ui/components/entity-detail-view', () => ({
  EntityDetailView: ({
    title,
    actions,
    tabs,
    children,
  }: {
    title: ReactNode;
    actions: ReactNode;
    tabs: ReactNode;
    children: ReactNode;
  }) => (
    <div>
      <header>
        <div data-testid="title">{title}</div>
        {actions}
      </header>
      {tabs}
      <main>{children}</main>
    </div>
  ),
}));
vi.mock('@/components/object-panel', () => ({
  useObjectPanel: () => ({ open: openPanel }),
  useObjectPanelShell: () => ({ mode: 'fullscreen', setMode: vi.fn(), entityDetailViewProps: {} }),
  useObjectPanelTabConfig: () => ({
    visibility: {},
    isVisible: () => true,
    toggle: vi.fn(),
    resetToDefaults: vi.fn(),
  }),
  ObjectPanelTabs: ({
    tabs,
    activeTab,
    onChange,
  }: {
    tabs: { id: string; label: string }[];
    activeTab: string;
    onChange: (id: string) => void;
  }) => (
    <div role="tablist">
      {tabs.map((tab) => (
        <button key={tab.id} role="tab" aria-selected={tab.id === activeTab} onClick={() => onChange(tab.id)}>
          {tab.label}
        </button>
      ))}
    </div>
  ),
}));
vi.mock('@/components/entity-audit-panel', () => ({
  EntityAuditPanel: ({ entityType, entityId }: { entityType: string; entityId: string }) => (
    <div data-testid="audit" data-entity-type={entityType} data-entity-id={entityId} />
  ),
}));

import { DepositPanel } from './deposit-panel';

function renderPanel(ui: ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <I18nProvider initialLanguage="en">{ui}</I18nProvider>
    </QueryClientProvider>,
  );
}

function makeDeposit(overrides: Partial<BankDepositDetail> = {}): BankDepositDetail {
  return {
    id: 'dep_1',
    bankAccountId: 'ba_1',
    date: '2026-01-06',
    amount: '1550.50',
    currency: 'USD',
    memo: 'January checks',
    status: 'posted',
    journalEntryId: 'je_1',
    bankTransactionId: null,
    createdBy: null,
    createdAt: '2026-01-06T10:00:00Z',
    bankAccountName: 'Operating',
    journalEntryNumber: 'JE-0007',
    payments: [
      { id: 'pay_1', date: '2026-01-05', amount: '1200.00', currency: 'USD', paymentMethod: 'check', checkNumber: '1001', reference: null, contactId: 'c1', contactName: 'Acme', invoiceId: 'inv_1' },
      { id: 'pay_2', date: '2026-01-06', amount: '350.50', currency: 'USD', paymentMethod: 'cash', checkNumber: null, reference: null, contactId: 'c2', contactName: 'Bolt', invoiceId: null },
    ],
    otherLines: [],
    ...overrides,
  };
}

const panelProps = { id: 'dep_1', isOpen: true, onClose: vi.fn() };

async function openPayments(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('tab', { name: /Payments/ }));
}

describe('DepositPanel', () => {
  beforeEach(() => {
    voidMutateAsync.mockReset();
    voidMutateAsync.mockResolvedValue(undefined);
    memoMutate.mockReset();
    openPanel.mockReset();
    permissions.clear();
    permissions.add('banking:update');
    jurisdiction.code = 'US';
    jurisdiction.isError = false;
    deposit.current = makeDeposit();
  });

  it('shows the amount and status, with the deposit details and the journal entry it posted', () => {
    renderPanel(<DepositPanel {...panelProps} />);

    const title = screen.getByTestId('title');
    expect(title).toHaveTextContent('$1550.50');
    expect(title).toHaveTextContent('Posted');
    expect(screen.getByText('2026-01-06')).toBeInTheDocument();
    expect(screen.getByText('Operating')).toBeInTheDocument();
    expect(screen.getByText('Not matched yet')).toBeInTheDocument();
    expect(screen.getByText('January checks')).toBeInTheDocument();
  });

  it('opens the journal entry in its own panel on top of the deposit', async () => {
    const user = userEvent.setup();
    renderPanel(<DepositPanel {...panelProps} />);

    await user.click(screen.getByRole('button', { name: 'JE-0007' }));
    expect(openPanel).toHaveBeenCalledWith({ type: 'journal_entry', id: 'je_1', stack: true });
  });

  it('lists the payments of the deposit with their subtotal', async () => {
    const user = userEvent.setup();
    renderPanel(<DepositPanel {...panelProps} />);
    await openPayments(user);

    expect(screen.getByText('Acme')).toBeInTheDocument();
    expect(screen.getByText('Check · #1001')).toBeInTheDocument();
    expect(screen.getByText('Bolt')).toBeInTheDocument();
    const subtotal = screen.getByText('Payments', { selector: 'span' }).parentElement as HTMLElement;
    expect(subtotal).toHaveTextContent('$1550.50');
  });

  it('lists the other lines of a deposit with the account and amount', async () => {
    const user = userEvent.setup();
    deposit.current = makeDeposit({
      payments: [],
      otherLines: [
        { accountId: 'acc_1', accountCode: '6100', accountName: 'Bank fees', amount: -25, description: 'Slip fee' },
      ],
    });
    renderPanel(<DepositPanel {...panelProps} />);
    await openPayments(user);

    expect(screen.getByText('This deposit has no payments, only other lines.')).toBeInTheDocument();
    expect(screen.getByText('6100 — Bank fees')).toBeInTheDocument();
    expect(screen.getByText('Slip fee')).toBeInTheDocument();
    expect(screen.getByText('$-25.00')).toBeInTheDocument();
  });

  it('voids the deposit after a confirmation', async () => {
    const user = userEvent.setup();
    renderPanel(<DepositPanel {...panelProps} />);

    await user.click(screen.getByTestId('void-deposit'));
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('its payments go back to Undeposited Funds');
    expect(voidMutateAsync).not.toHaveBeenCalled();
    await user.click(within(dialog).getByRole('button', { name: 'Void deposit' }));
    expect(voidMutateAsync).toHaveBeenCalledWith('dep_1');
  });

  it('saves a changed memo', async () => {
    const user = userEvent.setup();
    renderPanel(<DepositPanel {...panelProps} />);

    await user.click(screen.getByRole('button', { name: 'Memo' }));
    const input = screen.getByDisplayValue('January checks');
    await user.type(input, ' (late){Enter}');
    expect(memoMutate).toHaveBeenCalledWith(
      { id: 'dep_1', memo: 'January checks (late)' },
      expect.any(Object),
    );
  });

  it('cannot be voided or edited once void, or without banking:update', () => {
    deposit.current = makeDeposit({ status: 'void' });
    const { unmount } = renderPanel(<DepositPanel {...panelProps} />);
    expect(screen.queryByTestId('void-deposit')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Memo' })).not.toBeInTheDocument();
    expect(screen.getByTestId('title')).toHaveTextContent('Void');
    unmount();

    deposit.current = makeDeposit();
    permissions.clear();
    renderPanel(<DepositPanel {...panelProps} />);
    expect(screen.queryByTestId('void-deposit')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Memo' })).not.toBeInTheDocument();
  });

  it('shows the matched marker once a bank line is matched', () => {
    deposit.current = makeDeposit({ bankTransactionId: 'bt_1' });
    renderPanel(<DepositPanel {...panelProps} />);
    expect(screen.getByTestId('title')).toHaveTextContent('Matched');
    expect(screen.getByText('Matched to a bank line')).toBeInTheDocument();
  });

  it('reads the audit trail of the deposit on the history tab', async () => {
    const user = userEvent.setup();
    renderPanel(<DepositPanel {...panelProps} />);
    await user.click(screen.getByRole('tab', { name: 'Audit Log' }));
    expect(screen.getByTestId('audit')).toHaveAttribute('data-entity-type', 'bank_deposit');
    expect(screen.getByTestId('audit')).toHaveAttribute('data-entity-id', 'dep_1');
  });

  it('says so when the deposit does not exist', () => {
    deposit.current = undefined;
    renderPanel(<DepositPanel {...panelProps} />);
    expect(screen.getByText('This deposit was not found.')).toBeInTheDocument();
  });

  it('shows the US-only notice, without fetching, for an entity of another country', () => {
    jurisdiction.code = 'NL';
    renderPanel(<DepositPanel {...panelProps} />);
    expect(screen.getByText('Deposits are for US entities')).toBeInTheDocument();
    expect(deposit.requestedId).toBeUndefined();
  });
});
