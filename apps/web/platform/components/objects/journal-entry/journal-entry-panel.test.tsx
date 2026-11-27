import type { ReactElement, ReactNode } from 'react';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { I18nProvider } from '@weldsuite/i18n/provider';
import type { JournalEntryDetail } from '@/lib/api/domains/weldbooks';

const postMutate = vi.fn();
const reverseMutate = vi.fn();
const deleteMutate = vi.fn();
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
const panelOpen = vi.hoisted(() => vi.fn());
const permissions = new Set(['journal:read', 'journal:update']);
const journal: { entry: JournalEntryDetail | undefined; isLoading: boolean } = {
  entry: undefined,
  isLoading: false,
};

vi.mock('sonner', () => ({ toast }));
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
  useObjectPanel: () => ({ stack: [], open: panelOpen }),
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
  usePostJournalEntry: () => ({ mutateAsync: postMutate, isPending: false }),
  useReverseJournalEntry: () => ({ mutateAsync: reverseMutate, isPending: false }),
  useDeleteJournalEntry: () => ({ mutateAsync: deleteMutate, isPending: false }),
  useAccountingAccounts: () => ({
    data: { data: [{ id: 'acc_cash', code: '1000', name: 'Cash', type: 'asset', isActive: true }] },
  }),
  useDimensionValues: () => ({ data: [{ id: 'dim_east', name: 'East' }] }),
}));

import { JournalEntryPanel } from './journal-entry-panel';
import { installPointerPolyfills } from '@/app/weldbooks/sales-tax/setup/test-support';

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

const panelProps = { id: 'je_1', isOpen: true, onClose: vi.fn<() => void>() };

