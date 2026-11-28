import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { en } from '@weldsuite/i18n/locales/en';

const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), patch: vi.fn(), put: vi.fn(), delete: vi.fn(), getBlob: vi.fn() }));
vi.mock('@/lib/api/weldbooks-client', () => ({ weldbooksApi: api, setWeldbooksEntityId: vi.fn() }));
vi.mock('@tanstack/react-router', () => ({
  Link: ({
    to,
    search,
    params: _params,
    children,
    ...rest
  }: {
    to: string;
    search?: Record<string, string>;
    params?: Record<string, string>;
    children: React.ReactNode;
  }) => (
    <a href={search ? `${to}?${new URLSearchParams(search).toString()}` : to} {...rest}>
      {children}
    </a>
  ),
  useNavigate: () => vi.fn(),
}));
vi.mock('@/lib/router', () => ({
  Link: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
const permissions = vi.hoisted(() => ({ allowed: new Set<string>() }));
const edition = vi.hoisted(() => ({ contactPage: true }));
vi.mock('@/lib/edition', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/edition')>();
  return {
    ...actual,
    isFeatureAvailable: (feature: Parameters<typeof actual.isFeatureAvailable>[0]) => {
      if (feature === 'books-contact-page') return edition.contactPage;
      if (feature === 'books-quotes') return false;
      return actual.isFeatureAvailable(feature);
    },
  };
});
vi.mock('@weldsuite/permissions/react', () => ({
  usePermissions: () => ({ can: (permission: string) => permissions.allowed.has(permission) }),
  usePermissionsMaybe: () => ({ can: (permission: string) => permissions.allowed.has(permission) }),
}));
vi.mock('@/lib/weldbooks/use-jurisdiction', () => ({
  useJurisdictionLabels: () => ({
    labels: { supplier: 'Vendor', taxId: 'VAT', registrationId: 'KvK', customerAndSupplier: 'Customer + vendor' },
    features: { salesTax: false },
  }),
}));
vi.mock('@/hooks/use-current-entity-currency', () => ({
  useCurrentEntityCurrency: () => ({ formatMoney: (value: string | null | undefined) => `$${value ?? '0'}`, entityCurrency: 'EUR' }),
}));
vi.mock('@/lib/weldbooks/use-weldbooks-format', () => ({
  useWeldbooksFormat: () => ({
    formatDate: (value: string | null | undefined) => `date:${value ?? ''}`,
    formatDateTime: (value: string | null | undefined) => `at:${value ?? ''}`,
    formatMoney: (value: string | number | null | undefined, currency?: string | null) => `${currency ?? 'EUR'} ${value ?? '0'}`,
    formatNumber: (value: string | number | null | undefined) => String(value ?? ''),
    today: () => '2026-11-30',
  }),
}));
vi.mock('@/hooks/use-workspace-url', () => ({ useWorkspaceUrl: () => (path: string) => `https://app.test${path}` }));
vi.mock('@/hooks/queries/use-settings-queries', () => ({
  useGridViewSettings: () => ({ data: undefined, isLoading: false }),
  useUpdateGridView: () => ({ mutate: vi.fn() }),
}));
vi.mock('@/components/entity-audit-panel', () => ({
  EntityAuditPanel: ({ entityType, entityId }: { entityType: string; entityId: string }) => (
    <div data-testid="audit-panel">{`${entityType}:${entityId}`}</div>
  ),
}));
const panel = vi.hoisted(() => ({ open: vi.fn() }));
vi.mock('@/components/object-panel', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/components/object-panel')>()),
  useObjectPanel: () => ({ open: panel.open, stack: [] }),
}));
const download = vi.hoisted(() => ({ save: vi.fn() }));
vi.mock('@/lib/weldbooks/download', () => ({ downloadBlob: download.save }));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock('sonner', () => ({ toast }));

import { WeldbooksContactPanel } from './weldbooks-contact-panel';
import { installPointerPolyfills, renderWithProviders } from '@/app/weldbooks/sales-tax/setup/test-support';

const copy = en.weldbooksContactPage;
const noBalance = { receivable: { totalOutstanding: '0', totalOverdue: '0' }, payable: { totalOutstanding: '0', totalOverdue: '0' } };

const contact = {
  id: 'prt_1',
  name: 'Van Dijk Architecten',
  role: 'both',
  kind: 'company',
  companyId: 'co_1',
  companyName: 'Van Dijk Architecten',
  email: 'info@vandijk.test',
  paymentTermsDays: 14,
  contactPerson: { personId: 'pe_1', name: 'Eva van Dijk', email: 'finance@vandijk.test', phone: null },
};

