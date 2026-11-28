import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { BankLine, BankLineLinks } from '@/lib/api/domains/weldbooks-banking';

const env = vi.hoisted(() => ({
  expanded: true,
  questions: true,
  processing: false,
  undo: vi.fn(),
  saveNotes: vi.fn(),
  transfer: vi.fn(),
  markPrivate: vi.fn(),
  links: undefined as unknown,
  line: undefined as unknown,
  linksEnabled: [] as boolean[],
  lineEnabled: [] as boolean[],
  unreconcile: vi.fn(),
  exclude: vi.fn(),
  push: vi.fn(),
  toast: { success: vi.fn(), error: vi.fn() },
  permissions: new Set<string>(['banking:update']),
}));

vi.mock('sonner', () => ({ toast: env.toast }));
vi.mock('@weldsuite/permissions/react', () => ({
  usePermissions: () => ({ can: (permission: string) => env.permissions.has(permission) }),
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
vi.mock('@/components/object-panel', () => import('@/components/objects/_shared/object-panel-test-mock'));
vi.mock('@/components/entity-audit-panel', () => ({
  EntityAuditPanel: ({ entityType, entityId }: { entityType: string; entityId: string }) => (
    <div data-testid="audit" data-entity-type={entityType} data-entity-id={entityId} />
  ),
}));
vi.mock('@/lib/edition', () => ({
  isFeatureAvailable: (feature: string) => {
    if (feature === 'books-questions') return env.questions;
    return feature === 'books-bank-processing' ? env.processing : env.expanded;
  },
}));
vi.mock('@/components/accounting/questions/record-question-chat', () => ({
  RecordQuestionChat: ({ recordType, recordId }: { recordType: string; recordId: string }) => (
    <div data-testid="record-question-chat" data-type={recordType} data-id={recordId} />
  ),
}));

vi.mock('@/hooks/queries/use-weldbooks-processing-queries', () => ({
  useUndoBankLine: () => ({ mutateAsync: env.undo, isPending: false }),
  useUpdateBankLineNotes: () => ({ mutate: env.saveNotes, isPending: false }),
  useTransferBankLine: () => ({ mutateAsync: env.transfer, isPending: false }),
  usePrivateBankLine: () => ({ mutateAsync: env.markPrivate, isPending: false }),
}));
vi.mock('@/lib/router', () => ({ useRouter: () => ({ push: env.push }) }));
vi.mock('@/lib/weldbooks/use-weldbooks-format', () => ({
  useWeldbooksFormat: () => ({
    formatMoney: (value: unknown, currency?: string | null) => `${currency === 'USD' ? '$' : '€'}${Number(value ?? 0).toFixed(2)}`,
    formatDate: (value: string | null) => value ?? '',
    entityCurrency: 'EUR',
  }),
}));
vi.mock('@/hooks/queries/use-weldbooks-banking-queries', () => ({
  useBankLineLinks: (_id: string, options: { enabled?: boolean } = {}) => {
    env.linksEnabled.push(options.enabled ?? true);
    return {
      data: options.enabled === false ? undefined : env.links,
      isLoading: false,
      isError: false,
    };
  },
  useBankLine: (_id: string, options: { enabled?: boolean } = {}) => {
    env.lineEnabled.push(options.enabled ?? true);
    return { data: options.enabled === false ? undefined : env.line, isLoading: false, isError: false };
  },
  useBankAccount: () => ({ data: { data: { id: 'ba_1', name: 'Business account', currency: 'EUR' } } }),
  useUnreconcileBankLine: () => ({ mutateAsync: env.unreconcile, isPending: false }),
  useExcludeBankLine: () => ({ mutateAsync: env.exclude, isPending: false }),
}));
vi.mock('@/hooks/queries/use-accounting-queries', () => ({
  useAccountingInvoice: (id: string) => ({
    data: id ? { data: { id, invoiceNumber: 'INV-2026-7', contactId: 'ct_1', contactName: 'Acme', status: 'paid', total: '150.00' } } : undefined,
  }),
  useAccountingBill: (id: string) => ({
    data: id ? { data: { id, billNumber: 'BILL-9', contactId: 'ct_2', contactName: 'Vendor', status: 'paid', total: '80.00' } } : undefined,
  }),
  useAccountingAccounts: () => ({
    data: { data: [{ id: 'acc_4000', code: '4000', name: 'Sales', type: 'revenue', isActive: true }] },
  }),
  useAccountingContactNames: (ids: string[]) => new Map(ids.map((id) => [id, 'Acme Industries'])),
}));

import { BankTransactionPanel } from './bank-transaction-panel';
import { panelOpen } from '@/components/objects/_shared/object-panel-test-mock';
import { processedAsOf, linksFromLine } from './use-bank-transaction-links';
import { renderWithProviders } from '@/app/weldbooks/invoices/components/test-utils';

function line(overrides: Partial<BankLine> = {}): BankLine {
  return {
    id: 'bt_1',
    bankAccountId: 'ba_1',
    date: '2026-03-02',
    description: 'INV-2026-7 Acme remittance',
    amount: '150.00',
    counterpartyName: 'Acme Industries',
    counterpartyIban: 'NL91ABNA0417164300',
    reference: 'REF-1',
    status: 'reconciled',
    source: 'import',
    notes: 'Paid after reminder',
    ...overrides,
  } as BankLine;
}

function links(overrides: Partial<BankLineLinks> = {}): BankLineLinks {
  return {
    transaction: line(),
    processedAs: 'payment',
    payment: { id: 'pay_1', type: 'received', amount: '150.00', currency: 'EUR', date: '2026-03-02', method: 'bank_transfer', reference: 'REF-1', journalEntryId: 'je_1' },
    allocations: [
      { documentType: 'invoice', documentId: 'inv_1', number: 'INV-2026-7', contactId: 'ct_1', contactName: 'Acme', amount: '150.00', status: 'paid' },
    ],
    journalEntry: { id: 'je_1', entryNumber: 'JE-0042', date: '2026-03-02', description: 'Payment', sourceType: 'payment', sourceId: 'pay_1' },
    deposit: null,
    category: null,
    contact: { id: 'ct_1', name: 'Acme Industries' },
    documents: [{ id: 'doc_1', fileName: 'remittance.pdf', type: 'receipt', status: 'linked' }],
    ...overrides,
  };
}

function renderPanel() {
  return renderWithProviders(<BankTransactionPanel id="bt_1" isOpen onClose={vi.fn()} />);
}

describe('BankTransactionPanel', () => {
  beforeEach(() => {
    env.expanded = true;
    env.questions = true;
    env.processing = false;
    env.undo.mockReset().mockResolvedValue({});
    env.saveNotes.mockReset();
    env.transfer.mockReset().mockResolvedValue({});
    env.markPrivate.mockReset().mockResolvedValue({});
    env.links = links();
    env.line = undefined;
    env.linksEnabled.length = 0;
    env.lineEnabled.length = 0;
    env.unreconcile.mockReset().mockResolvedValue({});
    env.exclude.mockReset().mockResolvedValue({});
    env.push.mockReset();
    env.toast.success.mockReset();
    env.toast.error.mockReset();
    env.permissions = new Set(['banking:update']);
    panelOpen.mockReset();
  });

  it('shows the amount with its sign in green, the status and the line summary', () => {
    renderPanel();
    const amount = screen.getByTestId('bank-transaction-amount');
    expect(amount).toHaveTextContent('+€150.00');
    expect(amount.className).toContain('emerald');
    expect(screen.getByTestId('title')).toHaveTextContent('Matched');
    // The counterparty of the summary, and the contact chip under Connections.
    expect(screen.getAllByText('Acme Industries')).toHaveLength(2);
    expect(screen.getByText('Business account')).toBeInTheDocument();
    // The description is monospace.
    expect(screen.getByText('INV-2026-7 Acme remittance').className).toContain('font-mono');
    expect(screen.getByText('NL91ABNA0417164300')).toBeInTheDocument();
    expect(screen.getByText('Statement import')).toBeInTheDocument();
    expect(screen.getByText('Paid after reminder')).toBeInTheDocument();
  });

  it('does not colour or sign money out', () => {
    env.links = links({ transaction: line({ amount: '-80.00' }), allocations: [], payment: null, processedAs: 'category' });
    renderPanel();
    const amount = screen.getByTestId('bank-transaction-amount');
    expect(amount).toHaveTextContent('€-80.00');
    expect(amount.className).not.toContain('emerald');
  });

  it('reads the links route where the edition has it, and not the bare row', () => {
    renderPanel();
    expect(env.linksEnabled.every(Boolean)).toBe(true);
    expect(env.lineEnabled.every((enabled) => enabled === false)).toBe(true);
  });

  it('shows what the line is connected to, each as a chip that stacks that record', async () => {
    const user = userEvent.setup();
    renderPanel();

    const invoice = screen.getByRole('link', { name: /INV-2026-7/ });
    await user.click(invoice);
    expect(panelOpen).toHaveBeenLastCalledWith({ type: 'invoice', id: 'inv_1', stack: true });

    await user.click(screen.getByRole('link', { name: /JE-0042/ }));
    expect(panelOpen).toHaveBeenLastCalledWith({ type: 'journal_entry', id: 'je_1', stack: true });

    const contacts = screen.getAllByRole('link', { name: 'Acme Industries' });
    await user.click(contacts[0]);
    expect(panelOpen).toHaveBeenLastCalledWith({ type: 'weldbooks_contact', id: 'ct_1', stack: true });

    // The payment itself has no panel: its method, date and amount are text.
    expect(screen.getByText(/Bank transfer|bank_transfer/)).toBeInTheDocument();
  });

  it('opens an inbox document on the documents page without leaving a stale panel', async () => {
    const user = userEvent.setup();
    renderPanel();
    const chip = screen.getByRole('link', { name: 'remittance.pdf' });
    expect(chip.getAttribute('href')).toBe('/weldbooks/documents?document=doc_1');
    await user.click(chip);
    expect(env.push).toHaveBeenCalledWith('/weldbooks/documents?document=doc_1');
  });

  it('shows the invoices a line settled even when no payment record exists (an import)', () => {
    env.links = links({ payment: null, journalEntry: null, contact: null, documents: [] });
    renderPanel();
    expect(screen.getByRole('link', { name: /INV-2026-7/ })).toBeInTheDocument();
    expect(screen.queryByText('Nothing is connected to this transaction yet.')).not.toBeInTheDocument();
  });

  it('shows the category as a ledger account chip with its VAT rate, and the deposit', async () => {
    const user = userEvent.setup();
    env.links = links({
      processedAs: 'category',
      payment: null,
      allocations: [],
      journalEntry: null,
      contact: null,
      documents: [],
      category: { accountId: 'acc_4000', accountCode: '4000', accountName: 'Sales', taxRateId: 'tax_1', taxRateName: 'VAT 21%' },
      deposit: { id: 'dep_1', date: '2026-03-01', amount: '150.00', reference: 'Deposit March' },
    });
    renderPanel();
    await user.click(screen.getByRole('link', { name: '4000 — Sales' }));
    expect(panelOpen).toHaveBeenLastCalledWith({ type: 'ledger_account', id: 'acc_4000', stack: true });
    expect(screen.getByText('VAT 21%')).toBeInTheDocument();
    await user.click(screen.getByRole('link', { name: /Deposit March/ }));
    expect(panelOpen).toHaveBeenLastCalledWith({ type: 'deposit', id: 'dep_1', stack: true });
  });

  it('says so when nothing is connected', () => {
    env.links = links({ processedAs: 'unprocessed', payment: null, allocations: [], journalEntry: null, contact: null, documents: [] });
    renderPanel();
    expect(screen.getByText('Nothing is connected to this transaction yet.')).toBeInTheDocument();
  });

  it('has a History tab that shows the audit log of the line', async () => {
    const user = userEvent.setup();
    renderPanel();
    await user.click(screen.getByRole('tab', { name: /History|Audit/ }));
    const audit = screen.getByTestId('audit');
    expect(audit).toHaveAttribute('data-entity-type', 'bank_transaction');
    expect(audit).toHaveAttribute('data-entity-id', 'bt_1');
  });

  describe('on Global, without the links route', () => {
    beforeEach(() => {
      env.expanded = false;
      env.links = undefined;
    });

    it('reads the line row instead and resolves its ids into chips', async () => {
      const user = userEvent.setup();
      env.line = line({
        reconciledInvoiceId: 'inv_1',
        contactId: 'ct_1',
        journalEntryId: 'je_1',
        categoryAccountId: 'acc_4000',
      });
      renderPanel();

      expect(env.linksEnabled.every((enabled) => enabled === false)).toBe(true);
      expect(env.lineEnabled.some(Boolean)).toBe(true);
      expect(screen.getByTestId('title')).toHaveTextContent('Matched');

      await user.click(screen.getByRole('link', { name: /INV-2026-7/ }));
      expect(panelOpen).toHaveBeenLastCalledWith({ type: 'invoice', id: 'inv_1', stack: true });
      expect(screen.getByRole('link', { name: '4000 — Sales' })).toBeInTheDocument();
      // Never an id: a journal entry without a number reads as its translated name.
      expect(screen.getByRole('link', { name: 'Journal Entry' })).toBeInTheDocument();
      expect(screen.getByRole('link', { name: 'Acme Industries' })).toBeInTheDocument();
    });

    it('derives how the line was processed from its row', () => {
      expect(processedAsOf(line({ status: 'excluded' }))).toBe('excluded');
      expect(processedAsOf(line({ status: 'unreconciled' }))).toBe('unprocessed');
      expect(processedAsOf(line({ reconciledInvoiceId: 'inv_1' }))).toBe('payment');
      expect(processedAsOf(line({ depositId: 'dep_1' }))).toBe('deposit');
      expect(processedAsOf(line({ categoryAccountId: 'acc_1' }))).toBe('category');
      const fallback = linksFromLine(line({ status: 'unreconciled' }), {});
      expect(fallback.allocations).toEqual([]);
      expect(fallback.documents).toEqual([]);
    });
  });

  describe('actions', () => {
    it('undoes a processed line after a confirmation', async () => {
      const user = userEvent.setup();
      renderPanel();
      expect(screen.queryByTestId('match-bank-transaction')).not.toBeInTheDocument();
      expect(screen.queryByTestId('ignore-bank-transaction')).not.toBeInTheDocument();

      await user.click(screen.getByTestId('undo-bank-transaction'));
      // Nothing happens before the dialog is confirmed.
      expect(env.unreconcile).not.toHaveBeenCalled();
      const dialog = await screen.findByRole('dialog');
      expect(within(dialog).getByText('Undo this transaction?')).toBeInTheDocument();
      await user.click(within(dialog).getByRole('button', { name: 'Undo' }));

      await waitFor(() => expect(env.unreconcile).toHaveBeenCalledWith('bt_1'));
      expect(env.toast.success).toHaveBeenCalledWith('Transaction is back in To process');
    });

    it('ignores an unprocessed line after a confirmation', async () => {
      const user = userEvent.setup();
      env.links = links({
        transaction: line({ status: 'unreconciled' }),
        processedAs: 'unprocessed',
        payment: null,
        allocations: [],
        journalEntry: null,
        contact: null,
        documents: [],
      });
      renderPanel();
      expect(screen.queryByTestId('undo-bank-transaction')).not.toBeInTheDocument();

      await user.click(screen.getByTestId('ignore-bank-transaction'));
      expect(env.exclude).not.toHaveBeenCalled();
      const dialog = await screen.findByRole('dialog');
      expect(within(dialog).getByText('Ignore this transaction?')).toBeInTheDocument();
      await user.click(within(dialog).getByRole('button', { name: 'Ignore' }));

      await waitFor(() => expect(env.exclude).toHaveBeenCalledWith('bt_1'));
      expect(env.toast.success).toHaveBeenCalledWith('Transaction ignored');
    });

    it('keeps the dialog open and says so when the action fails', async () => {
      const user = userEvent.setup();
      env.unreconcile.mockRejectedValue(new Error('Period is locked'));
      renderPanel();
      await user.click(screen.getByTestId('undo-bank-transaction'));
      await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Undo' }));

      await waitFor(() =>
        expect(env.toast.error).toHaveBeenCalledWith('Could not complete that action', { description: 'Period is locked' }),
      );
      expect(screen.getByRole('dialog')).toBeInTheDocument();
    });

    it('opens the reconcile screen with this line selected when matching', async () => {
      const user = userEvent.setup();
      env.links = links({ transaction: line({ status: 'unreconciled' }), processedAs: 'unprocessed', payment: null, allocations: [], journalEntry: null, contact: null, documents: [] });
      renderPanel();
      await user.click(screen.getByTestId('match-bank-transaction'));
      expect(env.push).toHaveBeenCalledWith('/weldbooks/banking/reconciliation?accountId=ba_1&lineId=bt_1');
    });

    it('offers no actions without banking:update', () => {
      env.permissions = new Set();
      renderPanel();
      expect(screen.queryByTestId('undo-bank-transaction')).not.toBeInTheDocument();
      expect(screen.queryByTestId('match-bank-transaction')).not.toBeInTheDocument();
      expect(screen.queryByTestId('ignore-bank-transaction')).not.toBeInTheDocument();
    });
  });
  describe('where the edition has the processing view', () => {
    const unprocessed = () =>
      links({
        transaction: line({ status: 'unreconciled' }),
        processedAs: 'unprocessed',
        payment: null,
        allocations: [],
        journalEntry: null,
        contact: null,
        documents: [],
      });

    beforeEach(() => {
      env.processing = true;
    });

    it('undoes through the one undo route, not the old unreconcile', async () => {
      const user = userEvent.setup();
      renderPanel();
      await user.click(screen.getByTestId('undo-bank-transaction'));
      await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Undo' }));
      await waitFor(() => expect(env.undo).toHaveBeenCalledWith('bt_1'));
      expect(env.unreconcile).not.toHaveBeenCalled();
    });

    it('edits the notes and saves them', async () => {
      const user = userEvent.setup();
      renderPanel();
      await user.click(screen.getByTestId('edit-notes'));
      const field = screen.getByRole('textbox', { name: 'Notes' });
      await user.clear(field);
      await user.type(field, 'Checked with the bank');
      await user.click(screen.getByTestId('save-notes'));
      expect(env.saveNotes).toHaveBeenCalledWith({ lineId: 'bt_1', notes: 'Checked with the bank' }, expect.anything());
    });

    it('clears the notes when the text is emptied', async () => {
      const user = userEvent.setup();
      renderPanel();
      await user.click(screen.getByTestId('edit-notes'));
      await user.clear(screen.getByRole('textbox', { name: 'Notes' }));
      await user.click(screen.getByTestId('save-notes'));
      expect(env.saveNotes).toHaveBeenCalledWith({ lineId: 'bt_1', notes: null }, expect.anything());
    });

    it('cannot edit the notes without banking:update', () => {
      env.permissions = new Set();
      renderPanel();
      expect(screen.queryByTestId('edit-notes')).not.toBeInTheDocument();
      expect(screen.getByText('Paid after reminder')).toBeInTheDocument();
    });

    it('shows the other side of a transfer as a chip, and says when it has not arrived', async () => {
      const user = userEvent.setup();
      env.links = links({
        processedAs: 'transfer',
        payment: null,
        allocations: [],
        journalEntry: null,
        contact: null,
        documents: [],
        transfer: { counterpart: { id: 'bt_9', bankAccountId: 'ba_2', date: '2026-03-03', amount: '150.00', description: null } },
      });
      const view = renderPanel();
      expect(screen.getByTestId('title')).toHaveTextContent('Transfer');
      await user.click(screen.getByRole('link', { name: /€150.00/ }));
      expect(panelOpen).toHaveBeenLastCalledWith({ type: 'bank_transaction', id: 'bt_9', stack: true });
      view.unmount();

      env.links = links({
        processedAs: 'transfer',
        payment: null,
        allocations: [],
        journalEntry: null,
        contact: null,
        documents: [],
        transfer: { counterpart: null },
      });
      renderPanel();
      expect(screen.getByText('The matching line on the other account has not arrived yet.')).toBeInTheDocument();
    });

    it('names a line booked privately', () => {
      env.links = links({ processedAs: 'private', payment: null, allocations: [], journalEntry: null, contact: null, documents: [] });
      renderPanel();
      expect(screen.getByTestId('title')).toHaveTextContent('Private');
    });

    it('shows why a line was booked automatically, with the rule as a chip', () => {
      env.links = links({
        processedAs: 'category',
        payment: null,
        allocations: [],
        journalEntry: null,
        contact: null,
        documents: [],
        automatic: true,
        reason: 'rule',
        rule: { id: 'rul_1', name: 'Telnet monthly' },
      });
      renderPanel();
      expect(screen.getByTestId('automatic-reason')).toHaveTextContent('Rule: Telnet monthly');
      expect(screen.getByRole('link', { name: 'Telnet monthly' })).toBeInTheDocument();
    });

    it('opens the processing view on this line from Process', async () => {
      const user = userEvent.setup();
      env.links = unprocessed();
      renderPanel();
      await user.click(screen.getByTestId('match-bank-transaction'));
      expect(env.push).toHaveBeenCalledWith('/weldbooks/banking/process?accountId=ba_1&lineId=bt_1');
    });

    it('offers the processing actions in a menu: category and receipt open the view, private books at once', async () => {
      const user = userEvent.setup();
      env.links = unprocessed();
      renderPanel();

      await user.click(screen.getByRole('button', { name: /more actions/i }));
      await user.click(await screen.findByRole('menuitem', { name: 'Book to a category' }));
      expect(env.push).toHaveBeenLastCalledWith('/weldbooks/banking/process?accountId=ba_1&lineId=bt_1&action=category');

      await user.click(screen.getByRole('button', { name: /more actions/i }));
      await user.click(await screen.findByRole('menuitem', { name: 'Add a receipt' }));
      expect(env.push).toHaveBeenLastCalledWith('/weldbooks/banking/process?accountId=ba_1&lineId=bt_1&action=receipt');

      await user.click(screen.getByRole('button', { name: /more actions/i }));
      await user.click(await screen.findByRole('menuitem', { name: 'Paid privately' }));
      await waitFor(() => expect(env.markPrivate).toHaveBeenCalledWith('bt_1'));
      expect(env.toast.success).toHaveBeenCalledWith('Booked as paid privately');

      await user.click(screen.getByRole('button', { name: /more actions/i }));
      await user.click(await screen.findByRole('menuitem', { name: 'Transfer between accounts' }));
      await waitFor(() => expect(env.transfer).toHaveBeenCalledWith({ lineId: 'bt_1' }));
    });
  });

  it('leaves the notes read-only and the menu plain where the edition lacks the processing view', async () => {
    const user = userEvent.setup();
    env.links = links({ transaction: line({ status: 'unreconciled' }), processedAs: 'unprocessed', payment: null, allocations: [], journalEntry: null, contact: null, documents: [] });
    renderPanel();
    expect(screen.queryByTestId('edit-notes')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /more actions/i }));
    expect(screen.queryByRole('menuitem', { name: 'Paid privately' })).not.toBeInTheDocument();
  });

  describe('chat (books-questions)', () => {
    it("has a Chat tab with the line's chat, where questions to the accountant are asked", async () => {
      const user = userEvent.setup();
      renderPanel();
      await user.click(screen.getByRole('tab', { name: 'Chat' }));
      const chat = screen.getByTestId('record-question-chat');
      expect(chat).toHaveAttribute('data-type', 'bank_transaction');
      expect(chat).toHaveAttribute('data-id', 'bt_1');
    });

    it('has no Chat tab on Global', () => {
      env.questions = false;
      renderPanel();
      expect(screen.queryByRole('tab', { name: 'Chat' })).not.toBeInTheDocument();
    });
  });
});
