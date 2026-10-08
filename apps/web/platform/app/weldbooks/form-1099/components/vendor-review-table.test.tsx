import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { I18nProvider } from '@weldsuite/i18n/provider';
import type { Form1099VendorRow } from '@/lib/api/domains/weldbooks-1099';

vi.mock('@tanstack/react-router', () => ({
  Link: ({ to, params, children, ...rest }: { to: string; params?: Record<string, string>; children: React.ReactNode }) => (
    <a href={Object.entries(params ?? {}).reduce((href, [key, value]) => href.replace(`$${key}`, value), to)} {...rest}>
      {children}
    </a>
  ),
}));
vi.mock('@/lib/api/weldbooks-client', () => ({ weldbooksApi: { get: vi.fn(), post: vi.fn(), patch: vi.fn() }, setWeldbooksEntityId: vi.fn() }));
vi.mock('@weldsuite/permissions/react', () => ({ usePermissions: () => ({ can: () => true }) }));
vi.mock('@/lib/weldbooks/use-weldbooks-format', () => ({
  useWeldbooksFormat: () => ({ formatMoney: (value: number) => `$${value.toFixed(2)}`, formatDate: (v: string) => v }),
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { VendorReviewTable } from './vendor-review-table';

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

const rows: Form1099VendorRow[] = [
  vendor({ partyId: 'inc', name: 'Included Inc', legalName: 'Included Inc' }),
  vendor({
    partyId: 'tin',
    name: 'No Tin Co',
    legalName: 'No Tin Co',
    status: 'needs_tin',
    reasons: ['Collect a W-9 before filing.'],
    hasTin: false,
    tinLast4: null,
    tinMasked: null,
    hasW9: false,
  }),
  vendor({ partyId: 'addr', name: 'No Address Co', legalName: 'No Address Co', status: 'needs_address', addressComplete: false }),
  vendor({
    partyId: 'low',
    name: 'Small Fry',
    legalName: 'Small Fry',
    status: 'below_threshold',
    boxes: {},
    totals: { nec_1: 150 },
    aboveThreshold: false,
    reasons: ['Paid $150.00, below the $2,000.00 threshold.'],
  }),
  vendor({ partyId: 'corp', name: 'Big Corp', legalName: 'Big Corp', status: 'excluded_corporation', boxes: {}, isCorporation: true }),
  vendor({
    partyId: 'not',
    name: 'Unflagged',
    legalName: 'Unflagged',
    status: 'not_1099_vendor',
    boxes: {},
    totals: { nec_1: 4000 },
    aboveThreshold: true,
  }),
  vendor({
    partyId: 'mismatch',
    name: 'Mismatch LLC',
    legalName: 'Mismatch LLC',
    tinMatchStatus: 'mismatch',
    suggestBackupWithholding: true,
  }),
  vendor({ partyId: 'unmapped', name: 'Unmapped Ltd', legalName: 'Unmapped Ltd', unmappedAmount: 300, boxes: { misc_1: 1200, nec_1: 800 }, forms: ['nec', 'misc'] }),
];

function renderTable(onOpenDetails = vi.fn(), initialFilter?: 'all' | 'to_file') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <I18nProvider initialLanguage="en">
        <VendorReviewTable vendors={rows} onOpenDetails={onOpenDetails} initialFilter={initialFilter} />
      </I18nProvider>
    </QueryClientProvider>,
  );
  return { onOpenDetails };
}

afterEach(cleanup);

const row = (id: string) => within(screen.getByTestId(`review-row-${id}`));

describe('VendorReviewTable', () => {
  it('opens on the vendors that go on a form, with a count on every filter', () => {
    renderTable();
    expect(screen.queryByTestId('review-row-low')).toBeNull();
    expect(screen.queryByTestId('review-row-corp')).toBeNull();
    expect(screen.queryByTestId('review-row-not')).toBeNull();
    for (const id of ['inc', 'tin', 'addr', 'mismatch', 'unmapped']) expect(screen.getByTestId(`review-row-${id}`)).toBeTruthy();

    const filter = (name: RegExp) => screen.getByRole('button', { name });
    expect(filter(/^All\s*8$/).getAttribute('aria-pressed')).toBe('false');
    expect(filter(/^To file\s*5$/).getAttribute('aria-pressed')).toBe('true');
    expect(filter(/^Need attention\s*5$/)).toBeTruthy();
    expect(filter(/^Below threshold\s*1$/)).toBeTruthy();
    expect(filter(/^Corporations\s*1$/)).toBeTruthy();
    expect(filter(/^Not 1099 vendors\s*1$/)).toBeTruthy();
  });

  it('shows each status with its own label', () => {
    renderTable(vi.fn(), 'all');
    expect(row('inc').getByText('Goes on a form')).toBeTruthy();
    expect(row('tin').getByText('Needs a TIN')).toBeTruthy();
    expect(row('addr').getByText('Needs an address')).toBeTruthy();
    expect(row('low').getByText('Below the threshold')).toBeTruthy();
    expect(row('corp').getByText('Corporation, no form needed')).toBeTruthy();
    expect(row('not').getByText('Not a 1099 vendor')).toBeTruthy();
  });

  it('shows the reasons the computation gave', () => {
    renderTable(vi.fn(), 'all');
    expect(row('tin').getByText('Collect a W-9 before filing.')).toBeTruthy();
    expect(row('low').getByText('Paid $150.00, below the $2,000.00 threshold.')).toBeTruthy();
  });

  it('shows the boxes the vendor goes on, in order, with their amounts', () => {
    renderTable(vi.fn(), 'all');
    const items = row('unmapped').getAllByRole('listitem').map((li) => li.textContent);
    expect(items).toEqual(['NEC 1$800.00', 'MISC 1$1200.00']);
  });

  it('shows what a vendor under the threshold was paid, marked as not reported', () => {
    renderTable(vi.fn(), 'all');
    expect(row('low').getByText('NEC 1')).toBeTruthy();
    expect(row('low').getByText('$150.00')).toBeTruthy();
    expect(row('low').getByText('Not reported')).toBeTruthy();
    expect(row('inc').queryByText('Not reported')).toBeNull();
  });

  it('shows the TIN masked, a missing TIN, and the IRS match result', () => {
    renderTable(vi.fn(), 'all');
    expect(row('inc').getByText('**-***6789')).toBeTruthy();
    expect(row('tin').getByText('No TIN')).toBeTruthy();
    expect(row('mismatch').getByText('IRS mismatch')).toBeTruthy();
  });

  it('marks addresses and W-9s as present or missing', () => {
    renderTable(vi.fn(), 'all');
    expect(row('addr').getByText('Mailing address incomplete')).toBeTruthy();
    expect(row('inc').getByText('Complete mailing address')).toBeTruthy();
    expect(row('tin').getByText('No W-9')).toBeTruthy();
    expect(row('inc').getByText('W-9 received')).toBeTruthy();
  });

  it('links a missing TIN or address to the vendor form, and offers backup withholding after a failed match', () => {
    renderTable(vi.fn(), 'all');
    const addTin = row('tin').getByRole('link', { name: 'Add TIN' });
    expect(addTin.getAttribute('href')).toBe('/weldbooks/customers/tin/edit');
    expect(row('addr').getByRole('link', { name: 'Add address' }).getAttribute('href')).toBe('/weldbooks/customers/addr/edit');
    expect(row('not').getByRole('link', { name: 'Mark as 1099 vendor' }).getAttribute('href')).toBe('/weldbooks/customers/not/edit');
    expect(row('unmapped').getByRole('link', { name: 'Set a box' })).toBeTruthy();
    expect(row('unmapped').getByText('$300.00 has no box yet')).toBeTruthy();
    expect(row('mismatch').getByRole('button', { name: 'Turn on backup withholding' })).toBeTruthy();
    expect(row('inc').queryByRole('link', { name: /Add|Mark|Set/ })).toBeNull();
  });

  it('narrows to the vendors that need attention', async () => {
    const user = userEvent.setup();
    renderTable();
    await user.click(screen.getByRole('button', { name: /^Need attention/ }));
    for (const id of ['tin', 'addr', 'mismatch', 'unmapped', 'not']) expect(screen.getByTestId(`review-row-${id}`)).toBeTruthy();
    expect(screen.queryByTestId('review-row-inc')).toBeNull();
  });

  it('searches by name', async () => {
    const user = userEvent.setup();
    renderTable(vi.fn(), 'all');
    await user.type(screen.getByRole('searchbox', { name: 'Search vendors' }), 'small');
    expect(screen.getByTestId('review-row-low')).toBeTruthy();
    expect(screen.queryByTestId('review-row-inc')).toBeNull();
    await user.clear(screen.getByRole('searchbox', { name: 'Search vendors' }));
    await user.type(screen.getByRole('searchbox', { name: 'Search vendors' }), 'zzz');
    expect(screen.getByTestId('review-empty').textContent).toMatch(/No vendors match this filter/);
  });

  it('opens the payments behind a vendor', async () => {
    const user = userEvent.setup();
    const { onOpenDetails } = renderTable(vi.fn(), 'all');
    await user.click(row('inc').getByRole('button', { name: 'Payments' }));
    expect(onOpenDetails).toHaveBeenCalledWith('inc');
  });
});