const summary = {
  toReceive: [{ currency: 'EUR', amount: '1815.00', count: 1 }],
  overdue: [],
  toPay: [{ currency: 'EUR', amount: '450.00', count: 1 }],
  unappliedCredit: [],
  openQuotes: { count: 0, amount: [] },
  unbilledHours: { hours: '12.5', amount: '1187.50', currency: 'EUR' },
};

const defaults = { contactId: 'prt_1', defaultExpenseAccountId: null, defaultTaxRateId: null, paymentTermsDays: 14, remindersPaused: false };

const invoices = [
  { id: 'inv_open', invoiceNumber: '2026-0144', type: 'invoice', status: 'sent', issueDate: '2026-11-20', dueDate: '2099-12-05', total: '1815.00', balanceDue: '1815.00', currency: 'EUR' },
  { id: 'inv_late', invoiceNumber: '2026-0101', type: 'invoice', status: 'overdue', issueDate: '2020-01-01', dueDate: '2020-01-15', total: '300.00', balanceDue: '300.00', currency: 'EUR' },
  { id: 'inv_paid', invoiceNumber: '2026-0090', type: 'invoice', status: 'paid', issueDate: '2026-09-01', dueDate: '2026-09-15', total: '100.00', balanceDue: '0.00', currency: 'EUR' },
];
const bills = [
  { id: 'bill_1', billNumber: 'AD-2026-118', type: 'bill', status: 'approved', issueDate: '2026-11-10', dueDate: '2099-12-10', total: '450.00', balanceDue: '450.00', currency: 'EUR' },
  { id: 'bill_2', billNumber: 'AD-2026-001', type: 'bill', status: 'paid', issueDate: '2026-01-10', dueDate: '2026-02-10', total: '50.00', balanceDue: '0.00', currency: 'EUR' },
];

const timelinePage1 = {
  data: [
    { type: 'invoice', objectType: 'invoice', objectId: 'inv_open', date: '2026-11-20T00:00:00Z', title: '2026-0144', subtitle: null, amount: '1815.00', currency: 'EUR', status: 'sent', hint: null },
    { type: 'reminder', objectType: 'invoice', objectId: 'inv_late', date: '2026-11-18T00:00:00Z', title: '2026-0101', subtitle: 'to eva@x.test', amount: null, currency: null, status: null, hint: 'level:2' },
    { type: 'payment', objectType: 'payment', objectId: 'pay_1', date: '2026-11-10T00:00:00Z', title: 'REF-9', subtitle: null, amount: '100.00', currency: 'EUR', status: null, hint: 'received' },
  ],
  pagination: { totalCount: 4, hasMore: true, cursor: '1700000000000:pay_1' },
};
const timelinePage2 = {
  data: [
    { type: 'document', objectType: 'document', objectId: 'doc_1', date: '2026-10-01T00:00:00Z', title: 'scan.pdf', subtitle: 'ap@vandijk.test', amount: null, currency: null, status: null, hint: 'bill' },
  ],
  pagination: { totalCount: 4, hasMore: false, cursor: null },
};

function paged<T>(rows: T[]) {
  return { data: rows, pagination: { totalCount: rows.length, hasMore: false } };
}

interface Served {
  summary?: unknown;
  contact?: unknown;
  bankLines?: unknown[];
  statement?: unknown;
}

function serve(options: Served = {}) {
  api.get.mockImplementation(async (path: string) => {
    if (path.includes('/timeline')) return path.includes('cursor=') ? timelinePage2 : timelinePage1;
    if (path.endsWith('/summary')) return { data: options.summary ?? summary };
    if (path.endsWith('/defaults')) return { data: defaults };
    if (path.includes('/statement')) return { data: options.statement ?? { rows: [], totals: [], asOf: '2026-11-30' } };
    if (path.endsWith('/credits')) return { data: [] };
    if (path.endsWith('/balance')) return { data: noBalance };
    if (path.includes('/accounting-contacts/prt_1/invoices')) return paged(invoices);
    if (path.includes('/accounting-contacts/prt_1/bills')) return paged(bills);
    if (path.startsWith('/bank-transactions')) return paged(options.bankLines ?? []);
    if (path.startsWith('/accounts') || path.startsWith('/tax-rates')) return { data: [] };
    if (path === '/accounting-contacts/prt_1') return { data: options.contact ?? contact };
    return { data: [] };
  });
}

