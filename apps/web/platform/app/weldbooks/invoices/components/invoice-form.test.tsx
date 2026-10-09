import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { InvoiceDetail } from '@/lib/api/domains/weldbooks';
import type { TaxPreviewRequest } from '@/lib/api/domains/weldbooks-sales-tax-preview';
import type { TaxPreviewState } from '@/hooks/queries/use-weldbooks-tax-preview';

const env = vi.hoisted(() => ({
  salesTax: true,
  updateMutate: vi.fn(),
  createMutate: vi.fn(),
  previewState: null as unknown,
  requests: [] as unknown[],
}));

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
  useUpdateInvoice: () => ({ mutateAsync: env.updateMutate }),
  useAccountingCustomer: () => ({
    data: { data: { id: 'cus_1', name: 'Globex', paymentTermsDays: 30, taxUse: 'personal', billingAddress: null, shippingAddress: null } },
  }),
  useAccountingCustomers: () => ({ data: { data: [{ id: 'cus_1', name: 'Globex' }] } }),
  useAccountingTaxRates: () => ({ data: { data: [{ id: 'tax_21', name: 'BTW 21%', rate: '21' }] } }),
  useDimensionValues: () => ({
    data: [
      { id: 'dim_c1', entityId: 'e', dimension: 'class', name: 'Retail', code: null, parentId: null, isActive: true },
      { id: 'dim_l1', entityId: 'e', dimension: 'location', name: 'Austin', code: null, parentId: null, isActive: true },
    ],
  }),
}));
vi.mock('@/lib/weldbooks/use-jurisdiction', () => {
  const labels = { tax: 'Tax', taxRate: 'Tax rate', noTax: 'No tax' };
  return {
    useCurrentJurisdiction: () => ({ features: { salesTax: env.salesTax, form1099: false }, isResolved: true, code: 'US' }),
    useJurisdictionLabels: () => ({ labels, features: { salesTax: env.salesTax, form1099: false }, isResolved: true }),
  };
});
vi.mock('@/lib/weldbooks/use-weldbooks-format', () => ({
  useWeldbooksFormat: () => ({
    currency: 'USD',
    entityCurrency: 'USD',
    formatMoney: (value: number | string) => `$${Number(value).toFixed(2)}`,
    formatDate: (value: string) => value,
    today: () => '2026-03-01',
    entity: { address: { line1: '1 Main St', city: 'Austin', state: 'TX', postalCode: '78701', country: 'US' } },
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
vi.mock('./product-picker', () => ({
  ProductPicker: ({ onSelect }: Readonly<{ onSelect: (product: unknown) => void }>) => (
    <button type="button" onClick={() => onSelect({ id: 'prod_1', name: 'Hosting', price: 49, taxClass: 'saas' })}>
      pick product
    </button>
  ),
}));

import { InvoiceForm } from './invoice-form';
import { polyfillRadixSelect, previewResult, renderWithProviders } from './test-utils';

function previewState(overrides: Partial<TaxPreviewState> = {}): TaxPreviewState {
  return { result: previewResult(), isCalculating: false, error: null, errorCode: null, isStale: false, ...overrides };
}

function invoice(overrides: Record<string, unknown> = {}): InvoiceDetail {
  return {
    id: 'inv_1',
    invoiceNumber: 'INV-0001',
    type: 'standard',
    status: 'draft',
    contactId: 'cus_1',
    contactName: 'Globex',
    contactEmail: null,
    issueDate: '2026-03-01',
    dueDate: '2026-03-31',
    currency: 'USD',
    subtotal: '200.00',
    taxTotal: '16.50',
    total: '216.50',
    amountPaid: '0',
    balanceDue: '216.50',
    reference: null,
    notes: null,
    internalNotes: null,
    createdAt: '2026-03-01T00:00:00Z',
    billingAddress: { line1: '9 Dock Rd', city: 'Dallas', state: 'TX', postalCode: '75001', country: 'US' },
    shippingAddress: null,
    items: [
      {
        id: 'ili_1',
        invoiceId: 'inv_1',
        description: 'Consulting',
        quantity: '2.0000',
        unitPrice: '100.0000',
        unit: null,
        discountPercent: '0.00',
        taxRateId: null,
        taxRate: '8.2500',
        taxAmount: '16.50',
        lineTotal: '200.00',
        lineTotalWithTax: '216.50',
        accountId: null,
        sortOrder: 0,
        taxCode: 'saas',
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

async function submit(user: ReturnType<typeof userEvent.setup>, name = 'Update Invoice') {
  await user.click(screen.getByRole('button', { name }));
}

describe('InvoiceForm', { timeout: 30_000 }, () => {
  beforeAll(polyfillRadixSelect);
  beforeEach(() => {
    env.salesTax = true;
    env.updateMutate.mockReset().mockResolvedValue({});
    env.createMutate.mockReset().mockResolvedValue({});
    env.previewState = previewState();
    env.requests = [];
  });

  describe('US invoice', () => {
    it('shows the totals and the line tax the server calculated, not its own', () => {
      env.previewState = previewState({
        result: previewResult({
          subtotal: '200.00',
          taxTotal: '16.50',
          total: '216.50',
          lines: [{ index: 0, id: 'line_0', lineTotal: '200.00', taxAmount: '16.50', lineTotalWithTax: '216.50', taxRate: '8.25', taxRateId: null, taxCode: 'saas' }],
        }),
      });
      renderWithProviders(<InvoiceForm mode="edit" invoice={invoice()} />);

      expect(screen.getByText('$200.00')).toBeInTheDocument();
      expect(screen.getAllByText('$216.50').length).toBeGreaterThan(0);
      expect(screen.getByText('$16.50')).toBeInTheDocument();
      expect(screen.getByTestId('items-0-line-tax')).toHaveTextContent('Sales tax $16.50 (8.25%)');
    });

    it('asks the server for the tax of the form: customer, addresses, origin and the line settings', () => {
      renderWithProviders(<InvoiceForm mode="edit" invoice={invoice()} />);

      expect(lastRequest()).toMatchObject({
        kind: 'invoice',
        contactId: 'cus_1',
        issueDate: '2026-03-01',
        currency: 'USD',
        billingAddress: { line1: '9 Dock Rd', city: 'Dallas', state: 'TX', postalCode: '75001', country: 'US' },
        shippingAddress: null,
        shipFromAddress: null,
        marketplaceFacilitated: false,
        items: [{ description: 'Consulting', quantity: '2', unitPrice: '100', taxCode: 'saas', taxUse: null, taxIncluded: false }],
      });
    });

    it('requires a reason for an overridden tax, and does not save without one', async () => {
      const user = userEvent.setup();
      renderWithProviders(<InvoiceForm mode="edit" invoice={invoice()} />);

      // The line has its own tax code, so its options start open.
      await user.click(screen.getByLabelText('Override the tax'));
      await user.type(screen.getByLabelText('Tax amount'), '5');
      await submit(user);

      expect(await screen.findByText('Give a reason: an overridden tax needs one.')).toBeInTheDocument();
      expect(env.updateMutate).not.toHaveBeenCalled();
      // An override without its reason stays out of the calculation too.
      expect(lastRequest()?.items[0]).not.toHaveProperty('taxOverrideAmount');

      await user.type(screen.getByLabelText('Reason'), 'State ruling');
      await submit(user);

      await waitFor(() => expect(env.updateMutate).toHaveBeenCalledTimes(1));
      const { id, data } = env.updateMutate.mock.calls[0][0];
      expect(id).toBe('inv_1');
      expect(data.items[0]).toMatchObject({ taxOverrideAmount: '5', taxOverrideReason: 'State ruling', taxCode: 'saas' });
      expect(lastRequest()?.items[0]).toMatchObject({ taxOverrideAmount: '5', taxOverrideReason: 'State ruling' });
    });

    it('keeps the sales tax options of a plain line closed until they are needed', async () => {
      const user = userEvent.setup();
      const plain = invoice();
      Object.assign(plain.items[0], { taxCode: null });
      renderWithProviders(<InvoiceForm mode="edit" invoice={plain} />);

      expect(screen.queryByLabelText('Override the tax')).not.toBeInTheDocument();
      await user.click(screen.getByRole('button', { name: /Sales tax options/ }));
      expect(screen.getByLabelText('Override the tax')).toBeInTheDocument();
      expect(screen.getByRole('combobox', { name: 'Tax code' })).toHaveTextContent('Default (General goods)');
      expect(screen.getByRole('combobox', { name: 'Used by' })).toHaveTextContent('Customer default (Personal)');
    });

    it('marks a line whose tax was overridden', async () => {
      const user = userEvent.setup();
      renderWithProviders(<InvoiceForm mode="edit" invoice={invoice()} />);

      await user.click(screen.getByLabelText('Override the tax'));
      await user.type(screen.getByLabelText('Tax amount'), '5');
      await user.type(screen.getByLabelText('Reason'), 'State ruling');

      expect(within(screen.getByTestId('items-0-line-tax')).getByText('Overridden')).toBeInTheDocument();
    });

    it('sends strings for amounts, the sales tax fields of each line, and the origin of the sale', async () => {
      const user = userEvent.setup();
      renderWithProviders(<InvoiceForm mode="edit" invoice={invoice()} />);

      await user.click(screen.getByLabelText('Ship from a different address'));
      await user.click(screen.getByLabelText('Sold through a marketplace facilitator'));
      await submit(user);

      await waitFor(() => expect(env.updateMutate).toHaveBeenCalledTimes(1));
      const { data } = env.updateMutate.mock.calls[0][0];
      expect(data).toMatchObject({ marketplaceFacilitated: true, currency: 'USD' });
      expect(data.shipFromAddress).toMatchObject({ city: 'Austin', state: 'TX' });
      expect(data.items[0]).toEqual({
        description: 'Consulting',
        quantity: '2',
        unitPrice: '100',
        taxRateId: null,
        productId: null,
        taxCode: 'saas',
        taxUse: null,
        taxIncluded: false,
        taxOverrideAmount: null,
        taxOverrideReason: null,
        classId: null,
        locationId: null,
      });
    });

    it('takes the tax code from the product picked for a line, and fills an empty line', async () => {
      const user = userEvent.setup();
      const empty = invoice();
      Object.assign(empty.items[0], { description: '', unitPrice: '0.0000', taxCode: null });
      renderWithProviders(<InvoiceForm mode="edit" invoice={empty} />);

      await user.click(screen.getByRole('button', { name: 'pick product' }));
      expect(screen.getByLabelText('Description')).toHaveValue('Hosting');
      expect(screen.getByLabelText('Unit Price')).toHaveValue(49);

      await submit(user);
      await waitFor(() => expect(env.updateMutate).toHaveBeenCalledTimes(1));
      expect(env.updateMutate.mock.calls[0][0].data.items[0]).toMatchObject({ productId: 'prod_1', taxCode: 'saas', unitPrice: '49' });
    });

    it('offers class and location on each line when the entity has them', async () => {
      const user = userEvent.setup();
      renderWithProviders(<InvoiceForm mode="edit" invoice={invoice()} />);

      await user.click(screen.getByRole('combobox', { name: 'Class' }));
      await user.click(await screen.findByRole('option', { name: 'Retail' }));
      await user.click(screen.getByRole('combobox', { name: 'Location' }));
      await user.click(await screen.findByRole('option', { name: 'Austin' }));
      await submit(user);

      await waitFor(() => expect(env.updateMutate).toHaveBeenCalledTimes(1));
      expect(env.updateMutate.mock.calls[0][0].data.items[0]).toMatchObject({ classId: 'dim_c1', locationId: 'dim_l1' });
    });

    it('shows the engine being unavailable inline, keeps the last totals and still lets a draft be saved', async () => {
      const user = userEvent.setup();
      env.previewState = previewState({
        error: Object.assign(new Error('down'), { code: 'TAX_ENGINE_UNAVAILABLE', status: 503 }),
        errorCode: 'TAX_ENGINE_UNAVAILABLE',
        isStale: true,
      });
      renderWithProviders(<InvoiceForm mode="edit" invoice={invoice()} />);

      expect(screen.getByTestId('engine-unavailable')).toHaveTextContent(/cannot be finalized or sent/);
      expect(screen.getAllByText('$108.25').length).toBeGreaterThan(0);

      await submit(user);
      await waitFor(() => expect(env.updateMutate).toHaveBeenCalledTimes(1));
    });

    it('asks for a ship-to address when the server says the address is incomplete', () => {
      env.previewState = previewState({ result: previewResult({ addressIncomplete: true, taxTotal: '0.00', total: '100.00' }) });
      renderWithProviders(<InvoiceForm mode="edit" invoice={invoice({ billingAddress: null })} />);
      expect(screen.getByTestId('address-needed')).toBeInTheDocument();
    });
  });

  describe('credit memo', () => {
    const memo = () =>
      invoice({
        type: 'credit_note',
        creditNoteForInvoiceId: 'inv_0',
        items: [
          { ...invoice().items[0], id: 'ili_m1', originalLineId: 'ili_orig_1' },
          { ...invoice().items[0], id: 'ili_m2', description: 'Support', originalLineId: 'ili_orig_2' },
        ],
      });

    it('credits the original invoice line by line and leaves the tax to the original', async () => {
      const user = userEvent.setup();
      renderWithProviders(<InvoiceForm mode="edit" invoice={memo()} />);

      expect(lastRequest()).toMatchObject({
        kind: 'credit_memo',
        originalInvoiceId: 'inv_0',
        items: [{ originalLineId: 'ili_orig_1' }, { originalLineId: 'ili_orig_2' }],
      });
      expect(lastRequest()?.items[0]).not.toHaveProperty('taxCode');
      expect(screen.getByText('Edit credit memo')).toBeInTheDocument();
      expect(screen.getAllByText('The tax of this line follows the original invoice.')).toHaveLength(2);
      expect(screen.queryByRole('button', { name: /Sales tax options/ })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Add Item' })).not.toBeInTheDocument();

      await submit(user);
      await waitFor(() => expect(env.updateMutate).toHaveBeenCalledTimes(1));
      const { data } = env.updateMutate.mock.calls[0][0];
      expect(data.items.map((item: { originalLineId: string }) => item.originalLineId)).toEqual(['ili_orig_1', 'ili_orig_2']);
      expect(data).not.toHaveProperty('marketplaceFacilitated');
    });
  });

  describe('Dutch invoice', () => {
    beforeEach(() => {
      env.salesTax = false;
      env.previewState = previewState({ result: previewResult({ engine: null, shipToState: null }) });
    });

    it('keeps the VAT rate picker, takes its totals from the server and sends no sales tax fields', async () => {
      const user = userEvent.setup();
      renderWithProviders(<InvoiceForm mode="edit" invoice={invoice({ items: [{ ...invoice().items[0], taxRateId: 'tax_21', taxCode: null }] })} />);

      expect(screen.getByLabelText('Tax rate')).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /Sales tax options/ })).not.toBeInTheDocument();
      expect(screen.queryByText('Sold through a marketplace facilitator')).not.toBeInTheDocument();
      expect(screen.getByText('$8.25')).toBeInTheDocument();
      expect(lastRequest()).toMatchObject({ items: [{ taxRateId: 'tax_21' }] });
      expect(lastRequest()?.items[0]).not.toHaveProperty('taxCode');

      await submit(user);
      await waitFor(() => expect(env.updateMutate).toHaveBeenCalledTimes(1));
      const { data } = env.updateMutate.mock.calls[0][0];
      expect(data.items[0]).toMatchObject({ taxRateId: 'tax_21', quantity: '2', unitPrice: '100' });
      expect(data.items[0]).not.toHaveProperty('taxCode');
      expect(data).not.toHaveProperty('marketplaceFacilitated');
      expect(data).not.toHaveProperty('shipFromAddress');
    });
  });
});
