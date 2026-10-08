import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { I18nProvider } from '@weldsuite/i18n/provider';
import type { Form1099Summary, Form1099VendorRow } from '@/lib/api/domains/weldbooks-1099';

const router = vi.hoisted(() => ({ search: {} as { year?: number; tab?: string }, navigate: vi.fn() }));
vi.mock('@tanstack/react-router', () => ({
  Link: ({ to, params, search: _search, children, ...rest }: { to: string; params?: Record<string, string>; search?: unknown; children: React.ReactNode }) => (
    <a href={Object.entries(params ?? {}).reduce((href, [key, value]) => href.replace(`$${key}`, value), to)} {...rest}>
      {children}
    </a>
  ),
  useSearch: () => router.search,
  useNavigate: () => router.navigate,
}));

const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() }));
vi.mock('@/lib/api/weldbooks-client', () => ({ weldbooksApi: api, setWeldbooksEntityId: vi.fn() }));

const perms = vi.hoisted(() => ({ granted: new Set<string>() }));
vi.mock('@weldsuite/permissions/react', () => ({ usePermissions: () => ({ can: (key: string) => perms.granted.has(key) }) }));

const jurisdiction = vi.hoisted(() => ({
  value: { isResolved: true, isError: false, features: { form1099: true } } as Record<string, unknown>,
}));
vi.mock('@/lib/weldbooks/use-jurisdiction', () => ({ useCurrentJurisdiction: () => jurisdiction.value }));
vi.mock('@/lib/weldbooks/use-weldbooks-format', () => ({
  useWeldbooksFormat: () => ({ formatMoney: (v: number | string) => `$${Number(v).toFixed(2)}`, formatDate: (v: string) => `on ${v}`, today: () => '2027-01-20' }),
}));
vi.mock('@/components/access-denied-empty-state', () => ({
  AccessDeniedEmptyState: ({ permission }: { permission: string }) => <div data-testid="access-denied">{permission}</div>,
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() } }));

import Form1099CenterPage from './page';

function vendor(overrides: Partial<Form1099VendorRow> = {}): Form1099VendorRow {
  return {
    partyId: 'p1',
    name: 'Acme Plumbing',
    legalName: 'Acme Plumbing',
    status: 'included',
    reasons: [],
    forms: ['nec'],
    boxes: { nec_1: 2500 },
    totals: { nec_1: 2500 },
    aboveThreshold: true,
    isCorporation: false,
    isAttorney: false,
    tinType: 'ein',
    tinLast4: '6789',
    tinMasked: '**-***6789',
    hasTin: true,
    tinMatchStatus: null,
    tinMatchedAt: null,
    backupWithholding: false,
    suggestBackupWithholding: false,
    addressComplete: true,
    address: null,
    hasW9: true,
    eDeliveryConsent: false,
    excluded: { cardOrNetwork: 0, creditCardAccount: 0, payroll: 0, omittedBox: 0 },
    unmappedAmount: 0,
    adjustmentCount: 0,
    paymentCount: 1,
    bankTransactionCount: 0,
    ...overrides,
  };
}

const summary: Form1099Summary = {
  taxYear: 2026,
  entityId: 'e1',
  thresholds: { published: true, general: 2000, royalty: 10, fixed600: 600, boxes: {} },
  deadlines: {
    taxYear: 2026,
    nec: { recipient: '2027-02-01', irs: '2027-02-01' },
    misc: { recipient: '2027-02-01', recipientBoxes8And10: '2027-02-16', irsPaper: '2027-03-01', irsElectronic: '2027-03-31' },
    form945: '2027-02-01',
  },
  summary: { included: 2, below_threshold: 1, excluded_corporation: 0, needs_tin: 1, needs_address: 0, not_1099_vendor: 0 },
  totals: { nec: 5000, misc: 1200, withheld: 240 },
  vendors: [
    vendor({ partyId: 'a', name: 'Alpha' }),
    vendor({ partyId: 'b', name: 'Bravo' }),
    vendor({ partyId: 'c', name: 'Charlie', status: 'needs_tin', hasTin: false, tinLast4: null, tinMasked: null }),
    vendor({ partyId: 'd', name: 'Delta', status: 'below_threshold', boxes: {}, totals: { nec_1: 100 }, aboveThreshold: false }),
  ],
  warnings: ['Charlie needs a TIN: collect a W-9 before filing.'],
};