function renderPanel() {
  return renderWithProviders(
    <WeldbooksContactPanel id="prt_1" isOpen onClose={vi.fn()} mode="fullscreen" onModeChange={vi.fn()} />,
  );
}

beforeAll(installPointerPolyfills);

beforeEach(() => {
  for (const fn of Object.values(api)) fn.mockReset();
  panel.open.mockReset();
  toast.success.mockReset();
  toast.error.mockReset();
  download.save.mockReset();
  edition.contactPage = true;
  permissions.allowed = new Set(['invoices:read', 'invoices:create', 'invoices:update', 'bills:create', 'time:read']);
});

describe('the contact page: header and tiles', () => {
  it('names the contact with its role, contact person, terms and reminder status', async () => {
    serve();
    renderPanel();
    await screen.findByText('Van Dijk Architecten');
    expect(screen.getByText(copy.header.customerAndSupplier)).toBeInTheDocument();
    expect(await screen.findByText('Contact person: Eva van Dijk')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'finance@vandijk.test' })).toHaveAttribute('href', 'mailto:finance@vandijk.test');
    expect(screen.getByText('pays in 14 days')).toBeInTheDocument();
    expect(await screen.findByText('reminders: on')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: copy.header.openInCrm })).toBeInTheDocument();
  });

  it('shows the four tiles from the summary, and the unbilled hours as a link to the Unbilled time page for this customer', async () => {
    serve();
    renderPanel();
    const tiles = await screen.findByRole('region', { name: copy.tiles.label });
    await waitFor(() => expect(within(tiles).getByText('EUR 1815.00')).toBeInTheDocument());
    expect(within(tiles).getByText(copy.tiles.toReceive)).toBeInTheDocument();
    expect(within(tiles).getByText('1 invoice')).toBeInTheDocument();
    expect(within(tiles).getByText(copy.tiles.nothingOverdue)).toBeInTheDocument();
    expect(within(tiles).getByText('EUR 450.00')).toBeInTheDocument();
    const unbilled = within(tiles).getByRole('link', { name: /Unbilled time/ });
    expect(unbilled).toHaveAttribute('href', '/weldbooks/time/unbilled?customerId=prt_1');
    expect(unbilled).toHaveTextContent('12.5 h');
    expect(unbilled).toHaveTextContent('EUR 1187.50 · invoice it');
  });

  it('shows a contact owing in two currencies as two amounts, never one made-up total', async () => {
    serve({
      summary: {
        ...summary,
        toReceive: [
          { currency: 'EUR', amount: '100.00', count: 2 },
          { currency: 'USD', amount: '40.00', count: 1 },
        ],
        overdue: [{ currency: 'USD', amount: '40.00', count: 1 }],
      },
    });
    renderPanel();
    const tiles = await screen.findByRole('region', { name: copy.tiles.label });
    await waitFor(() => expect(within(tiles).getByText('EUR 100.00')).toBeInTheDocument());
    expect(within(tiles).getByText('+ USD 40.00')).toBeInTheDocument();
    expect(within(tiles).getAllByText('USD 40.00').length).toBeGreaterThan(0);
  });

  it('has no Unbilled time tile for a member who may not read time', async () => {
    permissions.allowed.delete('time:read');
    serve({ summary: { ...summary, unbilledHours: undefined } });
    renderPanel();
    const tiles = await screen.findByRole('region', { name: copy.tiles.label });
    await waitFor(() => expect(within(tiles).getByText('EUR 1815.00')).toBeInTheDocument());
    expect(within(tiles).queryByText(copy.tiles.unbilled)).not.toBeInTheDocument();
  });

  it('opens the Invoices tab on its overdue view from the Overdue tile, and Bills from To pay them', async () => {
    const user = userEvent.setup();
    serve({ summary: { ...summary, overdue: [{ currency: 'EUR', amount: '300.00', count: 1 }] } });
    renderPanel();
    const tiles = await screen.findByRole('region', { name: copy.tiles.label });
    await waitFor(() => expect(within(tiles).getByText('EUR 300.00')).toBeInTheDocument());

    await user.click(within(tiles).getByRole('button', { name: /Overdue/ }));
    expect(await screen.findByRole('radio', { name: copy.documents.filterOverdue })).toHaveAttribute('aria-checked', 'true');
    await screen.findByText('2026-0101');
    expect(screen.queryByText('2026-0144')).not.toBeInTheDocument();
    expect(screen.queryByText('2026-0090')).not.toBeInTheDocument();

    await user.click(within(screen.getByRole('region', { name: copy.tiles.label })).getByRole('button', { name: /To pay them/ }));
    await screen.findByText('AD-2026-118');
    expect(screen.queryByText('AD-2026-001')).not.toBeInTheDocument();
    expect(screen.getByRole('radio', { name: copy.documents.filterOpen })).toHaveAttribute('aria-checked', 'true');
  });
});

