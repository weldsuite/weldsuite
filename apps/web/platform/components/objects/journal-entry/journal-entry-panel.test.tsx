import type { ReactElement, ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { I18nProvider } from '@weldsuite/i18n/provider';
import type { JournalEntryDetail } from '@/lib/api/domains/weldbooks';

const postMutate = vi.fn();
const permissions = new Set(['journal:read', 'journal:update']);
const journal: { entry: JournalEntryDetail | undefined; isLoading: boolean } = {
  entry: undefined,
  isLoading: false,
};

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('@weldsuite/permissions/react', () => ({
  usePermissions: () => ({ can: (permission: string) => permissions.has(permission) }),
}));
vi.mock('@/hooks/use-workspace-url', () => ({ useWorkspaceUrl: () => (path: string) => `https://app.test${path}` }));
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
vi.mock('@/lib/weldbooks/use-weldbooks-format', () => ({
  useWeldbooksFormat: () => ({
    formatMoney: (value: number | string | null) => `$${Number(value).toFixed(2)}`,
    formatDate: (value: string | null) => value ?? '',
  }),
}));
vi.mock('@/hooks/queries/use-accounting-queries', () => ({
  useAccountingJournalEntry: () => ({
    data: journal.entry ? { data: journal.entry } : undefined,
    isLoading: journal.isLoading,
    isError: false,
  }),
  usePostJournalEntry: () => ({ mutate: postMutate, isPending: false }),
  useAccountingAccounts: () => ({
    data: { data: [{ id: 'acc_cash', code: '1000', name: 'Cash', type: 'asset', isActive: true }] },
  }),
  useDimensionValues: () => ({ data: [{ id: 'dim_east', name: 'East' }] }),
}));

import { JournalEntryPanel } from './journal-entry-panel';

function renderPanel(ui: ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <I18nProvider initialLanguage="en">{ui}</I18nProvider>
    </QueryClientProvider>,
  );
}

const entry = (overrides: Partial<JournalEntryDetail> = {}): JournalEntryDetail => ({
  id: 'je_1',
  entryNumber: 'JE-0001',
  date: '2026-02-03',
  status: 'draft',
  description: 'Opening balance',
  totalDebit: '250.00',
  totalCredit: '250.00',
  sourceType: 'bank_import',
  isAutomatic: true,
  lines: [
    {
      id: 'l1',
      journalEntryId: 'je_1',
      accountId: 'acc_cash',
      description: 'Cash in',
      debit: '250.00',
      credit: '0.00',
      taxRateId: null,
      taxAmount: null,
      contactId: null,
      currency: 'USD',
      reconciled: false,
      sortOrder: 0,
      classId: 'dim_east',
    } as JournalEntryDetail['lines'][number],
    {
      id: 'l2',
      journalEntryId: 'je_1',
      accountId: 'acc_equity',
      description: null,
      debit: '0.00',
      credit: '250.00',
      taxRateId: null,
      taxAmount: null,
      contactId: null,
      currency: 'USD',
      reconciled: false,
      sortOrder: 1,
    },
  ],
  ...overrides,
});

const panelProps = { id: 'je_1', isOpen: true, onClose: vi.fn() };

describe('JournalEntryPanel', () => {
  beforeEach(() => {
    postMutate.mockReset();
    permissions.clear();
    permissions.add('journal:read');
    permissions.add('journal:update');
    journal.entry = entry();
    journal.isLoading = false;
  });

  it('shows the entry number and status, with the totals, date, description and source', () => {
    renderPanel(<JournalEntryPanel {...panelProps} />);

    const title = screen.getByTestId('title');
    expect(title).toHaveTextContent('JE-0001');
    expect(title).toHaveTextContent('Draft');
    expect(screen.getByText('Debit').parentElement?.nextElementSibling).toHaveTextContent('$250.00');
    expect(screen.getByText('Credit').parentElement?.nextElementSibling).toHaveTextContent('$250.00');
    expect(screen.getByText('2026-02-03')).toBeInTheDocument();
    expect(screen.getByText('Opening balance')).toBeInTheDocument();
    expect(screen.getByText('bank import')).toBeInTheDocument();
    expect(screen.getByText('Auto-generated')).toBeInTheDocument();
  });

  it('lists the journal lines with the account, the side of the amount and the dimensions', async () => {
    const user = userEvent.setup();
    renderPanel(<JournalEntryPanel {...panelProps} />);
    await user.click(screen.getByRole('tab', { name: /Journal Lines/ }));

    expect(screen.getByText('1000 — Cash')).toBeInTheDocument();
    expect(screen.getByText('Cash in')).toBeInTheDocument();
    expect(screen.getByText('Class: East')).toBeInTheDocument();
    // An account that is not in the chart falls back to its id.
    expect(screen.getByText('acc_equity')).toBeInTheDocument();
    expect(screen.getAllByText('$250.00').length).toBeGreaterThanOrEqual(2);
    const totals = screen.getByText('Totals').parentElement as HTMLElement;
    expect(within(totals).getByText('Debit').nextElementSibling).toHaveTextContent('$250.00');
    expect(within(totals).getByText('Credit').nextElementSibling).toHaveTextContent('$250.00');
  });

  it('says so when the entry has no lines', async () => {
    const user = userEvent.setup();
    journal.entry = entry({ lines: [] });
    renderPanel(<JournalEntryPanel {...panelProps} />);
    await user.click(screen.getByRole('tab', { name: /Journal Lines/ }));
    expect(screen.getByText('No lines')).toBeInTheDocument();
  });

  it('posts a draft entry', async () => {
    const user = userEvent.setup();
    renderPanel(<JournalEntryPanel {...panelProps} />);

    await user.click(screen.getByRole('button', { name: 'Post Entry' }));
    expect(postMutate).toHaveBeenCalledWith('je_1', expect.any(Object));
  });

  it('offers no posting for a posted entry, or without journal:update', () => {
    journal.entry = entry({ status: 'posted' });
    const { unmount } = renderPanel(<JournalEntryPanel {...panelProps} />);
    expect(screen.queryByRole('button', { name: 'Post Entry' })).not.toBeInTheDocument();
    expect(screen.getByTestId('title')).toHaveTextContent('Posted');
    unmount();

    journal.entry = entry();
    permissions.delete('journal:update');
    renderPanel(<JournalEntryPanel {...panelProps} />);
    expect(screen.queryByRole('button', { name: 'Post Entry' })).not.toBeInTheDocument();
  });

  it('reads the audit trail of the entry on the history tab', async () => {
    const user = userEvent.setup();
    renderPanel(<JournalEntryPanel {...panelProps} />);
    await user.click(screen.getByRole('tab', { name: 'Audit Log' }));
    expect(screen.getByTestId('audit')).toHaveAttribute('data-entity-type', 'journal_entry');
    expect(screen.getByTestId('audit')).toHaveAttribute('data-entity-id', 'je_1');
  });

  it('says so when the entry does not exist', () => {
    journal.entry = undefined;
    renderPanel(<JournalEntryPanel {...panelProps} />);
    expect(screen.getByText('Journal entry not found.')).toBeInTheDocument();
  });
});
