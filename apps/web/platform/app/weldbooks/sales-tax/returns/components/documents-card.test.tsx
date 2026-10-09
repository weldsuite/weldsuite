import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() }));
vi.mock('@/lib/api/weldbooks-client', () => ({ weldbooksApi: api, setWeldbooksEntityId: vi.fn() }));
vi.mock('@tanstack/react-router', () => ({
  Link: ({ to, params, children }: { to: string; params?: Record<string, string>; children: React.ReactNode }) => (
    <a href={params ? to.replace('$id', params.id ?? '') : to}>{children}</a>
  ),
}));
const format = vi.hoisted(() => ({
  formatMoney: (value: number | string) => `$${Number(value).toFixed(2)}`,
  formatDate: (value: string | null) => value ?? '—',
}));
vi.mock('@/lib/weldbooks/use-weldbooks-format', () => ({ useWeldbooksFormat: () => format }));

import { DocumentsCard } from './documents-card';
import { renderWithProviders } from '../../shared/test-support';
import type { ReturnDocument } from '@/lib/api/domains/weldbooks-sales-tax-center';

function document(overrides: Partial<ReturnDocument> = {}): ReturnDocument {
  return {
    key: 'invoice|inv_1',
    document: {
      type: 'invoice',
      id: 'inv_1',
      number: 'INV-0042',
      contactId: 'cus_1',
      contactName: 'Acme Corp',
      date: '2026-08-12',
      status: 'sent',
      currency: 'USD',
      description: null,
    },
    taxDate: '2026-08-12',
    grossSales: 1000,
    taxableSales: 800,
    exemptSales: 150,
    nonTaxableSales: 50,
    tax: 70,
    useTax: 0,
    carried: false,
    certificateIds: ['cert_1'],
    certificates: [{ id: 'cert_1', certificateNumber: 'RS-1001', reason: 'resale', states: ['WA'], expiresOn: null, status: 'valid' }],
    rows: [
      {
        taxLineId: 'tl_1',
        sourceLineId: 'line_1',
        kind: 'sales',
        jurisdictionCode: 'WA',
        jurisdictionName: 'Washington',
        jurisdictionLevel: 'state',
        reportingCode: null,
        rate: 6.5,
        grossAmount: 1000,
        taxableAmount: 800,
        exemptAmount: 150,
        nonTaxableAmount: 50,
        taxAmount: 52,
        exemptReason: 'resale',
        certificateId: 'cert_1',
        taxCode: null,
        shipToState: 'WA',
        marketplaceFacilitated: false,
        share: 1,
        carried: false,
      },
      {
        taxLineId: 'tl_2',
        sourceLineId: 'line_1',
        kind: 'sales',
        jurisdictionCode: 'WA-SEA',
        jurisdictionName: 'Seattle',
        jurisdictionLevel: 'city',
        reportingCode: '1700',
        rate: 2.25,
        grossAmount: 1000,
        taxableAmount: 800,
        exemptAmount: 0,
        nonTaxableAmount: 0,
        taxAmount: 18,
        exemptReason: null,
        certificateId: null,
        taxCode: null,
        shipToState: 'WA',
        marketplaceFacilitated: false,
        share: 0.5,
        carried: false,
      },
    ],
    ...overrides,
  };
}

function page(documents: ReturnDocument[], pagination: { totalCount: number; hasMore: boolean; cursor: string | null }) {
  return { data: documents, pagination };
}

beforeEach(() => {
  api.get.mockReset();
  api.get.mockResolvedValue(page([document()], { totalCount: 1, hasMore: false, cursor: null }));
});

