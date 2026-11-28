import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { en } from '@weldsuite/i18n/locales/en';
import { nl } from '@weldsuite/i18n/locales/nl';
import type { TodoItem, TodoKind, TodoSummary } from '@/lib/api/domains/weldbooks';

const env = vi.hoisted(() => ({
  available: true,
  locale: 'en' as 'en' | 'nl',
  summary: undefined as unknown,
  summaryError: false,
  top: {} as Record<string, unknown[]>,
  all: {} as Record<string, unknown[]>,
  hasNextPage: false,
  fetchNextPage: vi.fn(),
  refetch: vi.fn(),
  panel: { open: vi.fn(), sync: vi.fn() },
  push: vi.fn(),
  fetchPayment: vi.fn(),
  timeBilling: false,
  canReadTime: false,
}));
vi.mock('@weldsuite/permissions/react', () => ({
  useCan: (permission: string) => permission === 'time:read' && env.canReadTime,
}));
vi.mock('@/hooks/queries/use-weldbooks-time-billing-queries', () => ({
  isTimeBillingAvailable: () => env.timeBilling,
}));

vi.mock('@/lib/i18n/provider', async () => {
  const { en: english } = await import('@weldsuite/i18n/locales/en');
  const { nl: dutch } = await import('@weldsuite/i18n/locales/nl');
  return { useI18n: () => ({ t: env.locale === 'nl' ? dutch : english, language: env.locale }) };
});
vi.mock('@/lib/router', () => ({
  Link: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
  useRouter: () => ({ push: env.push }),
}));
vi.mock('@tanstack/react-query', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@tanstack/react-query')>()),
  useQueryClient: () => ({}),
}));
vi.mock('@/hooks/queries/use-weldbooks-processing-queries', () => ({
  fetchCreditPayment: (...args: unknown[]) => env.fetchPayment(...args),
}));
vi.mock('@/components/object-panel', () => ({
  useObjectPanel: () => ({ stack: [], open: env.panel.open }),
  useObjectPanelUrlSync: env.panel.sync,
}));
vi.mock('@/lib/weldbooks/use-weldbooks-format', () => ({
  useWeldbooksFormat: () => ({
    formatMoney: (value: string | number | null | undefined, currency?: string | null) => `${currency ?? '¤'} ${value}`,
    formatDate: (value: string | null | undefined) => `date:${value ?? ''}`,
  }),
}));
vi.mock('@/hooks/queries/use-weldbooks-todo-queries', () => ({
  TODO_TOP_LIMIT: 3,
  isTodoAvailable: () => env.available,
  useTodoSummary: () => ({
    data: env.summary,
    isError: env.summaryError,
    refetch: env.refetch,
  }),
  useTodoTopItems: (kind: string) => ({ data: env.top[kind] ?? [], isError: false, refetch: vi.fn() }),
  useInfiniteTodoItems: (kind: string) => ({
    data: { items: env.all[kind] ?? env.top[kind] ?? [], totalCount: 0 },
    isError: false,
    refetch: vi.fn(),
    hasNextPage: env.hasNextPage,
    isFetchingNextPage: false,
    fetchNextPage: env.fetchNextPage,
  }),
}));

import ToProcessPage, { visibleTodoKinds } from './page';

function item(kind: TodoKind, overrides: Partial<TodoItem> = {}): TodoItem {
  return {
    kind,
    objectType: 'bank_transaction',
    objectId: 'btx_1',
    title: 'Paper Co',
    subtitle: 'INV-7',
    amount: '221.00',
    currency: 'EUR',
    date: '2026-11-20',
    dueDate: null,
    severity: 'info',
    hint: null,
    ...overrides,
  };
}

function summary(kinds: TodoSummary['kinds']): TodoSummary {
  const total = Object.values(kinds).reduce((sum, k) => sum + (k?.count ?? 0), 0);
  return { total, currency: 'EUR', kinds };
}

const card = (kind: TodoKind) => screen.getByTestId(`todo-card-${kind}`);