describe('the contact page: tabs', () => {
  it('has Overview, Invoices, Bills, Bank lines, Chat, Details and History', async () => {
    serve();
    renderPanel();
    await screen.findByRole('region', { name: copy.tiles.label });
    for (const name of [copy.tabs.overview, copy.tabs.invoices, copy.tabs.bills, copy.tabs.bankLines, copy.tabs.details]) {
      expect(await screen.findByRole('tab', { name })).toBeInTheDocument();
    }
  });

  it('lists the documents through the contact’s paged routes, with the total', async () => {
    const user = userEvent.setup();
    serve();
    renderPanel();
    await user.click(await screen.findByRole('tab', { name: copy.tabs.invoices }));
    await screen.findByText('2026-0144');
    const calls = api.get.mock.calls.map((call) => String(call[0]));
    expect(calls.some((path) => /^\/accounting-contacts\/prt_1\/invoices\?page=1&pageSize=25$/.test(path))).toBe(true);
    expect(screen.getByText('Showing 3 of 3')).toBeInTheDocument();
    // The old list is not asked for: the new route replaces it.
    expect(calls.some((path) => path.startsWith('/invoices?'))).toBe(false);
  });

  it('opens the bank lines of the contact by its id', async () => {
    const user = userEvent.setup();
    serve({
      bankLines: [{ id: 'btx_1', date: '2026-11-12', description: 'Betaling factuur', counterpartyName: 'Van Dijk', amount: '1815.00', status: 'reconciled' }],
    });
    renderPanel();
    await user.click(await screen.findByRole('tab', { name: copy.tabs.bankLines }));
    await screen.findByText('Van Dijk');
    expect(api.get.mock.calls.some((call) => /^\/bank-transactions\?.*contactId=prt_1/.test(String(call[0])))).toBe(true);
    expect(screen.getByRole('table', { name: copy.bankLines.caption })).toBeInTheDocument();
    expect(screen.getByText(`${copy.bankLines.moneyIn}:`)).toBeInTheDocument();
  });

  it('says so when the contact has no bank lines', async () => {
    const user = userEvent.setup();
    serve();
    renderPanel();
    await user.click(await screen.findByRole('tab', { name: copy.tabs.bankLines }));
    expect(await screen.findByText(copy.bankLines.empty)).toBeInTheDocument();
  });
});

describe('the contact page: overview and timeline', () => {
  it('lists what is open now, then everything with the contact by date, with its hints translated', async () => {
    serve();
    renderPanel();
    const openNow = await screen.findByRole('region', { name: copy.overview.openNow });
    await within(openNow).findByText('Invoice 2026-0144');
    expect(within(openNow).getByText('Bill AD-2026-118 from them')).toBeInTheDocument();
    expect(within(openNow).getByText('12.5 h not invoiced yet')).toBeInTheDocument();
    expect(within(openNow).getByRole('link', { name: copy.overview.createInvoice })).toHaveAttribute(
      'href',
      '/weldbooks/time/unbilled?customerId=prt_1',
    );

    const timeline = await screen.findByRole('list', { name: copy.overview.timelineLabel });
    const items = within(timeline).getAllByRole('listitem');
    expect(items).toHaveLength(3);
    expect(items[0]).toHaveTextContent('Invoice');
    expect(items[0]).toHaveTextContent('2026-0144');
    expect(items[0]).toHaveTextContent('EUR 1815.00');
    expect(items[1]).toHaveTextContent('Reminder');
    expect(items[1]).toHaveTextContent('to eva@x.test · reminder 2');
    expect(items[2]).toHaveTextContent('Payment');
    expect(items[2]).toHaveTextContent('received · EUR 100.00');
    expect(screen.getByText('Everything with Van Dijk Architecten')).toBeInTheDocument();
  });

  it('pages the timeline: Load more asks for the cursor, and a document links to the inbox', async () => {
    const user = userEvent.setup();
    serve();
    renderPanel();
    await screen.findByRole('list', { name: copy.overview.timelineLabel });
    await user.click(await screen.findByRole('button', { name: copy.overview.loadMore }));

    const scan = await screen.findByRole('link', { name: 'scan.pdf' });
    expect(scan).toHaveAttribute('href', '/weldbooks/documents?document=doc_1');
    const timeline = screen.getByRole('list', { name: copy.overview.timelineLabel });
    expect(within(timeline).getAllByRole('listitem')).toHaveLength(4);
    expect(within(timeline).getAllByRole('listitem')[3]).toHaveTextContent('ap@vandijk.test · bill');
    expect(api.get.mock.calls.some((call) => String(call[0]).includes('cursor=1700000000000%3Apay_1'))).toBe(true);
    expect(screen.queryByRole('button', { name: copy.overview.loadMore })).not.toBeInTheDocument();
  });
});

