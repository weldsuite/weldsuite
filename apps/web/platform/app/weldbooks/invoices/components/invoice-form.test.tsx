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
  sendMutate: vi.fn(),
  deleteMutate: vi.fn(),
  push: vi.fn(),
  /** The customers the picker lists. */
  customers: [{ id: 'cus_1', name: 'Globex' }] as Array<{ id: string; name: string }>,
  customerEmail: null as string | null,
  /** The company details an invoice needs that the entity lacks. */
  missingDetails: [] as string[],
  previewState: null as unknown,
  requests: [] as unknown[],
  taxRates: [
    { id: 'tax_21', name: 'BTW 21%', rate: '21', type: 'both', isDefault: false },
    { id: 'tax_sales', name: 'BTW verkoop 9%', rate: '9', type: 'sales', isDefault: false },
    { id: 'tax_purchase', name: 'BTW inkoop 21%', rate: '21', type: 'purchase', isDefault: false },
  ] as Array<{ id: string; name: string; rate: string; type: string; isDefault: boolean }>,
}));

// The live PDF preview has its own data and is not what these tests cover.
vi.mock('./invoice-preview', () => ({ InvoicePreview: () => null }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('@/lib/router', async () => {
  const { HrefLink } = await import('./test-utils');
  return { Link: HrefLink, useRouter: () => ({ push: env.push, back: vi.fn() }) };
});
vi.mock('@tanstack/react-router', async () => {
  const { RouteLink } = await import('./test-utils');
  return { Link: RouteLink };
});
vi.mock('@/hooks/queries/use-accounting-queries', () => ({
  useCreateInvoice: () => ({ mutateAsync: env.createMutate }),
  useSendInvoice: () => ({ mutateAsync: env.sendMutate }),
  useDeleteInvoice: () => ({ mutateAsync: env.deleteMutate, isPending: false }),
  useUpdateInvoice: () => ({ mutateAsync: env.updateMutate }),
  useUpdateAccountingEntity: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useAccountingCustomer: () => ({
    data: { data: { id: 'cus_1', name: 'Globex', email: env.customerEmail, paymentTermsDays: 30, taxUse: 'personal', billingAddress: null, shippingAddress: null } },
  }),
  useAccountingCustomers: () => ({ data: { data: env.customers }, isLoading: false }),
  useAccountingTaxRates: () => ({ data: { data: env.taxRates } }),
  useDimensionValues: () => ({
    data: [
      { id: 'dim_c1', entityId: 'e', dimension: 'class', name: 'Retail', code: null, parentId: null, isActive: true },
      { id: 'dim_l1', entityId: 'e', dimension: 'location', name: 'Austin', code: null, parentId: null, isActive: true },
    ],
  }),
}));
// The popup has its own tests; here it only hands back the customer it "created".
vi.mock('@/app/weldbooks/customers/components/quick-add-contact-dialog', () => ({
  QuickAddContactDialog: ({ open, onCreated }: { open: boolean; onCreated: (id: string) => void }) =>
    open ? (
      <button type="button" onClick={() => onCreated('cus_new')}>
        quick add customer saved
      </button>
    ) : null,
}));
vi.mock('@/lib/weldbooks/use-jurisdiction', () => {
  const labels = { tax: 'Tax', taxRate: 'Tax rate', noTax: 'No tax', creditNote: 'Credit memo' };
  return {
    useCurrentJurisdiction: () => ({ features: { salesTax: env.salesTax, form1099: false }, isResolved: true, code: 'US' }),
    useJurisdictionLabels: () => ({ labels, features: { salesTax: env.salesTax, form1099: false }, isResolved: true }),
  };
});
vi.mock('@weldsuite/permissions/react', () => ({ useCan: () => true }));
vi.mock('@/lib/weldbooks/use-entity-invoice-details', () => ({
  useEntityInvoiceDetails: () => ({
    entity: { id: 'ent_1', name: 'Acme', jurisdictionCode: 'NL', baseCurrency: 'EUR' },
    missing: env.missingDetails,
    labels: { vatNumber: 'VAT number', registrationNumber: 'KvK number', iban: 'IBAN', bic: 'BIC', address: 'Business address' },
    isLoading: false,
  }),
}));
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

async function submit(user: ReturnType<typeof userEvent.setup>, name = 'Update invoice') {
  await user.click(screen.getByRole('button', { name }));
}

describe('InvoiceForm', { timeout: 30_000 }, () => {
  beforeAll(polyfillRadixSelect);
  beforeEach(() => {
    env.salesTax = true;
    env.updateMutate.mockReset().mockResolvedValue({});
    env.createMutate.mockReset().mockResolvedValue({});
    env.sendMutate.mockReset().mockResolvedValue({});
    env.deleteMutate.mockReset().mockResolvedValue({});
    env.push.mockReset();
    env.customers = [{ id: 'cus_1', name: 'Globex' }];
    for (const rate of env.taxRates) rate.isDefault = false;
    env.customerEmail = null;
    env.missingDetails = [];
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
      expect(screen.getByLabelText('Unit price')).toHaveValue(49);

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
      expect(screen.queryByRole('button', { name: 'Add line' })).not.toBeInTheDocument();
      // Back and the way out of the editor lead to the credit notes list, with the note's panel open.
      expect(screen.getByRole('link', { name: 'Back to credit notes' })).toHaveAttribute(
        'href',
        '/weldbooks/credit-notes?stack=invoice:inv_1',
      );

      // A credit note saves as "Update credit memo" (the jurisdiction's name for it), not "Update invoice".
      await submit(user, 'Update credit memo');
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

    it('offers sales and both rates on an invoice line, never a purchase-only rate', async () => {
      const user = userEvent.setup();
      renderWithProviders(<InvoiceForm mode="edit" invoice={invoice({ items: [{ ...invoice().items[0], taxRateId: null, taxCode: null }] })} />);

      await user.click(screen.getByLabelText('Tax rate'));
      expect(await screen.findByRole('option', { name: 'BTW 21%' })).toBeInTheDocument();
      expect(screen.getByRole('option', { name: 'BTW verkoop 9%' })).toBeInTheDocument();
      expect(screen.queryByRole('option', { name: 'BTW inkoop 21%' })).not.toBeInTheDocument();
    });

    it('shows the line total without tax, as the line total of a VAT document', () => {
      renderWithProviders(<InvoiceForm mode="edit" invoice={invoice()} />);
      expect(screen.getByText('$100.00', { selector: 'span' })).toBeInTheDocument();
      expect(screen.queryByText('$108.25', { selector: 'span.ml-1' })).not.toBeInTheDocument();
    });

    it('starts a new line on the default sales rate, and so does an added line', async () => {
      env.taxRates.find((rate) => rate.id === 'tax_21')!.isDefault = true;
      const user = userEvent.setup();
      renderWithProviders(<InvoiceForm mode="add" />);

      await waitFor(() => expect(screen.getByLabelText('Tax rate')).toHaveTextContent('BTW 21%'));
      await user.click(screen.getByRole('button', { name: 'Add line' }));
      const pickers = screen.getAllByLabelText('Tax rate');
      expect(pickers).toHaveLength(2);
      expect(pickers[1]).toHaveTextContent('BTW 21%');
    });

    it('leaves a new line without a rate when the default is a purchase rate', () => {
      env.taxRates.find((rate) => rate.id === 'tax_purchase')!.isDefault = true;
      renderWithProviders(<InvoiceForm mode="add" />);
      expect(screen.getByLabelText('Tax rate')).toHaveTextContent('No tax');
    });

    it('offers to add the first customer when there are none, and selects the new one', async () => {
      env.customers = [];
      const user = userEvent.setup();
      renderWithProviders(<InvoiceForm mode="add" />);

      expect(screen.getByText('No customers yet')).toBeInTheDocument();
      await user.click(screen.getByRole('button', { name: 'Add customer' }));
      await user.click(await screen.findByRole('button', { name: 'quick add customer saved' }));
      // The saved customer is chosen, so the form stops asking for one.
      await user.type(screen.getByPlaceholderText('Item description'), 'Consulting');
      await user.click(screen.getByRole('button', { name: 'Create draft' }));
      await waitFor(() => expect(env.createMutate).toHaveBeenCalledTimes(1));
      expect(env.createMutate.mock.calls[0][0].contactId).toBe('cus_new');
    });

    it('names the remove button of a line "Remove line", not "Item 2"', async () => {
      const user = userEvent.setup();
      renderWithProviders(<InvoiceForm mode="edit" invoice={invoice()} />);

      await user.click(screen.getByRole('button', { name: 'Add line' }));
      expect(screen.getAllByRole('button', { name: 'Remove line' })).toHaveLength(2);
      expect(screen.queryByRole('button', { name: 'Item 2' })).not.toBeInTheDocument();
    });

    it('shows the exchange rate field only for a currency other than the entity base, and sends both', async () => {
      const user = userEvent.setup();
      renderWithProviders(<InvoiceForm mode="edit" invoice={invoice()} />);

      // The entity's base is USD and so is the invoice: no rate field.
      expect(screen.getByLabelText('Currency')).toBeInTheDocument();
      expect(screen.queryByLabelText('Exchange rate')).not.toBeInTheDocument();

      await user.click(screen.getByLabelText('Currency'));
      await user.click(await screen.findByRole('option', { name: 'EUR' }));
      const rate = await screen.findByLabelText('Exchange rate');
      await user.type(rate, '0,92');

      await submit(user);
      await waitFor(() => expect(env.updateMutate).toHaveBeenCalledTimes(1));
      expect(env.updateMutate.mock.calls[0][0].data).toMatchObject({ currency: 'EUR', exchangeRate: '0.92' });
    });

    it('sends no exchange rate when the field is left empty', async () => {
      const user = userEvent.setup();
      renderWithProviders(<InvoiceForm mode="edit" invoice={invoice()} />);
      await submit(user);
      await waitFor(() => expect(env.updateMutate).toHaveBeenCalledTimes(1));
      const { data } = env.updateMutate.mock.calls[0][0];
      expect(data.currency).toBe('USD');
      expect(data).not.toHaveProperty('exchangeRate');
    });
  });
  describe('a new invoice', () => {
    async function fillIn(user: ReturnType<typeof userEvent.setup>) {
      renderWithProviders(<InvoiceForm mode="add" />);
      await user.click(screen.getByRole('combobox', { name: 'Customer' }));
      await user.click(await screen.findByRole('option', { name: 'Globex' }));
      await user.type(screen.getByLabelText('Description'), 'Consulting');
    }

    it('saves a draft and sends nothing', async () => {
      const user = userEvent.setup();
      env.createMutate.mockResolvedValue({ data: { id: 'inv_new' } });
      await fillIn(user);

      await submit(user, 'Create draft');

      await waitFor(() => expect(env.createMutate).toHaveBeenCalledTimes(1));
      expect(env.sendMutate).not.toHaveBeenCalled();
    });

    it('saves and sends the invoice to a customer with an email address', async () => {
      const user = userEvent.setup();
      env.customerEmail = 'ap@globex.test';
      env.createMutate.mockResolvedValue({ data: { id: 'inv_new' } });
      await fillIn(user);

      await submit(user, 'Create and send');

      await waitFor(() => expect(env.sendMutate).toHaveBeenCalledWith('inv_new'));
      expect(env.createMutate).toHaveBeenCalledTimes(1);
    });

    it('cannot send to a customer without an email address', async () => {
      const user = userEvent.setup();
      await fillIn(user);
      expect(screen.getByRole('button', { name: 'Create and send' })).toBeDisabled();
      expect(screen.getByRole('button', { name: 'Create draft' })).toBeEnabled();
    });

    it('waits for the company details every invoice must show, and offers to add them', async () => {
      const user = userEvent.setup();
      env.customerEmail = 'ap@globex.test';
      env.missingDetails = ['vatNumber', 'iban'];
      await fillIn(user);

      const notice = screen.getByTestId('entity-invoice-details-notice');
      expect(notice).toHaveTextContent('VAT number, IBAN');
      expect(screen.getByRole('button', { name: 'Create draft' })).toBeDisabled();
      expect(screen.getByRole('button', { name: 'Create and send' })).toBeDisabled();

      await user.click(within(notice).getByRole('button', { name: 'Add business details' }));
      const dialog = await screen.findByRole('dialog');
      expect(within(dialog).getByLabelText('VAT number')).toBeInTheDocument();
      expect(within(dialog).getByLabelText('IBAN')).toBeInTheDocument();
      expect(within(dialog).queryByLabelText('KvK number')).not.toBeInTheDocument();
      expect(env.createMutate).not.toHaveBeenCalled();
    });
  });
});

describe('InvoiceForm: discarding a credit note draft', { timeout: 30_000 }, () => {
  beforeAll(polyfillRadixSelect);
  beforeEach(() => {
    env.salesTax = true;
    env.deleteMutate.mockReset().mockResolvedValue({});
    env.push.mockReset();
    env.previewState = previewState();
    env.requests = [];
  });

  const memo = (overrides: Record<string, unknown> = {}) =>
    invoice({
      type: 'credit_note',
      invoiceNumber: 'CN-0003',
      creditNoteForInvoiceId: 'inv_0',
      items: [{ ...invoice().items[0], originalLineId: 'ili_orig_1' }],
      ...overrides,
    });

  it('deletes the draft after a confirmation that says the number stays used, then reopens the original invoice', async () => {
    const user = userEvent.setup();
    renderWithProviders(<InvoiceForm mode="edit" invoice={memo()} />);

    await user.click(screen.getByRole('button', { name: 'Discard draft' }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('Draft CN-0003 will be deleted. The number stays used');
    expect(env.deleteMutate).not.toHaveBeenCalled();

    await user.click(within(dialog).getByRole('button', { name: 'Discard draft' }));
    await waitFor(() => expect(env.deleteMutate).toHaveBeenCalledWith('inv_1'));
    await waitFor(() => expect(env.push).toHaveBeenCalledWith('/weldbooks/invoices?stack=invoice:inv_0'));
  });

  it('stays in the editor when the draft cannot be deleted', async () => {
    env.deleteMutate.mockRejectedValue(new Error('Already finalized'));
    const user = userEvent.setup();
    renderWithProviders(<InvoiceForm mode="edit" invoice={memo()} />);

    await user.click(screen.getByRole('button', { name: 'Discard draft' }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Discard draft' }));
    await waitFor(() => expect(env.deleteMutate).toHaveBeenCalledTimes(1));
    expect(env.push).not.toHaveBeenCalled();
  });

  it('is not offered for a finalized credit note or for an invoice', () => {
    const { unmount } = renderWithProviders(<InvoiceForm mode="edit" invoice={memo({ status: 'finalized' })} />);
    expect(screen.queryByRole('button', { name: 'Discard draft' })).not.toBeInTheDocument();
    unmount();
    renderWithProviders(<InvoiceForm mode="edit" invoice={invoice()} />);
    expect(screen.queryByRole('button', { name: 'Discard draft' })).not.toBeInTheDocument();
  });
});