beforeEach(() => {
  env.available = true;
  env.timeBilling = false;
  env.canReadTime = false;
  env.locale = 'en';
  env.summaryError = false;
  env.hasNextPage = false;
  env.top = {};
  env.all = {};
  env.fetchNextPage.mockReset();
  env.refetch.mockReset();
  env.panel.open.mockReset();
  env.panel.sync.mockReset();
  env.push.mockReset();
  env.fetchPayment.mockReset();
  env.summary = summary({
    vat_return: { count: 1, amount: null },
    invoices_overdue: { count: 4, amount: '221.00', currency: 'EUR', mixedCurrency: true },
    documents: { count: 5, amount: null },
    bank_lines: { count: 12, amount: '1500.00', currency: 'EUR', mixedCurrency: false },
  });
  env.top = {
    vat_return: [item('vat_return', { objectType: 'vat_return', objectId: 'vat_1', title: 'Q3 2026', subtitle: null, amount: null, hint: 'not_filed', severity: 'warning' })],
    invoices_overdue: [
      item('invoices_overdue', { objectType: 'invoice', objectId: 'inv_1', title: 'Globex', subtitle: 'INV-1', amount: '100.00', dueDate: '2026-11-01', hint: 'overdue', severity: 'danger' }),
    ],
    documents: [
      item('documents', { objectType: 'accounting_document', objectId: 'doc_1', title: 'receipt.pdf', subtitle: null, amount: null, hint: 'ocr_failed', severity: 'warning' }),
    ],
    bank_lines: [
      item('bank_lines', { hint: 'possible_match' }),
      item('bank_lines', { objectId: 'btx_2', title: 'Vendor Two', hint: 'possible_duplicate' }),
    ],
  };
});

describe('visibleTodoKinds', () => {
  it('lists the kinds with something to do in urgency order, whatever order the API sent them in', () => {
    const kinds = visibleTodoKinds({
      bank_lines: { count: 2, amount: null },
      bills_due: { count: 0, amount: '0.00' },
      vat_return: { count: 1, amount: null },
      invoices_overdue: { count: 3, amount: '5.00' },
    });
    expect(kinds.map(([kind]) => kind)).toEqual(['vat_return', 'invoices_overdue', 'bank_lines']);
  });

  it('leaves out a kind this build does not know', () => {
    const kinds = visibleTodoKinds({ mystery: { count: 3, amount: null } } as unknown as TodoSummary['kinds']);
    expect(kinds).toEqual([]);
  });

  it('copes with no summary', () => {
    expect(visibleTodoKinds(undefined)).toEqual([]);
  });
});

describe('ToProcessPage: the way to Unbilled time', () => {
  it('links to the Unbilled time page where the edition bills time and the member may read it', () => {
    env.timeBilling = true;
    env.canReadTime = true;
    render(<ToProcessPage />);
    expect(screen.getByRole('link', { name: en.weldbooksContactPage.menu.unbilledTime })).toHaveAttribute('href', '/weldbooks/time/unbilled');
  });

  it('has no such link on Global, or for a member who may not read time', () => {
    env.timeBilling = false;
    env.canReadTime = true;
    const { unmount } = render(<ToProcessPage />);
    expect(screen.queryByRole('link', { name: en.weldbooksContactPage.menu.unbilledTime })).not.toBeInTheDocument();
    unmount();
    env.timeBilling = true;
    env.canReadTime = false;
    render(<ToProcessPage />);
    expect(screen.queryByRole('link', { name: en.weldbooksContactPage.menu.unbilledTime })).not.toBeInTheDocument();
  });
});

