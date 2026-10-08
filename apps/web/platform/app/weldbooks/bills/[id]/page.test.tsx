import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const env = vi.hoisted(() => ({
  bill: null as unknown,
  us: true,
  approve: vi.fn(),
  toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock('sonner', () => ({ toast: env.toast }));
vi.mock('@tanstack/react-router', async () => {
  const { RouteLink } = await import('@/app/weldbooks/invoices/components/test-utils');
  return { Link: RouteLink, useParams: () => ({ id: 'bil_1' }), useNavigate: () => vi.fn() };
});
vi.mock('@/lib/router', async () => {
  const { HrefLink } = await import('@/app/weldbooks/invoices/components/test-utils');
  return { Link: HrefLink };
});
vi.mock('@/hooks/queries/use-accounting-queries', () => ({
  useAccountingBill: () => ({ data: { data: env.bill }, isLoading: false }),
  useApproveBill: () => ({ mutate: env.approve, isPending: false }),
  useRejectBill: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock('@/lib/weldbooks/use-jurisdiction', () => ({
  useJurisdictionLabels: () => ({
    labels: { tax: 'Tax' },
    features: { salesTax: env.us, form1099: env.us },
  }),
}));
vi.mock('@/lib/weldbooks/use-weldbooks-format', () => ({
  useWeldbooksFormat: () => ({
    formatMoney: (value: number | string | null | undefined) => `$${Number(value ?? 0).toFixed(2)}`,
    formatDate: (value: string | null | undefined) => value ?? '-',
  }),
}));
vi.mock('@/lib/api/domains/weldbooks', () => ({ accountingApi: { getBillAttachment: vi.fn() } }));
vi.mock('@/components/page-loader', () => ({ PageLoader: () => null }));

import BillDetailPage from './page';
import { renderWithProviders } from '@/app/weldbooks/invoices/components/test-utils';

function bill(overrides: Record<string, unknown> = {}) {
  return {
    id: 'bil_1',
    billNumber: 'BILL-1',
    type: 'standard',
    status: 'approved',
    approvalStatus: 'approved',
    contactId: 'sup_1',
    contactName: 'Dell',
    issueDate: '2026-03-01',
    dueDate: '2026-03-31',
    currency: 'USD',
    subtotal: '1000.00',
    taxTotal: '82.50',
    total: '1082.50',
    amountPaid: '0',
    balanceDue: '1082.50',
    externalReference: 'D-77',
    notes: null,
    internalNotes: null,
    createdAt: '2026-03-01T00:00:00Z',
    vendorAddress: { line1: '1 Dell Way', city: 'Round Rock', state: 'TX', postalCode: '78682', country: 'US' },
    deliveryAddress: { line1: '5 Depot Way', city: 'Dallas', state: 'TX', postalCode: '75001', country: 'US' },
    taxBreakdown: [
      {
        taxRateName: 'Texas',
        taxRate: 6.25,
        taxableAmount: 1000,
        taxAmount: 62.5,
        jurisdictionCode: 'TX',
        jurisdictionName: 'Texas',
        jurisdictionLevel: 'state',
        kind: 'use',
        selfAssessed: true,
      },
    ],
    items: [
      {
        id: 'bli_1',
        billId: 'bil_1',
        description: 'Laptop',
        quantity: '1',
        unitPrice: '1000.00',
        unit: null,
        discountPercent: '0',
        taxRateId: null,
        taxRate: '8.25',
        taxAmount: '82.50',
        lineTotal: '1000.00',
        lineTotalWithTax: '1082.50',
        accountId: 'acc_1',
        sortOrder: 0,
        taxCode: 'general',
        accrueUseTax: true,
        form1099Box: 'omit',
      },
      {
        id: 'bli_2',
        billId: 'bil_1',
        description: 'Desk',
        quantity: '1',
        unitPrice: '300.00',
        unit: null,
        discountPercent: '0',
        taxRateId: null,
        taxRate: null,
        taxAmount: '0.00',
        lineTotal: '300.00',
        lineTotalWithTax: '300.00',
        accountId: 'acc_1',
        sortOrder: 1,
        taxCode: null,
        accrueUseTax: false,
        form1099Box: null,
      },
    ],
    ...overrides,
  };
}

describe('BillDetailPage: sales tax', () => {
  beforeEach(() => {
    env.bill = bill();
    env.us = true;
    env.approve.mockReset();
    Object.values(env.toast).forEach((fn) => fn.mockReset());
  });

  it('shows the use tax the bill accrued apart from the vendor tax, and the delivery address', () => {
    renderWithProviders(<BillDetailPage />);

    const card = screen.getByTestId('use-tax-card');
    expect(within(card).getByText('Use tax accrued')).toBeInTheDocument();
    expect(within(card).getByText('$62.50')).toBeInTheDocument();
    expect(within(card).getByText('6.25% on $1000.00')).toBeInTheDocument();

    expect(screen.getByText('Delivery address')).toBeInTheDocument();
    expect(screen.getByText('5 Depot Way')).toBeInTheDocument();
    expect(screen.getByText('Sales tax paid (part of cost)')).toBeInTheDocument();
  });

  it('shows the tax code, the use tax flag and the 1099 box of a line', () => {
    renderWithProviders(<BillDetailPage />);
    expect(screen.getByText('General goods · Accrue use tax · Omit from 1099')).toBeInTheDocument();
  });

  it('offers to create a fixed asset from each line of an approved bill', () => {
    renderWithProviders(<BillDetailPage />);

    const links = screen.getAllByRole('link', { name: 'Create fixed asset' });
    expect(links.map((link) => link.getAttribute('href'))).toEqual([
      '/weldbooks/fixed-assets/new?billItemId=bli_1',
      '/weldbooks/fixed-assets/new?billItemId=bli_2',
    ]);
  });

  it('does not offer fixed assets for a bill that is not approved yet', () => {
    env.bill = bill({ status: 'draft', approvalStatus: 'pending' });
    renderWithProviders(<BillDetailPage />);
    expect(screen.queryByRole('link', { name: 'Create fixed asset' })).not.toBeInTheDocument();
  });

  it('shows a refused approval as a notice when the tax engine is down, with a link to the settings', async () => {
    const user = userEvent.setup();
    env.bill = bill({ status: 'pending_approval', approvalStatus: 'pending', taxBreakdown: [] });
    env.approve.mockImplementation((_id, options) =>
      options.onError(Object.assign(new Error('refused'), { code: 'TAX_ENGINE_UNAVAILABLE', status: 503 })),
    );
    renderWithProviders(<BillDetailPage />);

    await user.click(screen.getByRole('button', { name: 'Approve' }));

    const notice = screen.getByTestId('sales-tax-error');
    expect(notice).toHaveTextContent('The sales tax engine is not reachable right now, so nothing was posted.');
    expect(within(notice).getByRole('link', { name: 'Open sales tax settings' })).toBeInTheDocument();
    expect(env.toast.error).not.toHaveBeenCalled();
  });

  it('keeps a Dutch bill as it was: no use tax, delivery address or fixed assets', () => {
    env.us = false;
    env.bill = bill({
      currency: 'EUR',
      deliveryAddress: null,
      taxBreakdown: null,
      items: [{ ...(bill().items as object[])[0], taxCode: null, accrueUseTax: false, form1099Box: null }],
    });
    renderWithProviders(<BillDetailPage />);

    expect(screen.queryByTestId('use-tax-card')).not.toBeInTheDocument();
    expect(screen.queryByText('Delivery address')).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Create fixed asset' })).not.toBeInTheDocument();
    expect(screen.queryByText('Sales tax paid (part of cost)')).not.toBeInTheDocument();
  });
});