describe('the contact page: defaults', () => {
  it('saves pausing reminders on its own and says it is for this company', async () => {
    const user = userEvent.setup();
    serve();
    api.patch.mockResolvedValue({ data: { ...defaults, remindersPaused: true } });
    renderPanel();
    await user.click(await screen.findByRole('tab', { name: copy.tabs.details }));
    const toggle = await screen.findByRole('switch', { name: copy.defaults.pauseReminders });
    expect(screen.getByText(copy.defaults.pauseNote)).toBeInTheDocument();
    expect(copy.defaults.pauseNote).toContain('For this company');
    await user.click(toggle);
    expect(api.patch).toHaveBeenCalledWith('/accounting-contacts/prt_1/defaults', { remindersPaused: true });
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith(copy.defaults.saved));
  });

  it('saves the payment terms as a default, and clears them with null', async () => {
    const user = userEvent.setup();
    serve();
    api.patch.mockResolvedValue({ data: defaults });
    renderPanel();
    await user.click(await screen.findByRole('tab', { name: copy.tabs.details }));
    await user.click(await screen.findByRole('button', { name: copy.defaults.paymentTerms }));
    await user.keyboard('{Control>}a{/Control}30{Enter}');
    expect(api.patch).toHaveBeenCalledWith('/accounting-contacts/prt_1/defaults', { paymentTermsDays: 30 });

    await user.click(await screen.findByRole('button', { name: copy.defaults.paymentTerms }));
    await user.keyboard('{Control>}a{/Control}{Backspace}{Enter}');
    expect(api.patch).toHaveBeenLastCalledWith('/accounting-contacts/prt_1/defaults', { paymentTermsDays: null });
  });

  it('refuses terms that are not a whole number of days, without calling the server', async () => {
    const user = userEvent.setup();
    serve();
    renderPanel();
    await user.click(await screen.findByRole('tab', { name: copy.tabs.details }));
    await user.click(await screen.findByRole('button', { name: copy.defaults.paymentTerms }));
    await user.keyboard('{Control>}a{/Control}-3{Enter}');
    expect(api.patch).not.toHaveBeenCalled();
    expect(toast.error).toHaveBeenCalledWith(copy.defaults.saveFailed, { description: copy.defaults.invalidDays });
  });

  it('leaves the switch read-only for a member who may not update', async () => {
    const user = userEvent.setup();
    permissions.allowed.delete('invoices:update');
    serve();
    renderPanel();
    await user.click(await screen.findByRole('tab', { name: copy.tabs.details }));
    expect(await screen.findByRole('switch', { name: copy.defaults.pauseReminders })).toBeDisabled();
  });
});