const deadlines = {
  ...summary.deadlines,
  eFile: { requiredFrom: 10, waiverRequestDays: 45, necWaiverDeadline: '2026-12-18', miscWaiverDeadline: '2027-01-15' },
};

function serve(overrides: Record<string, unknown> = {}) {
  api.get.mockImplementation(async (path: string) => {
    for (const [prefix, body] of Object.entries(overrides)) if (path.startsWith(prefix)) return body;
    if (path.startsWith('/form-1099/summary')) return { data: summary };
    if (path.startsWith('/form-1099/deadlines')) return { data: deadlines };
    if (path.startsWith('/form-1099/filings')) return { data: [], pagination: { totalCount: 0, hasMore: false, cursor: null } };
    if (path.startsWith('/form-1099/945')) return { data: { taxYear: 2026, backupWithholding: 0, totalTaxes: 0, months: [], byVendor: [], dueDate: '2027-02-01' } };
    throw new Error(`unexpected GET ${path}`);
  });
}

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <I18nProvider initialLanguage="en">
        <Form1099CenterPage />
      </I18nProvider>
    </QueryClientProvider>,
  );
}

beforeAll(() => {
  const proto = window.HTMLElement.prototype as unknown as Record<string, unknown>;
  proto.hasPointerCapture ??= () => false;
  proto.setPointerCapture ??= () => undefined;
  proto.releasePointerCapture ??= () => undefined;
  proto.scrollIntoView ??= () => undefined;
});

beforeEach(() => {
  api.get.mockReset();
  api.post.mockReset();
  router.search = { year: 2026 };
  router.navigate.mockReset();
  perms.granted = new Set(['taxes:read', 'taxes:create', 'taxes:update', 'taxes:file', 'tax_ids:reveal']);
  jurisdiction.value = { isResolved: true, isError: false, features: { form1099: true } };
  serve();
});

afterEach(cleanup);

