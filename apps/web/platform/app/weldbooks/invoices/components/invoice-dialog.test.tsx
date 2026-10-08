import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { TaxPreviewRequest } from '@/lib/api/domains/weldbooks-sales-tax-preview';
import type { TaxPreviewState } from '@/hooks/queries/use-weldbooks-tax-preview';

const env = vi.hoisted(() => ({
  salesTax: true,
  create: vi.fn(),
  previewState: null as unknown,
  requests: [] as unknown[],
  toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock('sonner', () => ({ toast: env.toast }));
vi.mock('@/lib/router', async () => {
  const { HrefLink } = await import('./test-utils');
  return { Link: HrefLink, useRouter: () => ({ push: vi.fn() }) };
});
vi.mock('@tanstack/react-router', async () => {
  const { RouteLink } = await import('./test-utils');
  return { Link: RouteLink };
});
vi.mock('@/hooks/queries/use-accounting-queries', () => ({
  useCreateInvoice: () => ({ mutateAsync: env.create }),
  useAccountingCustomer: () => ({
    data: {
      data: {
        id: 'cus_1',
        name: 'Globex',
        paymentTermsDays: 14,
        taxUse: 'business',
        billingAddress: { line1: '9 Dock Rd', city: 'Seattle', state: 'WA', postalCode: '98101', country: 'US' },
        shippingAddress: null,
      },
    },
  }),
  useAccountingCustomers: () => ({ data: { data: [{ id: 'cus_1', name: 'Globex', email: 'ap@globex.test' }] } }),
  useAccountingTaxRates: () => ({ data: { data: [{ id: 'tax_21', name: 'BTW 21%', rate: '21' }] } }),
  useDimensionValues: () => ({ data: [] }),
}));
vi.mock('@/lib/api/domains/weldbooks', () => ({ accountingApi: { listCustomers: async () => ({ data: [] }) } }));
vi.mock('@/lib/weldbooks/use-jurisdiction', () => {
  const labels = { tax: 'Sales tax', taxRate: 'Tax rate', noTax: 'No tax' };
  return {
    useCurrentJurisdiction: () => ({ features: { salesTax: env.salesTax, form1099: false }, isResolved: true }),
    useJurisdictionLabels: () => ({ labels, features: { salesTax: env.salesTax, form1099: false }, isResolved: true }),
  };
});
vi.mock('@/lib/weldbooks/use-weldbooks-format', () => ({
  useWeldbooksFormat: () => ({
    entityCurrency: 'USD',
    formatMoney: (value: number | string) => `$${Number(value).toFixed(2)}`,
    today: () => '2026-03-01',
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

vi.mock('./product-picker', () => ({ ProductPicker: () => null }));

import { InvoiceDialog } from './invoice-dialog';
import { polyfillRadixSelect, previewResult, renderWithProviders } from './test-utils';

function previewState(overrides: Partial<TaxPreviewState> = {}): TaxPreviewState {
  return { result: previewResult(), isCalculating: false, error: null, errorCode: null, isStale: false, ...overrides };
}

const lastRequest = () => env.requests.at(-1) as TaxPreviewRequest | null;

async function fillInvoice(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getAllByRole('combobox')[0]);
  await user.click(await screen.findByRole('option', { name: /Globex/ }));
  await user.type(screen.getByLabelText('Description'), 'Hosting');
  const price = screen.getByLabelText('Unit price');
  await user.clear(price);
  await user.type(price, '100');
}

describe('InvoiceDialog', { timeout: 30_000 }, () => {
  beforeAll(polyfillRadixSelect);
  beforeEach(() => {
    env.salesTax = true;
    env.create.mockReset().mockResolvedValue({ data: { id: 'inv_new' } });
    env.previewState = previewState();
    env.requests = [];
    Object.values(env.toast).forEach((fn) => fn.mockReset());
  });

  it('shows the totals of the server calculation and what the engine says about the sale', async () => {
    env.previewState = previewState({
      result: previewResult({ warnings: ['not_registered_in_state'], shipToState: 'WA', taxTotal: '0.00', total: '100.00' }),
    });
    renderWithProviders(<InvoiceDialog open onOpenChange={vi.fn()} />);

    expect(screen.getAllByText('$100.00').length).toBeGreaterThan(0);
    expect(screen.getByText('No sales tax: you are not registered to collect it in WA.')).toBeInTheDocument();
  });

  it('creates a US invoice with the sales tax fields of its lines, and asks the server for the tax of the customer and address', async () => {
    const user = userEvent.setup();
    const onCreated = vi.fn();
    renderWithProviders(<InvoiceDialog open onOpenChange={vi.fn()} onCreated={onCreated} />);

    await fillInvoice(user);
    expect(lastRequest()).toMatchObject({
      kind: 'invoice',
      contactId: 'cus_1',
      billingAddress: { city: 'Seattle', state: 'WA', postalCode: '98101' },
      items: [{ description: 'Hosting', unitPrice: '100', taxCode: null, taxIncluded: false }],
    });

    await user.click(screen.getByRole('button', { name: /Sales tax options/ }));
    await user.click(screen.getByLabelText('Price includes sales tax'));
    await user.click(screen.getByRole('button', { name: 'Create Invoice' }));

    await waitFor(() => expect(env.create).toHaveBeenCalledTimes(1));
    const payload = env.create.mock.calls[0][0];
    expect(payload).toMatchObject({ contactId: 'cus_1', currency: 'USD', marketplaceFacilitated: false });
    expect(payload.items[0]).toMatchObject({
      description: 'Hosting',
      quantity: '1',
      unitPrice: '100',
      taxRateId: null,
      taxIncluded: true,
      taxCode: null,
    });
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith({ id: 'inv_new' }));
  });

  it('keeps the VAT rate picker on a Dutch entity and sends the rate id', async () => {
    env.salesTax = false;
    env.previewState = previewState({ result: previewResult({ engine: null, shipToState: null }) });
    const user = userEvent.setup();
    renderWithProviders(<InvoiceDialog open onOpenChange={vi.fn()} />);

    await fillInvoice(user);
    expect(screen.queryByRole('button', { name: /Sales tax options/ })).not.toBeInTheDocument();
    await user.click(screen.getByRole('combobox', { name: 'Tax rate' }));
    await user.click(await screen.findByRole('option', { name: 'BTW 21%' }));
    expect(lastRequest()?.items[0]).toMatchObject({ taxRateId: 'tax_21' });

    await user.click(screen.getByRole('button', { name: 'Create Invoice' }));
    await waitFor(() => expect(env.create).toHaveBeenCalledTimes(1));
    const payload = env.create.mock.calls[0][0];
    expect(payload.items[0]).toMatchObject({ taxRateId: 'tax_21' });
    expect(payload.items[0]).not.toHaveProperty('taxCode');
    expect(payload).not.toHaveProperty('marketplaceFacilitated');
  });

  it('shows a sales tax refusal of the save in words', async () => {
    env.create.mockRejectedValue(Object.assign(new Error('refused'), { code: 'CREDIT_LINE_NOT_ON_ORIGINAL', status: 400 }));
    const user = userEvent.setup();
    renderWithProviders(<InvoiceDialog open onOpenChange={vi.fn()} />);

    await fillInvoice(user);
    await user.click(screen.getByRole('button', { name: 'Create Invoice' }));

    await waitFor(() => expect(env.toast.error).toHaveBeenCalledTimes(1));
    expect(env.toast.error.mock.calls[0][1]).toEqual({ description: 'A line of this credit memo is not on the original invoice.' });
  });
});
