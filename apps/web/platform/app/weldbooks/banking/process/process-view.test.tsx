import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { BankLine, MatchSuggestion, UsBankAccount } from '@/lib/api/domains/weldbooks-banking';

const env = vi.hoisted(() => ({
  lines: [] as unknown[],
  suggestions: {} as Record<string, unknown[]>,
  permissions: new Set<string>(['banking:update']),
  search: {} as Record<string, string>,
  navigate: vi.fn(),
  matchPayment: vi.fn(),
  matchDeposit: vi.fn(),
  reconcile: vi.fn(),
  exclude: vi.fn(),
  categorize: vi.fn(),
  transfer: vi.fn(),
  markPrivate: vi.fn(),
  attach: vi.fn(),
  undo: vi.fn(),
  ruleSuggestion: vi.fn(),
  ruleFromTransaction: vi.fn(),
  listDocuments: vi.fn(),
  getLine: undefined as unknown,
  upload: vi.fn(),
  createDocument: vi.fn(),
  matchedPanel: { result: { id: 'l1', status: 'reconciled', paymentId: 'pay_1', journalEntryId: null } as unknown },
}));

vi.mock('@tanstack/react-router', () => ({
  Link: ({ to, children }: { to: string; children: React.ReactNode }) => <a href={to}>{children}</a>,
  useNavigate: () => env.navigate,
  useSearch: () => env.search,
}));
vi.mock('@/components/object-panel', async () => {
  const mock = await import('@/components/objects/_shared/object-panel-test-mock');
  return { ...mock, useObjectPanelUrlSync: vi.fn() };
});
vi.mock('@weldsuite/permissions/react', () => ({
  usePermissions: () => ({ can: (permission: string) => env.permissions.has(permission) }),
}));
vi.mock('@/lib/weldbooks/use-weldbooks-format', () => ({
  useWeldbooksFormat: () => ({
    formatMoney: (value: number | string) => `€${Number(value).toFixed(2)}`,
    formatDate: (value: string) => value,
    currency: 'EUR',
  }),
}));
vi.mock('@/lib/api/domains/weldbooks', () => ({
  accountingApi: {
    reconcileTransaction: (...args: unknown[]) => env.reconcile(...args),
    excludeTransaction: (...args: unknown[]) => env.exclude(...args),
    listDocuments: (...args: unknown[]) => env.listDocuments(...args),
    createDocument: (...args: unknown[]) => env.createDocument(...args),
  },
}));
vi.mock('@/lib/api/domains/weldbooks-processing', () => ({
  processingApi: {
    categorize: (...args: unknown[]) => env.categorize(...args),
    transfer: (...args: unknown[]) => env.transfer(...args),
    markPrivate: (...args: unknown[]) => env.markPrivate(...args),
    attachDocument: (...args: unknown[]) => env.attach(...args),
    undo: (...args: unknown[]) => env.undo(...args),
    ruleSuggestion: (...args: unknown[]) => env.ruleSuggestion(...args),
    ruleFromTransaction: (...args: unknown[]) => env.ruleFromTransaction(...args),
  },
}));
vi.mock('@/hooks/queries/use-accounting-queries', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/hooks/queries/use-accounting-queries')>()),
  useAccountingAccounts: () => ({
    data: {
      data: [
        { id: 'acc_tel', code: '4100', name: 'Telephone', type: 'expense', isActive: true },
        { id: 'acc_gen', code: '4900', name: 'General expenses', type: 'expense', isActive: true },
        { id: 'acc_sales', code: '8000', name: 'Sales', type: 'revenue', isActive: true },
      ],
    },
  }),
  useAccountingTaxRates: () => ({ data: { data: [{ id: 'tax_21', name: 'VAT 21%', rate: '21', isActive: true }] } }),
}));
vi.mock('@/hooks/queries/use-weldbooks-banking-queries', () => ({
  useBankAccounts: () => ({ data: { data: bankAccounts }, isLoading: false }),
  useInfiniteBankLines: (filters?: { bankAccountId?: string }) => ({
    data: filters ? { lines: env.lines, totalCount: env.lines.length } : undefined,
    isLoading: false,
    isError: false,
    hasNextPage: false,
    isFetchingNextPage: false,
    fetchNextPage: vi.fn(),
  }),
  useBankLine: (id: string | undefined) => ({ data: id ? env.getLine : undefined }),
  useBankLineSuggestions: (id: string | null) => ({ data: id ? (env.suggestions[id] ?? []) : [], isLoading: false }),
  useMatchBankLineToPayment: () => ({
    mutate: (vars: unknown, options: { onSuccess?: () => void }) => {
      env.matchPayment(vars);
      options.onSuccess?.();
    },
    isPending: false,
    error: null,
  }),
  useMatchBankLineToDeposit: () => ({
    mutate: (vars: unknown, options: { onSuccess?: () => void }) => {
      env.matchDeposit(vars);
      options.onSuccess?.();
    },
    isPending: false,
    error: null,
  }),
}));
vi.mock('@weldsuite/ui/components/autocomplete', () => ({
  Autocomplete: ({
    id,
    options = [],
    value,
    onValueChange,
    placeholder,
  }: {
    id?: string;
    options?: Array<{ value: string; label: string }>;
    value?: string;
    onValueChange?: (value: string) => void;
    placeholder?: string;
  }) => (
    <select id={id} value={value ?? ''} onChange={(event) => onValueChange?.(event.target.value)}>
      <option value="">{placeholder}</option>
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  ),
}));
vi.mock('@/components/accounting/contact-picker', () => ({ ContactPicker: () => <div data-testid="contact-picker" /> }));
vi.mock('@/components/weldflow/project-select', () => ({ ProjectSelect: () => <div data-testid="project-select" /> }));
vi.mock('./connections-strip', () => ({ ConnectionsStrip: ({ lineId }: { lineId: string }) => <div data-testid="connections" data-line={lineId} /> }));
vi.mock('./automatic-view', () => ({ AutomaticView: () => <div data-testid="automatic-view" /> }));
vi.mock('@/components/accounting/reconciliation-rule-form-dialog', () => ({
  ReconciliationRuleFormDialog: ({ open, prefill }: { open: boolean; prefill?: { name: string; actions: { categoryAccountId?: string } } | null }) =>
    open ? (
      <div role="dialog" data-testid="rule-dialog" data-name={prefill?.name} data-account={prefill?.actions.categoryAccountId} />
    ) : null,
}));
vi.mock('../components/match-documents-panel', () => ({
  MatchDocumentsPanel: ({ onMatched }: { onMatched: (result: unknown) => void }) => (
    <button type="button" onClick={() => onMatched(env.matchedPanel.result)}>
      link-documents
    </button>
  ),
}));
vi.mock('@/hooks/use-file-upload', () => ({ useFileUpload: () => ({ uploadFile: (...args: unknown[]) => env.upload(...args) }) }));

