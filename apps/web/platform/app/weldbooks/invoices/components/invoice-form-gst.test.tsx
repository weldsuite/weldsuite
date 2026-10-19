/**
 * The invoice form of an India entity (TASK-1112): HSN/SAC on each line, the
 * place of supply, and the CGST / SGST / IGST rows the server calculated.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { InvoiceDetail } from '@/lib/api/domains/weldbooks';
import type { TaxPreviewRequest } from '@/lib/api/domains/weldbooks-sales-tax-preview';
import type { TaxPreviewState } from '@/hooks/queries/use-weldbooks-tax-preview';

const env = vi.hoisted(() => ({
  updateMutate: vi.fn(),
  createMutate: vi.fn(),
  previewState: null as unknown,
  requests: [] as unknown[],
}));

// The live PDF preview has its own data and is not what these tests cover.
vi.mock('./invoice-preview', () => ({ InvoicePreview: () => null }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('@/lib/router', async () => {
  const { HrefLink } = await import('./test-utils');
  return { Link: HrefLink, useRouter: () => ({ push: vi.fn(), back: vi.fn() }) };
});
vi.mock('@tanstack/react-router', async () => {
  const { RouteLink } = await import('./test-utils');
  return { Link: RouteLink };
});
vi.mock('@/hooks/queries/use-accounting-queries', () => ({
  useCreateInvoice: () => ({ mutateAsync: env.createMutate }),
  useSendInvoice: () => ({ mutateAsync: vi.fn() }),
  useUpdateInvoice: () => ({ mutateAsync: env.updateMutate }),
  useAccountingCustomer: () => ({ data: { data: { id: 'cus_1', name: 'Mumbai Traders', paymentTermsDays: 30, billingAddress: null, shippingAddress: null } } }),
  useAccountingCustomers: () => ({ data: { data: [{ id: 'cus_1', name: 'Mumbai Traders' }] } }),
  useAccountingTaxRates: () => ({ data: { data: [{ id: 'tax_18', name: 'GST 18%', rate: '18', type: 'both' }] } }),
  useDimensionValues: () => ({ data: [] }),
}));
vi.mock('@/lib/weldbooks/use-jurisdiction', () => {
  const labels = { tax: 'GST', taxRate: 'GST rate', noTax: 'No GST', creditNote: 'Credit note' };
  const features = { salesTax: false, form1099: false, gstReturn: true, vatReturn: false };
  return {
    useCurrentJurisdiction: () => ({ features, isResolved: true, code: 'IN' }),
    useJurisdictionLabels: () => ({ labels, features, isResolved: true }),
  };
});
vi.mock('@/lib/weldbooks/use-weldbooks-format', () => ({
  useWeldbooksFormat: () => ({
    currency: 'INR',
    entityCurrency: 'INR',
    formatMoney: (value: number | string) => `₹${Number(value).toFixed(2)}`,
    formatDate: (value: string) => value,
    today: () => '2026-10-05',
    entity: { address: { line1: '12 Linking Road', city: 'Mumbai', state: 'Maharashtra', postalCode: '400050', country: 'IN' } },
  }),
}));
vi.mock('@/hooks/queries/use-weldbooks-tax-preview', () => ({
  useTaxPreview: (request: TaxPreviewRequest | null) => {
    env.requests.push(request);
    return env.previewState;
  },
  useProductOptions: () => ({ data: [] }),
  useProductSearch: () => async () => [],
}));

import { InvoiceForm } from './invoice-form';
import { polyfillRadixSelect, previewResult, renderWithProviders } from './test-utils';

const SPLIT = [
  { taxRateName: 'CGST 9%', taxRate: 9, taxableAmount: 1000, taxAmount: 90, component: 'cgst' },
  { taxRateName: 'SGST 9%', taxRate: 9, taxableAmount: 1000, taxAmount: 90, component: 'sgst' },
];

function previewState(overrides: Partial<TaxPreviewState['result'] & object> = {}): TaxPreviewState {
  return {
    result: previewResult({
      engine: null,
      shipToState: null,
      shipToPostalCode: null,
      subtotal: '1000.00',
      taxTotal: '180.00',
      total: '1180.00',
      lines: [{ index: 0, id: 'line_0', lineTotal: '1000.00', taxAmount: '180.00', lineTotalWithTax: '1180.00', taxRate: '18', taxRateId: 'tax_18', taxCode: null }],
      taxBreakdown: SPLIT,
      placeOfSupply: '27',
      ...overrides,
    }),
    isCalculating: false,
    error: null,
    errorCode: null,
    isStale: false,
  };
}

function invoice(overrides: Record<string, unknown> = {}): InvoiceDetail {
  return {
    id: 'inv_1',
    invoiceNumber: 'INV-0001',
    type: 'standard',
    status: 'draft',
    contactId: 'cus_1',
    contactName: 'Mumbai Traders',
    contactEmail: null,
    issueDate: '2026-10-05',
    dueDate: '2026-10-19',
    currency: 'INR',
    subtotal: '1000.00',
    taxTotal: '180.00',
    total: '1180.00',
    amountPaid: '0',
    balanceDue: '1180.00',
    reference: null,
    notes: null,
    internalNotes: null,
    createdAt: '2026-10-05T00:00:00Z',
    placeOfSupply: '27',
    billingAddress: { line1: '1 Main Road', city: 'Mumbai', state: 'Maharashtra', postalCode: '400001', country: 'IN' },
    shippingAddress: null,
    items: [
      {
        id: 'ili_1',
        invoiceId: 'inv_1',
        description: 'Consulting',
        quantity: '1.0000',
        unitPrice: '1000.0000',
        unit: null,
        discountPercent: '0.00',
        taxRateId: 'tax_18',
        taxRate: '18.0000',
        taxAmount: '180.00',
        lineTotal: '1000.00',
        lineTotalWithTax: '1180.00',
        accountId: null,
        sortOrder: 0,
        hsnSac: '998313',
        taxCode: null,
        taxUse: null,
        taxIncluded: false,
        taxOverrideAmount: null,
        taxOverrideReason: null,
        classId: null,
        locationId: null,
      },
    ],
    payments: [],
    ...overrides,
  } as unknown as InvoiceDetail;
}

const lastRequest = () => env.requests.at(-1) as TaxPreviewRequest | null;
const submit = (user: ReturnType<typeof userEvent.setup>) => user.click(screen.getByRole('button', { name: 'Update Invoice' }));

describe('InvoiceForm for an India entity', { timeout: 30_000 }, () => {
  beforeAll(polyfillRadixSelect);
  beforeEach(() => {
    env.updateMutate.mockReset().mockResolvedValue({});
    env.createMutate.mockReset().mockResolvedValue({});
    env.previewState = previewState();
    env.requests = [];
  });

  it('asks for the HSN/SAC of every line and the place of supply, and none of the US sales tax options', () => {
    renderWithProviders(<InvoiceForm mode="edit" invoice={invoice()} />);

    expect(screen.getByLabelText('HSN/SAC')).toHaveValue('998313');
    expect(screen.getByTestId('place-of-supply')).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Place of supply' })).toHaveTextContent('Maharashtra (27)');
    expect(screen.queryByLabelText('Override the tax')).not.toBeInTheDocument();
  });

  it('shows the CGST / SGST split the server calculated', () => {
    renderWithProviders(<InvoiceForm mode="edit" invoice={invoice()} />);

    const split = screen.getByTestId('gst-split');
    expect(within(split).getByText('CGST 9% on ₹1000.00')).toBeInTheDocument();
    expect(within(split).getByText('SGST 9% on ₹1000.00')).toBeInTheDocument();
    expect(within(split).getAllByText('₹90.00')).toHaveLength(2);
  });

  it('shows IGST for an inter-state supply', () => {
    env.previewState = previewState({
      taxBreakdown: [{ taxRateName: 'IGST 18%', taxRate: 18, taxableAmount: 1000, taxAmount: 180, component: 'igst' }],
      placeOfSupply: '29',
    });
    renderWithProviders(<InvoiceForm mode="edit" invoice={invoice({ placeOfSupply: null })} />);

    const split = screen.getByTestId('gst-split');
    expect(within(split).getByText('IGST 18% on ₹1000.00')).toBeInTheDocument();
    expect(within(split).queryByText(/CGST/)).not.toBeInTheDocument();
    // Automatic: the state the server derived is named next to it.
    expect(screen.getByRole('combobox', { name: 'Place of supply' })).toHaveTextContent('Automatic: Karnataka (29)');
  });

  it('sends a chosen place of supply with the tax preview and the update', async () => {
    const user = userEvent.setup();
    renderWithProviders(<InvoiceForm mode="edit" invoice={invoice()} />);

    await user.click(screen.getByRole('combobox', { name: 'Place of supply' }));
    await user.click(await screen.findByRole('option', { name: 'Karnataka (29)' }));
    expect(lastRequest()?.placeOfSupply).toBe('29');

    await submit(user);
    await waitFor(() => expect(env.updateMutate).toHaveBeenCalledTimes(1));
    const { data } = env.updateMutate.mock.calls[0][0];
    expect(data.placeOfSupply).toBe('29');
    expect(data.items[0]).toMatchObject({ hsnSac: '998313', taxRateId: 'tax_18' });
  });

  it('sends null on an update when the place of supply is left to the customer', async () => {
    const user = userEvent.setup();
    renderWithProviders(<InvoiceForm mode="edit" invoice={invoice({ placeOfSupply: null })} />);

    await submit(user);
    await waitFor(() => expect(env.updateMutate).toHaveBeenCalledTimes(1));
    expect(env.updateMutate.mock.calls[0][0].data.placeOfSupply).toBeNull();
    expect(lastRequest()).not.toHaveProperty('placeOfSupply');
  });

  it('refuses an HSN/SAC that is not 4 to 8 digits', async () => {
    const user = userEvent.setup();
    renderWithProviders(<InvoiceForm mode="edit" invoice={invoice()} />);

    const input = screen.getByLabelText('HSN/SAC');
    await user.clear(input);
    await user.type(input, '12ab');
    await submit(user);

    expect(await screen.findByText('HSN/SAC must be 4 to 8 digits')).toBeInTheDocument();
    expect(env.updateMutate).not.toHaveBeenCalled();
  });

  it('warns when the place of supply is not known', () => {
    env.previewState = previewState({ taxBreakdown: [{ taxRateName: 'GST 18%', taxRate: 18, taxableAmount: 1000, taxAmount: 180 }], placeOfSupply: null });
    renderWithProviders(<InvoiceForm mode="edit" invoice={invoice({ placeOfSupply: null })} />);

    expect(screen.getByTestId('place-of-supply-unknown')).toHaveTextContent(/cannot be split into CGST \+ SGST or IGST/);
    expect(screen.queryByTestId('gst-split')).not.toBeInTheDocument();
  });
});