describe('ToProcessPage', () => {
  it('shows one card per kind with something to do, most urgent first, with its count', () => {
    render(<ToProcessPage />);
    expect(screen.getAllByRole('listitem').length).toBeGreaterThanOrEqual(4);
    const cards = screen.getAllByTestId(/^todo-card-/);
    expect(cards.map((c) => c.getAttribute('data-kind'))).toEqual(['vat_return', 'invoices_overdue', 'documents', 'bank_lines']);
    expect(within(card('bank_lines')).getByRole('heading', { name: 'Bank lines' })).toBeInTheDocument();
    expect(within(card('bank_lines')).getByTestId('todo-count')).toHaveTextContent('12');
    expect(within(card('documents')).getByTestId('todo-count')).toHaveTextContent('5');
  });

  it('shows the amount of a kind that has one, and a mixed-currency note only when it is mixed', () => {
    render(<ToProcessPage />);
    expect(within(card('invoices_overdue')).getByText('EUR 221.00')).toBeInTheDocument();
    expect(within(card('invoices_overdue')).getByTestId('todo-mixed-currency')).toHaveTextContent('Mixed currencies, shown in EUR');
    expect(within(card('bank_lines')).getByText('EUR 1500.00')).toBeInTheDocument();
    expect(within(card('bank_lines')).queryByTestId('todo-mixed-currency')).not.toBeInTheDocument();
    // A kind that counts things, not money, has no amount line.
    expect(within(card('documents')).queryByText(/EUR/)).not.toBeInTheDocument();
  });

  it('puts the primary action of each card under it', () => {
    render(<ToProcessPage />);
    expect(within(card('bank_lines')).getByRole('link', { name: 'Process 12 lines' })).toHaveAttribute('href', '/weldbooks/banking/reconciliation');
    expect(within(card('documents')).getByRole('link', { name: 'Check 5 documents' })).toHaveAttribute('href', '/weldbooks/documents');
    expect(within(card('invoices_overdue')).getByRole('link', { name: 'View overdue invoices' })).toHaveAttribute(
      'href',
      '/weldbooks/invoices?show=overdue',
    );
    expect(within(card('vat_return')).getByRole('link', { name: 'Open the return' })).toHaveAttribute(
      'href',
      '/weldbooks/vat?stack=vat_return%3Avat_1',
    );
  });

  it('shows an item with its title, subtitle, amount, date and tone, and the hint in words', () => {
    render(<ToProcessPage />);
    const lines = within(card('bank_lines')).getAllByTestId('todo-item');
    expect(lines).toHaveLength(2);
    const first = lines[0]!;
    expect(within(first).getByText('Paper Co')).toBeInTheDocument();
    expect(within(first).getByText('INV-7')).toBeInTheDocument();
    expect(within(first).getByText('EUR 221.00')).toBeInTheDocument();
    expect(within(first).getByText('date:2026-11-20')).toBeInTheDocument();
    expect(within(first).getByText('Possible match found')).toBeInTheDocument();
    // The tone is spoken, not only coloured.
    expect(within(first).getByText('For your information')).toBeInTheDocument();
    expect(within(lines[1]!).getByText('Possible duplicate')).toBeInTheDocument();
    // A due date wins over the booking date.
    const overdue = within(card('invoices_overdue')).getByTestId('todo-item');
    expect(within(overdue).getByText('Due date:2026-11-01')).toBeInTheDocument();
    expect(within(overdue).getByText('Overdue')).toBeInTheDocument();
    expect(within(overdue).getByText('Needs attention now')).toBeInTheDocument();
  });

  it('never shows a raw hint code, and shows nothing for a code it does not know', () => {
    env.top.bank_lines = [item('bank_lines', { hint: 'brand_new_code' }), item('bank_lines', { objectId: 'btx_3', hint: 'ocr_failed' })];
    render(<ToProcessPage />);
    expect(screen.queryByText('brand_new_code')).not.toBeInTheDocument();
    expect(screen.queryByText(/ocr_failed|possible_match/)).not.toBeInTheDocument();
    expect(within(card('bank_lines')).getByText('Scan failed, check by hand')).toBeInTheDocument();
  });

  it('says the hints, kinds and actions in Dutch', () => {
    env.locale = 'nl';
    render(<ToProcessPage />);
    expect(screen.getByRole('heading', { name: nl.weldbooksConnected.todo.title })).toBeInTheDocument();
    expect(within(card('bank_lines')).getByRole('heading', { name: 'Bankregels' })).toBeInTheDocument();
    expect(within(card('bank_lines')).getByRole('link', { name: '12 regels verwerken' })).toBeInTheDocument();
    expect(within(card('bank_lines')).getByText('Mogelijke match gevonden')).toBeInTheDocument();
    expect(within(card('documents')).getByText('Scannen mislukt, controleer handmatig')).toBeInTheDocument();
    expect(within(card('invoices_overdue')).getByText('Achterstallig')).toBeInTheDocument();
  });

  it('opens a bank line, an invoice and a VAT return as stacked panels', async () => {
    const user = userEvent.setup();
    render(<ToProcessPage />);

    await user.click(within(card('bank_lines')).getByRole('link', { name: /Paper Co/ }));
    expect(env.panel.open).toHaveBeenLastCalledWith({ type: 'bank_transaction', id: 'btx_1', stack: true });
    await user.click(within(card('invoices_overdue')).getByRole('link', { name: /Globex/ }));
    expect(env.panel.open).toHaveBeenLastCalledWith({ type: 'invoice', id: 'inv_1', stack: true });
    await user.click(within(card('vat_return')).getByRole('link', { name: /Q3 2026/ }));
    expect(env.panel.open).toHaveBeenLastCalledWith({ type: 'vat_return', id: 'vat_1', stack: true });
  });

  it('opens a bill and a bank account the same way', async () => {
    const user = userEvent.setup();
    env.summary = summary({ bills_to_approve: { count: 1, amount: '9.00', currency: 'EUR' }, bank_feeds: { count: 1, amount: null } });
    env.top = {
      bills_to_approve: [item('bills_to_approve', { objectType: 'bill', objectId: 'bil_1', title: 'Dell' })],
      bank_feeds: [item('bank_feeds', { objectType: 'bank_account', objectId: 'ba_1', title: 'ING', amount: null })],
    };
    render(<ToProcessPage />);
    await user.click(within(card('bills_to_approve')).getByRole('link', { name: /Dell/ }));
    expect(env.panel.open).toHaveBeenLastCalledWith({ type: 'bill', id: 'bil_1', stack: true });
    await user.click(within(card('bank_feeds')).getByRole('link', { name: /ING/ }));
    expect(env.panel.open).toHaveBeenLastCalledWith({ type: 'bank_account', id: 'ba_1', stack: true });
  });

  it('keeps the panel in step with ?stack= of this page, so a panel opened here has an address', () => {
    render(<ToProcessPage />);
    expect(env.panel.sync).toHaveBeenCalledWith('/weldbooks/to-process');
  });

  it('opens an inbox document on the documents page with ?document=', async () => {
    const user = userEvent.setup();
    render(<ToProcessPage />);
    const chip = within(card('documents')).getByRole('link', { name: /receipt\.pdf/ });
    expect(chip.getAttribute('href')).toContain('/weldbooks/documents?document=doc_1');
    await user.click(chip);
    expect(env.push).toHaveBeenCalledWith('/weldbooks/documents?document=doc_1');
    expect(env.panel.open).not.toHaveBeenCalled();
  });

  it('opens the contact of an unapplied-credit payment on its Credit tab, and gives the card no action', async () => {
    const user = userEvent.setup();
    env.fetchPayment.mockResolvedValue({ id: 'pay_1', contactId: 'prt_9' });
    env.summary = summary({ unapplied_credit: { count: 1, amount: '40.00', currency: 'EUR', mixedCurrency: false } });
    env.top = {
      unapplied_credit: [item('unapplied_credit', { objectType: 'payment', objectId: 'pay_1', title: 'Globex', hint: 'unapplied_credit' })],
    };
    render(<ToProcessPage />);
    const row = within(card('unapplied_credit')).getByTestId('todo-item');
    expect(within(row).getByText('Unapplied credit')).toBeInTheDocument();
    expect(within(card('unapplied_credit')).queryByRole('link')).not.toBeInTheDocument();
    await user.click(within(row).getByRole('button', { name: /Globex/ }));
    await vi.waitFor(() =>
      expect(env.panel.open).toHaveBeenCalledWith({ type: 'weldbooks_contact', id: 'prt_9', initialTab: 'credit', stack: true }),
    );
    expect(env.fetchPayment).toHaveBeenCalledWith(expect.anything(), 'pay_1');
  });

  it('offers Show all only for a kind with more than its top three, and pages through the rest with the cursor', async () => {
    const user = userEvent.setup();
    env.hasNextPage = true;
    env.all.bank_lines = [item('bank_lines'), item('bank_lines', { objectId: 'btx_2', title: 'Vendor Two' }), item('bank_lines', { objectId: 'btx_3', title: 'Vendor Three' }), item('bank_lines', { objectId: 'btx_4', title: 'Vendor Four' })];
    render(<ToProcessPage />);

    expect(within(card('documents')).getByRole('button', { name: /^Show all 5/ })).toBeInTheDocument();
    expect(within(card('vat_return')).queryByRole('button', { name: /Show all/ })).not.toBeInTheDocument();

    const showAll = within(card('bank_lines')).getByRole('button', { name: /^Show all 12/ });
    expect(showAll).toHaveAttribute('aria-expanded', 'false');
    await user.click(showAll);
    expect(within(card('bank_lines')).getAllByTestId('todo-item')).toHaveLength(4);
    await user.click(within(card('bank_lines')).getByRole('button', { name: /^Load more/ }));
    expect(env.fetchNextPage).toHaveBeenCalledTimes(1);

    await user.click(within(card('bank_lines')).getByRole('button', { name: /^Show fewer/ }));
    expect(within(card('bank_lines')).getAllByTestId('todo-item')).toHaveLength(2);
  });

  it('says All caught up when there is nothing to process', () => {
    env.summary = summary({ bank_lines: { count: 0, amount: null }, documents: { count: 0, amount: null } });
    render(<ToProcessPage />);
    expect(screen.getByText('All caught up')).toBeInTheDocument();
    expect(screen.queryAllByTestId(/^todo-card-/)).toHaveLength(0);
  });

  it('says All caught up in Dutch', () => {
    env.locale = 'nl';
    env.summary = summary({});
    render(<ToProcessPage />);
    expect(screen.getByText(nl.weldbooksConnected.todo.emptyTitle)).toBeInTheDocument();
  });

  it('shows a loader while the counts load and an error with a retry when they fail', async () => {
    const user = userEvent.setup();
    env.summary = undefined;
    const { unmount } = render(<ToProcessPage />);
    expect(screen.queryByText('All caught up')).not.toBeInTheDocument();
    unmount();

    env.summaryError = true;
    render(<ToProcessPage />);
    expect(screen.getByRole('alert')).toHaveTextContent(en.weldbooksConnected.todo.loadFailed);
    await user.click(screen.getByRole('button', { name: /retry|try again/i }));
    expect(env.refetch).toHaveBeenCalled();
  });

  it('shows the not-available page instead of the list on an edition without books-todo, such as Global', () => {
    env.available = false;
    render(<ToProcessPage />);
    expect(screen.getByText(en.common.edition.unavailableTitle)).toBeInTheDocument();
    expect(screen.queryAllByTestId(/^todo-card-/)).toHaveLength(0);
    expect(screen.queryByRole('heading', { name: en.weldbooksConnected.todo.title })).not.toBeInTheDocument();
  });
});