import { panelOpen } from '@/components/objects/_shared/object-panel-test-mock';
import { polyfillRadixSelect, renderWithProviders } from '../components/test-utils';
import { ProcessView } from './process-view';

const bankAccounts = [
  { id: 'ba_1', name: 'ING Business', iban: 'NL91ABNA0417164300', accountNumberLast4: null, currency: 'EUR', isDefault: true },
  { id: 'ba_2', name: 'Savings', iban: 'NL55 RABO 0301 9013 22', accountNumberLast4: null, currency: 'EUR' },
] as UsBankAccount[];

const acme = {
  id: 'l1',
  bankAccountId: 'ba_1',
  date: '2026-11-25',
  description: 'INV 2026-0142 ACME LOGISTICS',
  amount: '1210.00',
  counterpartyName: 'Acme Logistics BV',
  counterpartyIban: 'NL91 ABNA 0417 1643 00',
  status: 'unreconciled',
} as BankLine;
const telnet = {
  id: 'l2',
  bankAccountId: 'ba_1',
  date: '2026-11-24',
  description: 'FACTUUR 7781230',
  amount: '-89.95',
  counterpartyName: 'Telnet Zakelijk',
  counterpartyIban: 'NL20INGB0001234567',
  status: 'unreconciled',
} as BankLine;
const savings = {
  id: 'l3',
  bankAccountId: 'ba_1',
  date: '2026-11-22',
  description: 'NAAR SPAARREKENING',
  amount: '-2500.00',
  counterpartyName: 'Studio Noord BV',
  counterpartyIban: 'NL55RABO0301901322',
  status: 'unreconciled',
} as BankLine;
const vanDijk = {
  id: 'l4',
  bankAccountId: 'ba_1',
  date: '2026-11-21',
  description: 'BETALING FACTUREN',
  amount: '3630.00',
  counterpartyName: 'Van Dijk Architecten',
  counterpartyIban: null,
  status: 'unreconciled',
} as BankLine;

const invoiceSuggestion: MatchSuggestion = {
  type: 'invoice',
  id: 'inv_142',
  number: '2026-0142',
  contactName: 'Acme Logistics BV',
  amount: '1210.00',
  confidence: 0.95,
  reasons: ['exact amount match', 'invoice number in reference'],
};

function setServer(lines: BankLine[]) {
  env.lines = lines;
}

/** The server forgets a line once it is booked, as the real queue does after the refetch. */
function bookingRemoves(mock: ReturnType<typeof vi.fn>, result: unknown = {}) {
  mock.mockImplementation(async (lineId: string) => {
    env.lines = (env.lines as BankLine[]).filter((line) => line.id !== lineId);
    return { data: result };
  });
}

function renderView() {
  return renderWithProviders(<ProcessView />);
}

