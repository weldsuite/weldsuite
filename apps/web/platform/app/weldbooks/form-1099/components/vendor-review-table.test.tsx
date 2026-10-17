import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
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

const names: Record<string, string> = {
  inc: 'Included Inc',
  tin: 'No Tin Co',
  addr: 'No Address Co',
  low: 'Small Fry',
  corp: 'Big Corp',
  not: 'Unflagged',
  mismatch: 'Mismatch LLC',
  unmapped: 'Unmapped Ltd',
};

/** The click target of a vendor's row; the list shows no such button for a vendor the filter leaves out. */
const rowButton = (id: string) => screen.queryByRole('button', { name: `Payments: ${names[id]}` });

/** The list row (a `group` div of the standard list) of a vendor. */
function row(id: string) {
  const button = rowButton(id);
  const element = button?.closest<HTMLElement>('div.group');
  if (!element) throw new Error(`No list row for ${id}`);
  return within(element);
}

/** The tooltip of the cell that shows `text` in a vendor's row. */
const titleOf = (id: string, text: string) => row(id).getByText(text).closest('[title]')?.getAttribute('title');

describe('VendorReviewTable', () => {
  it('opens on the vendors that go on a form, with a count on every filter', async () => {
    const user = userEvent.setup();
    renderTable();
    for (const id of ['low', 'corp', 'not']) expect(rowButton(id)).toBeNull();
    for (const id of ['inc', 'tin', 'addr', 'mismatch', 'unmapped']) expect(rowButton(id)).not.toBeNull();

    await user.click(screen.getByRole('button', { name: 'To file (5)' }));
    for (const name of ['All (8)', 'Need attention (5)', 'Below threshold (1)', 'Corporations (1)', 'Not 1099 vendors (1)']) {
      expect(await screen.findByRole('button', { name })).toBeTruthy();
    }
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

  it('gives the reasons the computation gave next to the status', () => {
    renderTable(vi.fn(), 'all');
    expect(row('tin').getByTitle('Collect a W-9 before filing.')).toBeTruthy();
    expect(row('low').getByTitle('Paid $150.00, below the $2,000.00 threshold.')).toBeTruthy();
  });

  it('shows what the boxes add up to, with each box and its amount on hover', () => {
    renderTable(vi.fn(), 'all');
    expect(row('unmapped').getByText('$2000.00')).toBeTruthy();
    expect(titleOf('unmapped', '$2000.00')).toBe('NEC 1: $800.00\nMISC 1: $1200.00');
  });

  it('shows what a vendor under the threshold was paid, marked as not reported', () => {
    renderTable(vi.fn(), 'all');
    expect(row('low').getByText('$150.00')).toBeTruthy();
    expect(titleOf('low', '$150.00')).toBe('NEC 1: $150.00\nNot reported');
    expect(titleOf('inc', '$2500.00')).not.toMatch(/Not reported/);
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
    expect(row('unmapped').getByTitle('$300.00 has no box yet')).toBeTruthy();
    expect(row('mismatch').getByRole('button', { name: 'Turn on backup withholding' })).toBeTruthy();
    expect(row('inc').queryByRole('link', { name: /Add|Mark|Set/ })).toBeNull();
  });

  it('narrows to the vendors that need attention', async () => {
    const user = userEvent.setup();
    renderTable();
    await user.click(screen.getByRole('button', { name: 'To file (5)' }));
    await user.click(await screen.findByRole('button', { name: 'Need attention (5)' }));
    await waitFor(() => expect(rowButton('inc')).toBeNull());
    for (const id of ['tin', 'addr', 'mismatch', 'unmapped', 'not']) expect(rowButton(id)).not.toBeNull();
  });

  it('searches by name', async () => {
    const user = userEvent.setup();
    renderTable(vi.fn(), 'all');
    const search = () => screen.getAllByPlaceholderText('Search vendors')[0];
    await user.type(search(), 'small');
    expect(rowButton('low')).not.toBeNull();
    expect(rowButton('inc')).toBeNull();
    await user.clear(search());
    await user.type(search(), 'zzz');
    expect(screen.getByText('No vendors match this filter.')).toBeTruthy();
  });

  it('opens the payments behind a vendor', async () => {
    const user = userEvent.setup();
    const { onOpenDetails } = renderTable(vi.fn(), 'all');
    await user.click(rowButton('inc')!);
    expect(onOpenDetails).toHaveBeenCalledWith('inc');
  });
});