describe('missing receipts', () => {
  beforeEach(() => {
    // `missing_receipts` is not part of `total`: it only shows for those who may read reports.
    env.summary = { total: 0, currency: 'EUR', kinds: { missing_receipts: { count: 12, amount: '845.00', currency: 'EUR', mixedCurrency: false } } };
    env.top = {
      missing_receipts: [
        item('missing_receipts', { objectId: 'btx_77', title: 'Bol.com', subtitle: null, amount: '49.00', hint: 'missing_receipt' }),
      ],
    };
  });

  it('shows a card that says how many expenses have no receipt, even when nothing else counts toward the total', () => {
    render(<ToProcessPage />);

    expect(screen.queryByText('All caught up')).not.toBeInTheDocument();
    const missing = card('missing_receipts');
    expect(within(missing).getByRole('heading', { name: 'Missing receipts' })).toBeInTheDocument();
    expect(within(missing).getByTestId('todo-count')).toHaveTextContent('12');
    expect(within(missing).getByTestId('todo-kind-summary')).toHaveTextContent('12 expenses without a receipt');
    expect(within(missing).getByText('No receipt yet')).toBeInTheDocument();
    expect(within(missing).getByRole('link', { name: 'Add receipts' })).toHaveAttribute('href', '/weldbooks/banking/transactions');
  });

  it('opens an item as its bank line', async () => {
    const user = userEvent.setup();
    render(<ToProcessPage />);

    await user.click(within(card('missing_receipts')).getByRole('link', { name: /Bol\.com/ }));

    expect(env.panel.open).toHaveBeenLastCalledWith({ type: 'bank_transaction', id: 'btx_77', stack: true });
  });

  it('says it in Dutch', () => {
    env.locale = 'nl';
    render(<ToProcessPage />);

    expect(within(card('missing_receipts')).getByTestId('todo-kind-summary')).toHaveTextContent('12 uitgaven zonder bon');
    expect(within(card('missing_receipts')).getByText('Nog geen bon')).toBeInTheDocument();
  });

  it('shows no card where the caller may not read it (the kind is absent)', () => {
    env.summary = summary({ bank_lines: { count: 12, amount: null } });
    render(<ToProcessPage />);
    expect(screen.queryByTestId('todo-card-missing_receipts')).not.toBeInTheDocument();
  });
});