describe('ProcessView', () => {
  beforeAll(polyfillRadixSelect);
  beforeEach(() => {
    setServer([acme, telnet, savings, vanDijk]);
    env.suggestions = { l1: [invoiceSuggestion] };
    env.permissions = new Set(['banking:update']);
    env.search = {};
    env.navigate.mockReset();
    for (const mock of [
      env.matchPayment,
      env.matchDeposit,
      env.reconcile,
      env.exclude,
      env.categorize,
      env.transfer,
      env.markPrivate,
      env.attach,
      env.undo,
      env.ruleSuggestion,
      env.ruleFromTransaction,
      env.listDocuments,
      env.upload,
      env.createDocument,
    ]) {
      mock.mockReset();
    }
    env.reconcile.mockResolvedValue({ data: {} });
    env.exclude.mockResolvedValue({ data: {} });
    env.categorize.mockResolvedValue({ data: {} });
    env.transfer.mockResolvedValue({ data: { counterpart: null } });
    env.markPrivate.mockResolvedValue({ data: {} });
    env.attach.mockResolvedValue({ data: {} });
    env.undo.mockResolvedValue({ data: {} });
    env.ruleSuggestion.mockResolvedValue({ data: null });
    env.listDocuments.mockResolvedValue({
      data: [
        { id: 'doc_1', fileName: 'tankstation.pdf', linkedEntityId: null, status: 'pending' },
        { id: 'doc_2', fileName: 'already-linked.pdf', linkedEntityId: 'bill_1', status: 'linked' },
      ],
    });
    env.getLine = undefined;
    env.matchedPanel.result = { id: 'l1', status: 'reconciled', paymentId: 'pay_1', journalEntryId: null };
    panelOpen.mockReset();
  });

  describe('the queue and the selected line', () => {
    it('lists the lines with the real total, and opens the first with its amount, counterparty, IBAN and description', () => {
      renderView();
      expect(screen.getByRole('tab', { name: /To process/ })).toHaveTextContent('4');
      const queue = screen.getByTestId('process-queue');
      expect(within(queue).getAllByRole('button', { name: /.+/ }).filter((b) => b.dataset.testid?.startsWith('process-line-'))).toHaveLength(4);
      const header = screen.getByTestId('line-header');
      expect(within(header).getByRole('heading', { name: 'Acme Logistics BV' })).toBeInTheDocument();
      expect(within(header).getByText('NL91 ABNA 0417 1643 00')).toBeInTheDocument();
      const amount = screen.getByTestId('line-amount');
      expect(amount).toHaveTextContent('+€1210.00');
      expect(amount.className).toContain('emerald');
      expect(within(header).getByText('INV 2026-0142 ACME LOGISTICS').className).toContain('font-mono');
      expect(screen.getByTestId('process-line-l1')).toHaveAttribute('aria-current', 'true');
    });

    it('moves through the queue with J and K', async () => {
      const user = userEvent.setup();
      renderView();
      await user.keyboard('j');
      expect(screen.getByTestId('process-line-l2')).toHaveAttribute('aria-current', 'true');
      expect(within(screen.getByTestId('line-header')).getByRole('heading', { name: 'Telnet Zakelijk' })).toBeInTheDocument();
      await user.keyboard('k');
      expect(screen.getByTestId('process-line-l1')).toHaveAttribute('aria-current', 'true');
    });

    it('opens the line named by ?lineId= and the form named by ?action=', async () => {
      env.search = { lineId: 'l3', action: 'transfer' };
      renderView();
      expect(within(screen.getByTestId('line-header')).getByRole('heading', { name: 'Studio Noord BV' })).toBeInTheDocument();
      expect(screen.getByTestId('transfer-form')).toBeInTheDocument();
    });

    it('says so when there is nothing to process', () => {
      setServer([]);
      renderView();
      expect(screen.getByText('Nothing left to process on this account.')).toBeInTheDocument();
    });
  });

  describe('the best suggestion', () => {
    it('is one primary button with the reasons as chips', () => {
      renderView();
      const card = screen.getByTestId('suggestion-card');
      expect(within(card).getByText('Invoice 2026-0142 · Acme Logistics BV')).toBeInTheDocument();
      expect(within(card).getByRole('button', { name: /Link to invoice 2026-0142/ })).toBeInTheDocument();
      // The matcher's reason codes, translated.
      const reasons = within(card).getAllByRole('listitem').map((li) => li.textContent);
      expect(reasons.length).toBe(2);
      expect(reasons.join(' ')).not.toContain('exact amount match');
    });

    it('is accepted with Enter, marks the line Done and opens the next one', async () => {
      const user = userEvent.setup();
      bookingRemoves(env.reconcile);
      env.reconcile.mockImplementation(async (lineId: string) => {
        env.lines = (env.lines as BankLine[]).filter((line) => line.id !== lineId);
        return { data: {} };
      });
      renderView();
      await user.keyboard('{Enter}');

      await waitFor(() => expect(env.reconcile).toHaveBeenCalledWith('l1', { type: 'invoice', entityId: 'inv_142' }));
      const banner = await screen.findByTestId('result-banner');
      expect(banner).toHaveTextContent('Linked to Invoice 2026-0142.');
      // The next line is open, the processed one stays in its place marked Done.
      await waitFor(() =>
        expect(within(screen.getByTestId('line-header')).getByRole('heading', { name: 'Telnet Zakelijk' })).toBeInTheDocument(),
      );
      const queue = screen.getByTestId('process-queue');
      const first = within(queue).getByTestId('process-line-l1');
      expect(first).toHaveTextContent('Done');
      expect(queue.querySelector('[data-testid^="process-line-"]')).toBe(first);
    });

    it('is accepted by clicking its button, a payment suggestion linking the payment', async () => {
      const user = userEvent.setup();
      env.suggestions = {
        l1: [{ type: 'payment', id: 'pay_9', number: '1042', contactName: null, amount: '1210.00', confidence: 0.8, reasons: [] }],
      };
      renderView();
      await user.click(screen.getByTestId('accept-suggestion'));
      expect(env.matchPayment).toHaveBeenCalledWith({ lineId: 'l1', paymentId: 'pay_9' });
      expect(await screen.findByTestId('result-banner')).toBeInTheDocument();
    });

    it('books a rule suggestion with the rule', async () => {
      const user = userEvent.setup();
      env.suggestions = {
        l1: [{ type: 'rule', id: 'rr_1', number: 'Telnet monthly', contactName: null, amount: '1210.00', confidence: 0.8, reasons: [] }],
      };
      renderView();
      await user.click(screen.getByTestId('accept-suggestion'));
      expect(env.reconcile).toHaveBeenCalledWith('l1', { type: 'manual', ruleId: 'rr_1' });
      expect(await screen.findByText('Booked with the rule.')).toBeInTheDocument();
    });

    it('shows the refusal under the suggestion and keeps the line', async () => {
      const user = userEvent.setup();
      env.reconcile.mockRejectedValue(new Error('Period is locked'));
      renderView();
      await user.click(screen.getByTestId('accept-suggestion'));
      expect(await screen.findByTestId('suggestion-error')).toHaveTextContent('Period is locked');
      expect(screen.queryByTestId('result-banner')).not.toBeInTheDocument();
    });

    it('says "No sure match" when nothing fits well enough, and Enter then does nothing', async () => {
      const user = userEvent.setup();
      env.suggestions = { l1: [{ ...invoiceSuggestion, confidence: 0.3 }] };
      renderView();
      expect(screen.getByTestId('no-sure-match')).toHaveTextContent('No sure match');
      expect(screen.queryByTestId('accept-suggestion')).not.toBeInTheDocument();
      await user.keyboard('{Enter}');
      expect(env.reconcile).not.toHaveBeenCalled();
    });
  });

  describe('book to a category', () => {
    async function openCategory(user: ReturnType<typeof userEvent.setup>, lineId = 'l2') {
      await user.click(screen.getByTestId(`process-line-${lineId}`));
      await user.keyboard('c');
      return screen.getByTestId('category-form');
    }

    it('opens with C, offers expense categories for money out, and books one row', async () => {
      const user = userEvent.setup();
      bookingRemoves(env.categorize);
      renderView();
      const form = await openCategory(user);
      const options = within(within(form).getByLabelText('Category')).getAllByRole('option').map((o) => o.textContent);
      expect(options).toEqual(['Choose a category', '4100 — Telephone', '4900 — General expenses']);
      expect(within(form).getByTestId('contact-picker')).toBeInTheDocument();
      expect(within(form).getByTestId('project-select')).toBeInTheDocument();
      expect(within(form).getByLabelText('Amount')).toHaveValue('89.95');
      // Nothing to book to yet.
      expect(within(form).getByTestId('category-submit')).toBeDisabled();

      await user.selectOptions(within(form).getByLabelText('Category'), 'acc_tel');
      expect(within(form).getByTestId('category-submit')).toBeEnabled();
      await user.click(within(form).getByTestId('category-submit'));

      await waitFor(() =>
        expect(env.categorize).toHaveBeenCalledWith('l2', { lines: [{ accountId: 'acc_tel', amount: '89.95' }] }),
      );
      expect(await screen.findByTestId('result-banner')).toHaveTextContent('Booked to Telephone.');
    });

    it('offers revenue categories for money in', async () => {
      const user = userEvent.setup();
      renderView();
      await user.keyboard('c');
      const options = within(within(screen.getByTestId('category-form')).getByLabelText('Category'))
        .getAllByRole('option')
        .map((o) => o.textContent);
      expect(options).toEqual(['Choose a category', '8000 — Sales']);
    });

    it('splits over several rows and books only once the rows add up', async () => {
      const user = userEvent.setup();
      renderView();
      const form = await openCategory(user);
      await user.selectOptions(within(form).getByLabelText('Category'), 'acc_tel');
      const amount = within(form).getByLabelText('Amount');
      await user.clear(amount);
      await user.type(amount, '50');
      expect(within(form).getByTestId('split-remainder')).toHaveTextContent('Left to book: €39.95');
      expect(within(form).getByTestId('category-submit')).toBeDisabled();

      await user.click(within(form).getByRole('button', { name: 'Split' }));
      const rows = within(form).getAllByRole('group');
      expect(rows).toHaveLength(2);
      // The new row starts with what is left.
      expect(within(rows[1]!).getByLabelText('Amount')).toHaveValue('39.95');
      expect(within(form).getByTestId('category-submit')).toBeDisabled();
      await user.selectOptions(within(rows[1]!).getByLabelText('Category'), 'acc_gen');
      expect(within(form).getByTestId('split-remainder')).toHaveTextContent('The rows add up to €89.95.');
      expect(within(form).getByTestId('category-submit')).toBeEnabled();

      await user.clear(within(rows[1]!).getByLabelText('Amount'));
      await user.type(within(rows[1]!).getByLabelText('Amount'), '45');
      expect(within(form).getByTestId('split-remainder')).toHaveTextContent('The rows are €5.05 over the line.');
      expect(within(form).getByTestId('category-submit')).toBeDisabled();

      await user.clear(within(rows[1]!).getByLabelText('Amount'));
      await user.type(within(rows[1]!).getByLabelText('Amount'), '39.95');
      await user.click(within(form).getByTestId('category-submit'));
      await waitFor(() =>
        expect(env.categorize).toHaveBeenCalledWith('l2', {
          lines: [
            { accountId: 'acc_tel', amount: '50.00' },
            { accountId: 'acc_gen', amount: '39.95' },
          ],
        }),
      );
      expect(await screen.findByText('Split over 2 categories.')).toBeInTheDocument();
    });

    it('shows the server refusal in the form and keeps it open', async () => {
      const user = userEvent.setup();
      env.categorize.mockRejectedValue(new Error('The lines add up to 90.00 but the bank line is 89.95'));
      renderView();
      const form = await openCategory(user);
      await user.selectOptions(within(form).getByLabelText('Category'), 'acc_tel');
      await user.click(within(form).getByTestId('category-submit'));
      expect(await within(form).findByTestId('category-error')).toHaveTextContent('The lines add up to 90.00 but the bank line is 89.95');
    });

    it('offers to save the rule after booking, pre-filled from the suggestion', async () => {
      const user = userEvent.setup();
      bookingRemoves(env.categorize);
      env.ruleSuggestion.mockResolvedValue({
        data: {
          name: 'Telnet Zakelijk',
          matchMode: 'all',
          conditions: [{ field: 'counterpartyIban', operator: 'equals', value: 'NL20INGB0001234567' }],
          actions: { categoryAccountId: 'acc_tel' },
          evidence: { times: 3, categoryAccountId: 'acc_tel' },
        },
      });
      renderView();
      const form = await openCategory(user);
      await user.selectOptions(within(form).getByLabelText('Category'), 'acc_tel');
      await user.click(within(form).getByTestId('category-submit'));

      const offer = await screen.findByTestId('rule-offer');
      expect(offer).toHaveTextContent('You booked Telnet Zakelijk to this category 3 times. Make it a rule?');
      await user.click(within(offer).getByRole('button', { name: 'Make this a rule' }));
      const dialog = screen.getByTestId('rule-dialog');
      expect(dialog).toHaveAttribute('data-name', 'Telnet Zakelijk');
      expect(dialog).toHaveAttribute('data-account', 'acc_tel');
      expect(env.ruleFromTransaction).not.toHaveBeenCalled();
    });

    it('asks the server for a pre-fill when the history has no suggestion', async () => {
      const user = userEvent.setup();
      bookingRemoves(env.categorize);
      env.ruleFromTransaction.mockResolvedValue({
        data: {
          name: 'Telnet Zakelijk',
          matchMode: 'all',
          conditions: [{ field: 'counterpartyName', operator: 'equals', value: 'Telnet Zakelijk' }],
          actions: { categoryAccountId: 'acc_tel' },
        },
      });
      renderView();
      const form = await openCategory(user);
      await user.selectOptions(within(form).getByLabelText('Category'), 'acc_tel');
      await user.click(within(form).getByTestId('category-submit'));
      const offer = await screen.findByTestId('rule-offer');
      expect(offer).toHaveTextContent('Book lines like this one automatically?');
      await user.click(within(offer).getByRole('button', { name: 'Make this a rule' }));
      await waitFor(() => expect(env.ruleFromTransaction).toHaveBeenCalledWith('l2'));
      expect(await screen.findByTestId('rule-dialog')).toBeInTheDocument();
    });

    it('says why no rule can be made when the server refuses', async () => {
      const user = userEvent.setup();
      bookingRemoves(env.categorize);
      env.ruleFromTransaction.mockRejectedValue(new Error('no counterparty'));
      renderView();
      const form = await openCategory(user);
      await user.selectOptions(within(form).getByLabelText('Category'), 'acc_tel');
      await user.click(within(form).getByTestId('category-submit'));
      await user.click(within(await screen.findByTestId('rule-offer')).getByRole('button', { name: 'Make this a rule' }));
      expect(await screen.findByTestId('rule-offer-error')).toBeInTheDocument();
      expect(screen.queryByTestId('rule-dialog')).not.toBeInTheDocument();
    });

    it('closes with Escape, also from inside a field', async () => {
      const user = userEvent.setup();
      renderView();
      await openCategory(user);
      await user.keyboard('{Escape}');
      expect(screen.queryByTestId('category-form')).not.toBeInTheDocument();

      await user.keyboard('c');
      await user.click(within(screen.getByTestId('category-form')).getByLabelText('Amount'));
      await user.keyboard('{Escape}');
      expect(screen.queryByTestId('category-form')).not.toBeInTheDocument();
    });
  });

  describe('the other actions', () => {
    it('books a transfer to the own account that the IBAN belongs to', async () => {
      const user = userEvent.setup();
      bookingRemoves(env.transfer, { counterpart: { id: 'l9', bankAccountId: 'ba_2', journalEntryId: null } });
      renderView();
      await user.click(screen.getByTestId('process-line-l3'));
      await user.keyboard('t');
      const form = screen.getByTestId('transfer-form');
      expect(within(form).getByTestId('transfer-matched')).toHaveTextContent('This IBAN is your account Savings.');
      await user.click(within(form).getByTestId('transfer-submit'));
      await waitFor(() => expect(env.transfer).toHaveBeenCalledWith('l3', { bankAccountId: 'ba_2' }));
      expect(await screen.findByText('Booked as a transfer. The line on Savings is paired with it.')).toBeInTheDocument();
    });

    it('lets the person pick the account when the IBAN is not an own account', async () => {
      const user = userEvent.setup();
      renderView();
      await user.click(screen.getByTestId('process-line-l2'));
      await user.keyboard('t');
      const form = screen.getByTestId('transfer-form');
      expect(within(form).queryByTestId('transfer-matched')).not.toBeInTheDocument();
      await user.click(within(form).getByRole('combobox'));
      await user.click(await screen.findByRole('option', { name: 'Savings' }));
      await user.click(within(form).getByTestId('transfer-submit'));
      await waitFor(() => expect(env.transfer).toHaveBeenCalledWith('l2', { bankAccountId: 'ba_2' }));
    });

    it('books paid privately with P', async () => {
      const user = userEvent.setup();
      bookingRemoves(env.markPrivate);
      renderView();
      await user.click(screen.getByTestId('process-line-l2'));
      await user.keyboard('p');
      await waitFor(() => expect(env.markPrivate).toHaveBeenCalledWith('l2'));
      expect(await screen.findByText('Booked as paid privately.')).toBeInTheDocument();
    });

    it('ignores with I', async () => {
      const user = userEvent.setup();
      bookingRemoves(env.exclude);
      renderView();
      await user.click(screen.getByTestId('process-line-l2'));
      await user.keyboard('i');
      await waitFor(() => expect(env.exclude).toHaveBeenCalledWith('l2'));
      expect(await screen.findByText('Ignored. It stays out of the books and can be undone.')).toBeInTheDocument();
    });

    it('links several documents and names the rounding the server booked', async () => {
      const user = userEvent.setup();
      env.matchedPanel.result = { id: 'l1', status: 'reconciled', paymentId: 'pay_1', journalEntryId: null, roundingDifference: { accountId: 'acc_r', amount: '0.50' } };
      renderView();
      await user.click(screen.getByTestId('action-several'));
      await user.click(screen.getByRole('button', { name: 'link-documents' }));
      expect(await screen.findByText('Linked to the documents. €0.50 was booked to rounding.')).toBeInTheDocument();
    });

    it('opens the document search from "Not this one? Search"', async () => {
      const user = userEvent.setup();
      renderView();
      await user.click(screen.getByRole('button', { name: 'Not this one? Search' }));
      expect(screen.getByTestId('several-panel')).toBeInTheDocument();
    });
  });

  describe('adding a receipt', () => {
    it('attaches an unlinked inbox document, books nothing, and offers to book it to a category', async () => {
      const user = userEvent.setup();
      renderView();
      await user.click(screen.getByTestId('process-line-l2'));
      await user.keyboard('r');
      const form = screen.getByTestId('receipt-form');
      const list = await within(form).findByTestId('receipt-documents');
      // The linked document is not offered.
      expect(within(list).getAllByRole('listitem')).toHaveLength(1);
      expect(within(list).getByText('tankstation.pdf')).toBeInTheDocument();

      await user.click(within(list).getByRole('button', { name: 'Attach tankstation.pdf' }));
      await waitFor(() => expect(env.attach).toHaveBeenCalledWith('l2', 'doc_1'));
      const attached = await screen.findByTestId('receipt-attached');
      expect(attached).toHaveTextContent('Receipt attached to the line.');
      // The line is still to process.
      expect(screen.queryByTestId('result-banner')).not.toBeInTheDocument();
      expect(within(screen.getByTestId('line-header')).getByRole('heading', { name: 'Telnet Zakelijk' })).toBeInTheDocument();

      await user.click(within(attached).getByTestId('receipt-book-now'));
      expect(screen.getByTestId('category-form')).toBeInTheDocument();
    });

    it('uploads a file, creates the document and attaches it', async () => {
      const user = userEvent.setup();
      env.upload.mockResolvedValue({ fileName: 'bon.pdf', fileKey: 'k/bon.pdf', mimeType: 'application/pdf', fileSize: 10 });
      env.createDocument.mockResolvedValue({ data: { id: 'doc_new' } });
      renderView();
      await user.click(screen.getByTestId('process-line-l2'));
      await user.keyboard('r');
      const file = new File(['x'], 'bon.pdf', { type: 'application/pdf' });
      await user.upload(screen.getByTestId('receipt-file-input'), file);

      await waitFor(() => expect(env.upload).toHaveBeenCalledWith(file));
      expect(env.createDocument).toHaveBeenCalledWith({
        fileName: 'bon.pdf',
        fileKey: 'k/bon.pdf',
        mimeType: 'application/pdf',
        fileSize: 10,
        source: 'upload',
      });
      await waitFor(() => expect(env.attach).toHaveBeenCalledWith('l2', 'doc_new'));
      expect(await screen.findByTestId('receipt-attached')).toBeInTheDocument();
    });

    it('says so when the upload fails and attaches nothing', async () => {
      const user = userEvent.setup();
      env.upload.mockResolvedValue(null);
      renderView();
      await user.keyboard('r');
      await user.upload(screen.getByTestId('receipt-file-input'), new File(['x'], 'bon.pdf', { type: 'application/pdf' }));
      expect(await screen.findByTestId('receipt-error')).toHaveTextContent('The file could not be uploaded.');
      expect(env.attach).not.toHaveBeenCalled();
    });

    it('searches the inbox by file name', async () => {
      const user = userEvent.setup();
      env.listDocuments.mockResolvedValue({
        data: [
          { id: 'doc_1', fileName: 'tankstation.pdf', linkedEntityId: null, status: 'pending' },
          { id: 'doc_3', fileName: 'hotel.pdf', linkedEntityId: null, status: 'pending' },
        ],
      });
      renderView();
      await user.keyboard('r');
      const form = screen.getByTestId('receipt-form');
      await within(form).findByTestId('receipt-documents');
      await user.type(within(form).getByRole('searchbox', { name: 'Search the inbox' }), 'hot');
      const list = within(form).getByTestId('receipt-documents');
      expect(within(list).getAllByRole('listitem')).toHaveLength(1);
      expect(within(list).getByText('hotel.pdf')).toBeInTheDocument();
    });
  });

  describe('undo', () => {
    it('undoes the last action from the success line, and the line is open again', async () => {
      const user = userEvent.setup();
      bookingRemoves(env.markPrivate);
      env.undo.mockImplementation(async (lineId: string) => {
        env.lines = [acme, telnet, savings, vanDijk].filter((line) => line.id === lineId || (env.lines as BankLine[]).some((l) => l.id === line.id));
        return { data: { undone: 'private' } };
      });
      renderView();
      await user.click(screen.getByTestId('process-line-l2'));
      await user.keyboard('p');
      await screen.findByTestId('result-banner');

      await user.click(screen.getByTestId('undo-button'));
      await waitFor(() => expect(env.undo).toHaveBeenCalledWith('l2'));
      expect(await screen.findByTestId('undo-notice')).toHaveTextContent('Undone. The line is back in To process.');
      expect(screen.queryByTestId('result-banner')).not.toBeInTheDocument();
      expect(within(screen.getByTestId('line-header')).getByRole('heading', { name: 'Telnet Zakelijk' })).toBeInTheDocument();
      expect(screen.getByTestId('process-line-l2')).not.toHaveTextContent('Done');
    });

    it('undoes with U', async () => {
      const user = userEvent.setup();
      bookingRemoves(env.exclude);
      renderView();
      await user.click(screen.getByTestId('process-line-l2'));
      await user.keyboard('i');
      await screen.findByTestId('result-banner');
      await user.keyboard('u');
      await waitFor(() => expect(env.undo).toHaveBeenCalledWith('l2'));
    });

    it('says so when the undo is refused and keeps the success line', async () => {
      const user = userEvent.setup();
      bookingRemoves(env.markPrivate);
      env.undo.mockRejectedValue(new Error('Period is locked'));
      renderView();
      await user.click(screen.getByTestId('process-line-l2'));
      await user.keyboard('p');
      await screen.findByTestId('result-banner');
      await user.click(screen.getByTestId('undo-button'));
      await waitFor(() => expect(env.undo).toHaveBeenCalled());
      expect(screen.getByTestId('result-banner')).toBeInTheDocument();
    });
  });

  describe('keyboard handling', () => {
    it('does not fire shortcuts while typing in the search box', async () => {
      const user = userEvent.setup();
      renderView();
      await user.click(screen.getByRole('searchbox', { name: 'Search transactions' }));
      await user.keyboard('cjpi{Enter}');
      expect(screen.queryByTestId('category-form')).not.toBeInTheDocument();
      expect(env.markPrivate).not.toHaveBeenCalled();
      expect(env.exclude).not.toHaveBeenCalled();
      expect(env.reconcile).not.toHaveBeenCalled();
      expect(screen.getByTestId('process-line-l1')).toHaveAttribute('aria-current', 'true');
    });

    it('does not fire shortcuts inside the form fields', async () => {
      const user = userEvent.setup();
      renderView();
      await user.keyboard('c');
      const amount = within(screen.getByTestId('category-form')).getByLabelText('Amount');
      await user.click(amount);
      await user.keyboard('pi');
      expect(env.markPrivate).not.toHaveBeenCalled();
      expect(env.exclude).not.toHaveBeenCalled();
    });

    it('does not fire shortcuts while a dialog is open', async () => {
      const user = userEvent.setup();
      renderView();
      await user.keyboard('?');
      const dialog = await screen.findByRole('dialog');
      expect(within(dialog).getByText('Keyboard shortcuts')).toBeInTheDocument();
      await user.keyboard('p');
      expect(env.markPrivate).not.toHaveBeenCalled();
    });

    it('lists every shortcut in the help dialog', async () => {
      const user = userEvent.setup();
      renderView();
      await user.keyboard('?');
      const dialog = await screen.findByRole('dialog');
      for (const label of ['Next line', 'Previous line', 'Accept the suggestion', 'Book to a category', 'Add a receipt', 'Paid privately', 'Undo the last action']) {
        expect(within(dialog).getByText(label)).toBeInTheDocument();
      }
    });
  });

  describe('bulk booking', () => {
    it('books the ticked lines of one direction to a category, one call per line, with a summary', async () => {
      const user = userEvent.setup();
      env.categorize.mockImplementation(async (lineId: string) => {
        if (lineId === 'l3') throw new Error('Period is locked');
        return { data: {} };
      });
      renderView();
      await user.click(screen.getByRole('checkbox', { name: /Telnet Zakelijk/ }));
      // Money in cannot join money out.
      expect(screen.getByRole('checkbox', { name: /Acme Logistics BV/ })).toBeDisabled();
      await user.click(screen.getByRole('checkbox', { name: /Studio Noord BV/ }));
      expect(screen.getByTestId('bulk-bar')).toHaveTextContent('2 selected');

      await user.click(screen.getByTestId('bulk-open'));
      const dialog = await screen.findByTestId('bulk-dialog');
      expect(within(dialog).getByRole('button', { name: 'Book 2 lines' })).toBeDisabled();
      await user.selectOptions(within(dialog).getByLabelText('Category'), 'acc_gen');
      await user.click(within(dialog).getByTestId('bulk-run'));

      const summary = await within(dialog).findByTestId('bulk-summary');
      expect(summary).toHaveTextContent('1 booked, 1 failed.');
      expect(summary).toHaveTextContent('Studio Noord BV: Period is locked');
      expect(env.categorize).toHaveBeenCalledTimes(2);
      expect(env.categorize).toHaveBeenCalledWith('l2', { lines: [{ accountId: 'acc_gen', amount: '89.95' }] });
      expect(env.categorize).toHaveBeenCalledWith('l3', { lines: [{ accountId: 'acc_gen', amount: '2500.00' }] });

      // The footer button and the corner X are both called Close.
      await user.click(within(dialog).getAllByRole('button', { name: 'Close' })[0]!);
      // The booked line is Done, the failed one is still to process.
      expect(screen.getByTestId('process-line-l2')).toHaveTextContent('Done');
      expect(screen.getByTestId('process-line-l3')).not.toHaveTextContent('Done');
    });
  });

  describe('views and permissions', () => {
    it('shows the lines booked automatically in their own view', async () => {
      const user = userEvent.setup();
      renderView();
      await user.click(screen.getByRole('tab', { name: 'Booked automatically' }));
      expect(screen.getByTestId('automatic-view')).toBeInTheDocument();
      expect(screen.queryByTestId('process-queue')).not.toBeInTheDocument();
    });

    it('leaves the full transaction list to its own page', async () => {
      const user = userEvent.setup();
      renderView();
      await user.click(screen.getByRole('tab', { name: 'All' }));
      expect(env.navigate).toHaveBeenCalledWith({ to: '/weldbooks/banking/transactions' });
    });

    it('offers no processing without banking:update', async () => {
      const user = userEvent.setup();
      env.permissions = new Set();
      renderView();
      expect(screen.getByTestId('accept-suggestion')).toBeDisabled();
      expect(screen.getByTestId('action-category')).toBeDisabled();
      expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
      await user.keyboard('p');
      await user.keyboard('{Enter}');
      expect(env.markPrivate).not.toHaveBeenCalled();
      expect(env.reconcile).not.toHaveBeenCalled();
    });

    it('does not move between lines while act() settles', async () => {
      renderView();
      await act(async () => {});
      expect(screen.getByTestId('connections')).toHaveAttribute('data-line', 'l1');
    });
  });
});