describe('1099 Center', () => {
  it('is for US entities: another jurisdiction gets a notice and no request', async () => {
    jurisdiction.value = { isResolved: true, isError: false, features: { form1099: false } };
    renderPage();
    expect(await screen.findByTestId('form1099-unavailable')).toBeTruthy();
    expect(api.get).not.toHaveBeenCalled();
  });

  it('asks for access when the user may not view taxes, and requests nothing', () => {
    perms.granted = new Set();
    renderPage();
    expect(screen.getByTestId('access-denied').textContent).toBe('taxes:read');
    expect(api.get).not.toHaveBeenCalled();
  });

  it('waits for the jurisdiction before deciding', () => {
    jurisdiction.value = { isResolved: false, isError: false, features: { form1099: false } };
    renderPage();
    expect(screen.queryByTestId('form1099-unavailable')).toBeNull();
    expect(api.get).not.toHaveBeenCalled();
  });

  it('shows the year at a glance: who is to be filed, who needs attention, the totals and the threshold', async () => {
    renderPage();
    expect(await screen.findByTestId('stat-to-file')).toBeTruthy();
    expect(screen.getByTestId('stat-to-file').textContent).toBe('3');
    expect(screen.getByTestId('stat-attention').textContent).toBe('1');
    expect(screen.getByTestId('stat-below').textContent).toBe('1');
    expect(screen.getByTestId('stat-withheld').textContent).toBe('$240.00');
    expect(screen.getByText('NEC $5000.00 · MISC $1200.00')).toBeTruthy();
    expect(screen.getByTestId('threshold-note').textContent).toMatch(/Payments made in 2026 are reported from \$2000\.00/);
    expect(api.get).toHaveBeenCalledWith('/form-1099/summary?year=2026');
  });

  it('lists the vendors with their statuses and the warnings the computation raised', async () => {
    renderPage();
    const alpha = await screen.findByTestId('review-row-a');
    expect(within(alpha).getByText('Goes on a form')).toBeTruthy();
    expect(within(screen.getByTestId('review-row-c')).getByText('Needs a TIN')).toBeTruthy();
    expect(screen.queryByTestId('review-row-d')).toBeNull();
    expect(within(screen.getByTestId('review-warnings')).getByText('Charlie needs a TIN: collect a W-9 before filing.')).toBeTruthy();
  });

  it('counts down to the deadline and shows an overdue one as an error', async () => {
    renderPage();
    const banner = await screen.findByTestId('deadlines-banner');
    expect(within(banner).getByText(/Recipient copies and 1099-NEC filings are due on 2027-02-01/)).toBeTruthy();
    expect(within(banner).getByText(/Filing 10 or more information returns/)).toBeTruthy();
  });

  it('says so when the review could not be loaded, and tries again', async () => {
    api.get.mockImplementation(async (path: string) => {
      if (path.startsWith('/form-1099/summary')) throw new Error('boom');
      return { data: deadlines };
    });
    const user = userEvent.setup();
    renderPage();
    expect(await screen.findByText('The 1099 review could not be loaded.')).toBeTruthy();
    serve();
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByTestId('stat-to-file')).toBeTruthy();
  });

  it('switches the year and the tab through the address', async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByTestId('stat-to-file');
    await user.click(screen.getByRole('tab', { name: 'Filings' }));
    const call = router.navigate.mock.calls.at(-1)![0] as { search: (prev: Record<string, unknown>) => Record<string, unknown>; replace: boolean };
    expect(call.search({ year: 2026 })).toEqual({ year: 2026, tab: 'filings' });
    expect(call.replace).toBe(true);
  });

  it('opens on the tab in the address', async () => {
    router.search = { year: 2026, tab: 'filings' };
    renderPage();
    expect(await screen.findByTestId('filing-card-nec')).toBeTruthy();
    // Three vendors would go on a 1099-NEC, and a draft can be started by someone who may create filings.
    expect(screen.getByText('3 vendors would go on a 1099-NEC.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Create 1099-NEC filing' })).toBeTruthy();
    expect(screen.getByText('Nobody goes on a 1099-MISC for this year.')).toBeTruthy();
  });

  it('starts a filing and opens it', async () => {
    router.search = { year: 2026, tab: 'filings' };
    api.post.mockResolvedValue({ data: { filing: { id: 'f9', formType: 'nec', taxYear: 2026, status: 'draft', lineCount: 3, totals: { amount: 0, withheld: 0 }, statusCounts: {} }, lines: [], warnings: [] } });
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole('button', { name: 'Create 1099-NEC filing' }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/form-1099/filings', { taxYear: 2026, formType: 'nec' }));
    await waitFor(() => expect(router.navigate).toHaveBeenCalledWith({ to: '/weldbooks/form-1099/filings/$id', params: { id: 'f9' } }));
  });

  it('opens the filing that already exists when a second one is started', async () => {
    router.search = { year: 2026, tab: 'filings' };
    api.post.mockRejectedValue(Object.assign(new Error('There is already a 1099-NEC filing'), { body: { error: { details: { filingId: 'f_existing' } } } }));
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole('button', { name: 'Create 1099-NEC filing' }));
    await waitFor(() => expect(router.navigate).toHaveBeenCalledWith({ to: '/weldbooks/form-1099/filings/$id', params: { id: 'f_existing' } }));
  });

  it('shows the filings that exist, with their status', async () => {
    router.search = { year: 2026, tab: 'filings' };
    serve({
      '/form-1099/filings': {
        data: [
          { id: 'f1', entityId: 'e1', taxYear: 2026, formType: 'nec', status: 'generated', filedAt: null, confirmationNumber: null, lineCount: 3, totals: { amount: 5000, withheld: 0 }, statusCounts: {} },
          { id: 'f0', entityId: 'e1', taxYear: 2025, formType: 'misc', status: 'filed', filedAt: '2026-01-30T00:00:00.000Z', confirmationNumber: 'X', lineCount: 1, totals: { amount: 900, withheld: 0 }, statusCounts: {} },
        ],
        pagination: { totalCount: 2, hasMore: false, cursor: null },
      },
    });
    renderPage();
    const card = await screen.findByTestId('filing-card-nec');
    await waitFor(() => expect(within(card).getByText('Generated')).toBeTruthy());
    expect(within(card).getByRole('link', { name: 'Open filing' }).getAttribute('href')).toBe('/weldbooks/form-1099/filings/f1');
    expect(screen.getByRole('link', { name: '1099-MISC · 2025' }).getAttribute('href')).toBe('/weldbooks/form-1099/filings/f0');
  });

  it('shows Form 945 only when it is opened', async () => {
    router.search = { year: 2026, tab: 'form-945' };
    renderPage();
    expect(await screen.findByTestId('form945-empty')).toBeTruthy();
    expect(api.get).toHaveBeenCalledWith('/form-1099/945?year=2026');
  });
});