describe('the contact page: statement', () => {
  const statement = {
    contact: { id: 'prt_1', name: 'Van Dijk Architecten' },
    entityId: 'ent_1',
    asOf: '2026-11-30',
    locale: 'en',
    rows: [
      { kind: 'invoice', objectType: 'invoice', objectId: 'inv_open', number: '2026-0144', date: '2026-11-20', dueDate: '2026-12-05', currency: 'EUR', amount: '1815.00', balance: '1815.00', overdueDays: 0 },
      { kind: 'invoice', objectType: 'invoice', objectId: 'inv_late', number: '2026-0101', date: '2026-10-01', dueDate: '2026-10-15', currency: 'EUR', amount: '300.00', balance: '300.00', overdueDays: 46 },
    ],
    totals: [{ currency: 'EUR', amount: '2115.00' }],
  };

  it('previews the open items as of a date, with the total, and says it cannot be e-mailed from here', async () => {
    const user = userEvent.setup();
    serve({ statement });
    renderPanel();
    await user.click(await screen.findByRole('button', { name: copy.actions.sendStatement }));
    const dialog = await screen.findByRole('dialog');
    const table = await within(dialog).findByRole('table', { name: copy.statement.caption });
    expect(within(table).getByText('2026-0144')).toBeInTheDocument();
    expect(within(table).getByText(/46 days overdue/)).toBeInTheDocument();
    expect(within(table).getByText('EUR 2115.00')).toBeInTheDocument();
    expect(within(dialog).getByLabelText(copy.statement.asOf)).toHaveValue('2026-11-30');
    expect(within(dialog).getByText(copy.statement.emailNote)).toBeInTheDocument();
    expect(api.get.mock.calls.some((call) => String(call[0]) === '/accounting-contacts/prt_1/statement?asOf=2026-11-30&format=json')).toBe(true);
  });

  it('asks again for another date', async () => {
    const user = userEvent.setup();
    serve({ statement });
    renderPanel();
    await user.click(await screen.findByRole('button', { name: copy.actions.sendStatement }));
    const dialog = await screen.findByRole('dialog');
    const asOf = within(dialog).getByLabelText(copy.statement.asOf);
    await user.clear(asOf);
    await user.type(asOf, '2026-10-31');
    await waitFor(() =>
      expect(api.get.mock.calls.some((call) => String(call[0]) === '/accounting-contacts/prt_1/statement?asOf=2026-10-31&format=json')).toBe(true),
    );
  });

  it('downloads the PDF of the chosen date', async () => {
    const user = userEvent.setup();
    serve({ statement });
    api.getBlob.mockResolvedValue({ blob: new Blob(['%PDF']), filename: 'statement-Van-Dijk-2026-11-30.pdf', headers: new Headers() });
    renderPanel();
    await user.click(await screen.findByRole('button', { name: copy.actions.sendStatement }));
    const dialog = await screen.findByRole('dialog');
    await within(dialog).findByRole('table', { name: copy.statement.caption });
    await user.click(within(dialog).getByRole('button', { name: copy.statement.downloadPdf }));
    await waitFor(() => expect(api.getBlob).toHaveBeenCalledWith('/accounting-contacts/prt_1/statement?asOf=2026-11-30&format=pdf'));
    expect(download.save).toHaveBeenCalledWith(expect.any(Blob), 'statement-Van-Dijk-2026-11-30.pdf');
    expect(toast.success).toHaveBeenCalledWith(copy.statement.downloaded);
  });

  it('says when nothing is open on that date', async () => {
    const user = userEvent.setup();
    serve();
    renderPanel();
    await user.click(await screen.findByRole('button', { name: copy.actions.sendStatement }));
    expect(await screen.findByText(copy.statement.empty)).toBeInTheDocument();
  });
});

describe('the contact panel on Global, which has no contact page', () => {
  it('keeps today’s panel: Details first, no tiles, no statement, no bank lines', async () => {
    edition.contactPage = false;
    serve();
    renderPanel();
    await screen.findAllByText('Van Dijk Architecten');
    expect(await screen.findByRole('tab', { name: 'Details' })).toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: copy.tabs.overview })).not.toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: copy.tabs.bankLines })).not.toBeInTheDocument();
    expect(screen.queryByRole('region', { name: copy.tiles.label })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: copy.actions.sendStatement })).not.toBeInTheDocument();
    const paths = api.get.mock.calls.map((call) => String(call[0]));
    expect(paths.some((path) => path.endsWith('/summary') || path.includes('/timeline') || path.endsWith('/defaults'))).toBe(false);
  });

  it('reads the invoices through the old list filtered by contact', async () => {
    const user = userEvent.setup();
    edition.contactPage = false;
    serve();
    api.get.mockImplementation(async (path: string) => {
      if (path.startsWith('/invoices')) return paged(invoices);
      if (path.endsWith('/credits')) return { data: [] };
      if (path.endsWith('/balance')) return { data: noBalance };
      if (path === '/accounting-contacts/prt_1') return { data: contact };
      return { data: [] };
    });
    renderPanel();
    await user.click(await screen.findByRole('tab', { name: en.accounting.contacts.connected.tabInvoices }));
    await screen.findByText('2026-0144');
    expect(api.get.mock.calls.some((call) => /^\/invoices\?.*contactId=prt_1/.test(String(call[0])))).toBe(true);
    expect(screen.queryByRole('radio', { name: copy.documents.filterOverdue })).not.toBeInTheDocument();
  });
});