describe('JournalEntryPanel', () => {
  beforeAll(installPointerPolyfills);
  beforeEach(() => {
    postMutate.mockReset().mockResolvedValue({ data: {} });
    reverseMutate.mockReset().mockResolvedValue({ data: { id: 'je_2', entryNumber: 'JE-0002' } });
    deleteMutate.mockReset().mockResolvedValue(undefined);
    toast.success.mockReset();
    toast.error.mockReset();
    panelProps.onClose.mockReset();
    panelOpen.mockReset();
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
    // A source without a panel (or an unknown one) is translated text, not a raw value.
    expect(screen.getByText('bank import')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'bank import' })).not.toBeInTheDocument();
    expect(screen.getByText('Auto-generated')).toBeInTheDocument();
  });

  it('shows the record that posted the entry as a chip that stacks its panel', async () => {
    const user = userEvent.setup();
    journal.entry = entry({ sourceType: 'invoice', sourceId: 'inv_9' });
    renderPanel(<JournalEntryPanel {...panelProps} />);

    const chip = screen.getByRole('link', { name: 'Invoice' });
    expect(chip.getAttribute('href')).toContain('stack=invoice%3Ainv_9');
    await user.click(chip);
    expect(panelOpen).toHaveBeenCalledWith({ type: 'invoice', id: 'inv_9', stack: true });
  });

  it('names a manual entry as Manual entry', () => {
    journal.entry = entry({ sourceType: 'manual', sourceId: null });
    renderPanel(<JournalEntryPanel {...panelProps} />);
    expect(screen.getByText('Manual entry')).toBeInTheDocument();
  });

  it('lists the journal lines with the account, the side of the amount and the dimensions', async () => {
    const user = userEvent.setup();
    renderPanel(<JournalEntryPanel {...panelProps} />);
    await user.click(screen.getByRole('tab', { name: /Journal lines/ }));

    // The account of a line is a chip that stacks the ledger account.
    const cash = screen.getByRole('link', { name: '1000 — Cash' });
    await user.click(cash);
    expect(panelOpen).toHaveBeenCalledWith({ type: 'ledger_account', id: 'acc_cash', stack: true });
    expect(screen.getByText('Cash in')).toBeInTheDocument();
    expect(screen.getByText('Class: East')).toBeInTheDocument();
    // An account that is not in the chart is never shown by its id.
    expect(screen.getByRole('link', { name: 'Ledger account' })).toBeInTheDocument();
    expect(screen.queryByText('acc_equity')).not.toBeInTheDocument();
    expect(screen.getAllByText('$250.00').length).toBeGreaterThanOrEqual(2);
    const totals = screen.getByText('Totals').parentElement as HTMLElement;
    expect(within(totals).getByText('Debit').nextElementSibling).toHaveTextContent('$250.00');
    expect(within(totals).getByText('Credit').nextElementSibling).toHaveTextContent('$250.00');
  });

  it('says so when the entry has no lines', async () => {
    const user = userEvent.setup();
    journal.entry = entry({ lines: [] });
    renderPanel(<JournalEntryPanel {...panelProps} />);
    await user.click(screen.getByRole('tab', { name: /Journal lines/ }));
    expect(screen.getByText('No lines')).toBeInTheDocument();
  });

  it('posts a draft entry after a confirmation, and says so', async () => {
    const user = userEvent.setup();
    renderPanel(<JournalEntryPanel {...panelProps} />);

    await user.click(screen.getByRole('button', { name: 'Post entry' }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('Post JE-0001?');
    expect(postMutate).not.toHaveBeenCalled();

    await user.click(within(dialog).getByRole('button', { name: 'Post entry' }));
    await waitFor(() => expect(postMutate).toHaveBeenCalledWith('je_1'));
    expect(toast.success).toHaveBeenCalledWith('Journal entry JE-0001 posted');
  });

  it('deletes a draft entry after a confirmation and closes the panel', async () => {
    const user = userEvent.setup();
    permissions.add('journal:delete');
    renderPanel(<JournalEntryPanel {...panelProps} />);

    await user.click(screen.getByRole('button', { name: 'More actions' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Delete draft' }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Delete draft' }));

    await waitFor(() => expect(deleteMutate).toHaveBeenCalledWith('je_1'));
    expect(toast.success).toHaveBeenCalledWith('Draft journal entry deleted');
    expect(panelProps.onClose).toHaveBeenCalled();
  });

  it('reverses a posted manual entry after a confirmation', async () => {
    const user = userEvent.setup();
    permissions.add('journal:create');
    journal.entry = entry({ status: 'posted', sourceType: 'manual', isAutomatic: false, sourceId: null });
    renderPanel(<JournalEntryPanel {...panelProps} />);

    await user.click(screen.getByRole('button', { name: 'Reverse' }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Reverse' }));

    await waitFor(() => expect(reverseMutate).toHaveBeenCalledWith('je_1'));
    expect(toast.success).toHaveBeenCalledWith('Reversed with JE-0002');
  });

  it('offers no reversal of an entry a document posted, nor a delete of a posted one', async () => {
    const user = userEvent.setup();
    permissions.add('journal:create');
    permissions.add('journal:delete');
    journal.entry = entry({ status: 'posted', sourceType: 'invoice', isAutomatic: true, sourceId: 'inv_1' });
    renderPanel(<JournalEntryPanel {...panelProps} />);

    expect(screen.queryByRole('button', { name: 'Reverse' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'More actions' }));
    expect(await screen.findByRole('menuitem', { name: 'Copy link' })).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: 'Delete draft' })).not.toBeInTheDocument();
  });

  it('offers no posting for a posted entry, or without journal:update', () => {
    journal.entry = entry({ status: 'posted' });
    const { unmount } = renderPanel(<JournalEntryPanel {...panelProps} />);
    expect(screen.queryByRole('button', { name: 'Post entry' })).not.toBeInTheDocument();
    expect(screen.getByTestId('title')).toHaveTextContent('Posted');
    unmount();

    journal.entry = entry();
    permissions.delete('journal:update');
    renderPanel(<JournalEntryPanel {...panelProps} />);
    expect(screen.queryByRole('button', { name: 'Post entry' })).not.toBeInTheDocument();
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