describe('DocumentsCard', () => {
  it('does not load anything until the tab is open', () => {
    renderWithProviders(<DocumentsCard returnId="txr_1" enabled={false} />);
    expect(api.get).not.toHaveBeenCalled();
  });

  it('lists the documents behind the return and links them', async () => {
    renderWithProviders(<DocumentsCard returnId="txr_1" enabled />);

    const row = await screen.findByTestId('document-row');
    expect(api.get).toHaveBeenCalledWith('/tax-returns/txr_1/documents?limit=100');
    expect(within(row).getByRole('link', { name: 'INV-0042' })).toHaveAttribute('href', '/weldbooks/invoices/inv_1');
    expect(row).toHaveTextContent('Acme Corp');
    expect(row).toHaveTextContent('$1000.00');
    expect(row).toHaveTextContent('$70.00');
    expect(screen.getByText('Showing 1 of 1')).toBeInTheDocument();
  });

  it('links a bill and a journal entry to their own pages', async () => {
    api.get.mockResolvedValue(
      page(
        [
          document({ key: 'bill|b1', document: { ...document().document, type: 'bill', id: 'b1', number: 'BILL-1' } }),
          document({ key: 'journal_entry|je1', document: { ...document().document, type: 'journal_entry', id: 'je1', number: 'JE-1', contactName: null, description: 'Use tax accrual' } }),
        ],
        { totalCount: 2, hasMore: false, cursor: null },
      ),
    );
    renderWithProviders(<DocumentsCard returnId="txr_1" enabled />);

    expect(await screen.findByRole('link', { name: 'BILL-1' })).toHaveAttribute('href', '/weldbooks/bills/b1');
    expect(screen.getByRole('link', { name: 'JE-1' })).toHaveAttribute('href', '/weldbooks/journal/je1');
    expect(screen.getByText('Use tax accrual')).toBeInTheDocument();
  });

  it('expands a document into its jurisdiction rows with the certificate it relied on', async () => {
    renderWithProviders(<DocumentsCard returnId="txr_1" enabled />);
    const user = userEvent.setup();

    const row = await screen.findByTestId('document-row');
    expect(screen.queryByText('Seattle')).not.toBeInTheDocument();
    await user.click(within(row).getByRole('button', { name: 'Show jurisdiction rows' }));

    expect(await screen.findByText('Seattle')).toBeInTheDocument();
    expect(screen.getByText('1700')).toBeInTheDocument();
    expect(screen.getByText('2.25%')).toBeInTheDocument();
    expect(screen.getByText('Certificate RS-1001')).toBeInTheDocument();
    expect(screen.getByText('Resale')).toBeInTheDocument();
    // A row counted in part (cash basis) says how much.
    expect(screen.getByText('50% counted')).toBeInTheDocument();

    await user.click(within(row).getByRole('button', { name: 'Hide jurisdiction rows' }));
    expect(screen.queryByText('Seattle')).not.toBeInTheDocument();
  });

  it('marks a row carried forward from an earlier period', async () => {
    api.get.mockResolvedValue(page([document({ carried: true })], { totalCount: 1, hasMore: false, cursor: null }));
    renderWithProviders(<DocumentsCard returnId="txr_1" enabled />);
    expect(await screen.findByText('Carried forward')).toBeInTheDocument();
  });

  it('loads the next page with the cursor the server gave', async () => {
    api.get
      .mockResolvedValueOnce(page([document()], { totalCount: 2, hasMore: true, cursor: '100' }))
      .mockResolvedValueOnce(
        page([document({ key: 'invoice|inv_2', document: { ...document().document, id: 'inv_2', number: 'INV-0043' } })], {
          totalCount: 2,
          hasMore: false,
          cursor: null,
        }),
      );
    renderWithProviders(<DocumentsCard returnId="txr_1" enabled />);
    const user = userEvent.setup();

    expect(await screen.findByText('Showing 1 of 2')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Load more documents' }));

    expect(await screen.findByRole('link', { name: 'INV-0043' })).toBeInTheDocument();
    expect(api.get).toHaveBeenLastCalledWith('/tax-returns/txr_1/documents?cursor=100&limit=100');
    expect(screen.getByText('Showing 2 of 2')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Load more documents' })).not.toBeInTheDocument();
  });

  it('says so when the period has no documents', async () => {
    api.get.mockResolvedValue(page([], { totalCount: 0, hasMore: false, cursor: null }));
    renderWithProviders(<DocumentsCard returnId="txr_1" enabled />);
    expect(await screen.findByText('No documents on this return')).toBeInTheDocument();
  });

  it('offers a retry when the documents cannot be loaded', async () => {
    api.get.mockRejectedValueOnce(Object.assign(new Error('Boom'), { status: 500, code: null, body: {} }));
    renderWithProviders(<DocumentsCard returnId="txr_1" enabled />);
    const user = userEvent.setup();

    expect(await screen.findByText('Could not load this page')).toBeInTheDocument();
    api.get.mockResolvedValue(page([document()], { totalCount: 1, hasMore: false, cursor: null }));
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(screen.getByTestId('document-row')).toBeInTheDocument());
  });
});
