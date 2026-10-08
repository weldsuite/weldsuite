import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const env = vi.hoisted(() => ({
  us: true,
  create: vi.fn(),
  update: vi.fn(),
  toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock('sonner', () => ({ toast: env.toast }));
vi.mock('@tanstack/react-router', async () => {
  const { RouteLink } = await import('@/app/weldbooks/invoices/components/test-utils');
  return { Link: RouteLink };
});
vi.mock('@/lib/router', async () => {
  const { HrefLink } = await import('@/app/weldbooks/invoices/components/test-utils');
  return { Link: HrefLink };
});
vi.mock('@/hooks/queries/use-accounting-queries', () => ({
  useAccountingCustomer: () => ({ data: { data: { id: 'cus_1', taxUse: 'personal' } } }),
  useAccountingCustomers: () => ({ data: { data: [{ id: 'cus_1', name: 'Globex' }] } }),
  useAccountingTaxRates: () => ({ data: { data: [{ id: 'tax_21', name: 'BTW 21%', rate: '21' }] } }),
  useDimensionValues: () => ({
    data: [{ id: 'dim_l1', entityId: 'e', dimension: 'location', name: 'Austin', code: null, parentId: null, isActive: true }],
  }),
}));
vi.mock('@/hooks/queries/use-weldbooks-recurring-queries', () => ({
  useCreateRecurringInvoice: () => ({ mutateAsync: env.create, isPending: false }),
  useUpdateRecurringInvoice: () => ({ mutateAsync: env.update, isPending: false }),
}));
vi.mock('@/lib/weldbooks/use-jurisdiction', () => {
  const labels = { tax: 'Tax', taxRate: 'Tax rate', noTax: 'No tax' };
  return {
    useCurrentJurisdiction: () => ({ features: { salesTax: env.us, form1099: false }, isResolved: true }),
    useJurisdictionLabels: () => ({ labels, features: { salesTax: env.us, form1099: false }, isResolved: true }),
  };
});
vi.mock('@/lib/weldbooks/use-weldbooks-format', () => ({
  useWeldbooksFormat: () => ({
    entityCurrency: 'USD',
    today: () => '2026-03-01',
    entity: { address: { line1: '1 Main St', city: 'Austin', state: 'TX', postalCode: '78701', country: 'US' } },
  }),
}));
vi.mock('@/app/weldbooks/invoices/components/product-picker', () => ({
  ProductPicker: ({ onSelect }: Readonly<{ onSelect: (product: unknown) => void }>) => (
    <button type="button" onClick={() => onSelect({ id: 'prod_1', name: 'Hosting', price: 49, taxClass: 'saas' })}>
      pick product
    </button>
  ),
}));

import { RecurringInvoiceForm } from './recurring-invoice-form';
import { polyfillRadixSelect, renderWithProviders } from '@/app/weldbooks/invoices/components/test-utils';

async function chooseCustomer(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('combobox', { name: 'Customer' }));
  await user.click(await screen.findByRole('option', { name: 'Globex' }));
}

describe('RecurringInvoiceForm', { timeout: 30_000 }, () => {
  beforeAll(polyfillRadixSelect);
  beforeEach(() => {
    env.us = true;
    env.create.mockReset().mockResolvedValue({ data: { id: 'ri_new' } });
    env.update.mockReset().mockResolvedValue({ data: { id: 'ri_1' } });
    Object.values(env.toast).forEach((fn) => fn.mockReset());
  });

  it('creates a US template with the tax code, use, tax inclusion, product, location and origin of its lines', async () => {
    const user = userEvent.setup();
    const onSaved = vi.fn();
    renderWithProviders(<RecurringInvoiceForm mode="add" onSaved={onSaved} />);

    await chooseCustomer(user);
    await user.click(screen.getByRole('button', { name: 'pick product' }));
    await user.click(screen.getByRole('button', { name: /Sales tax options/ }));
    await user.click(screen.getByLabelText('Price includes sales tax'));
    await user.click(screen.getByRole('combobox', { name: 'Used by' }));
    await user.click(await screen.findByRole('option', { name: 'Business' }));
    await user.click(screen.getByRole('combobox', { name: 'Location' }));
    await user.click(await screen.findByRole('option', { name: 'Austin' }));
    await user.click(screen.getByLabelText('Ship from a different address'));
    await user.click(screen.getByRole('button', { name: 'Save recurring invoice' }));

    await waitFor(() => expect(env.create).toHaveBeenCalledTimes(1));
    const payload = env.create.mock.calls[0][0];
    expect(payload).toMatchObject({ contactId: 'cus_1', frequency: 'monthly', nextIssueDate: '2026-03-01', autoFinalize: false });
    expect(payload.templateData.items).toEqual([
      {
        description: 'Hosting',
        quantity: 1,
        unitPrice: 49,
        unit: undefined,
        accountId: null,
        taxRateId: null,
        productId: 'prod_1',
        taxCode: 'saas',
        taxUse: 'business',
        taxIncluded: true,
        classId: null,
        locationId: 'dim_l1',
      },
    ]);
    expect(payload.templateData.shipFromAddress).toMatchObject({ city: 'Austin', state: 'TX' });
    expect(payload.templateData.currency).toBe('USD');
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith('ri_new'));
  });

  it('says that tax is calculated when each invoice is generated, and has no override', async () => {
    const user = userEvent.setup();
    renderWithProviders(<RecurringInvoiceForm mode="add" onSaved={vi.fn()} />);

    expect(screen.getByText(/Tax is calculated when each invoice is generated/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Sales tax options/ }));
    expect(screen.queryByLabelText('Override the tax')).not.toBeInTheDocument();
  });

  it('needs a customer and a description before it saves', async () => {
    const user = userEvent.setup();
    renderWithProviders(<RecurringInvoiceForm mode="add" onSaved={vi.fn()} />);

    await user.click(screen.getByRole('button', { name: 'Save recurring invoice' }));

    expect(await screen.findByText('Choose a customer')).toBeInTheDocument();
    expect(screen.getByText('Enter a description')).toBeInTheDocument();
    expect(env.create).not.toHaveBeenCalled();
  });

  it('keeps the VAT rate picker for a Dutch template and stores no sales tax fields', async () => {
    env.us = false;
    const user = userEvent.setup();
    renderWithProviders(<RecurringInvoiceForm mode="add" onSaved={vi.fn()} />);

    expect(screen.getByRole('combobox', { name: 'Tax rate' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Sales tax options/ })).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Ship from a different address')).not.toBeInTheDocument();

    await chooseCustomer(user);
    await user.type(screen.getByLabelText('Description'), 'Hosting');
    await user.click(screen.getByRole('combobox', { name: 'Tax rate' }));
    await user.click(await screen.findByRole('option', { name: 'BTW 21%' }));
    await user.click(screen.getByRole('button', { name: 'Save recurring invoice' }));

    await waitFor(() => expect(env.create).toHaveBeenCalledTimes(1));
    const template = env.create.mock.calls[0][0].templateData;
    expect(template.items[0]).toMatchObject({ description: 'Hosting', taxRateId: 'tax_21' });
    expect(template.items[0]).not.toHaveProperty('taxCode');
    expect(template).not.toHaveProperty('shipFromAddress');
  });

  it('edits a stored template and keeps what the form does not show', async () => {
    const user = userEvent.setup();
    const onSaved = vi.fn();
    renderWithProviders(
      <RecurringInvoiceForm
        mode="edit"
        onSaved={onSaved}
        recurring={{
          id: 'ri_1',
          name: 'Retainer',
          contactId: 'cus_1',
          frequency: 'quarterly',
          dayOfMonth: null,
          nextIssueDate: '2026-04-01T00:00:00.000Z',
          endDate: null,
          status: 'active',
          autoSend: false,
          autoFinalize: true,
          generatedCount: 2,
          lastGeneratedAt: null,
          lastGeneratedInvoiceId: null,
          templateData: {
            internalNotes: 'Renegotiate in June',
            items: [{ description: 'Hosting', quantity: 3, unitPrice: 20, taxCode: 'saas', accountId: 'acc_4' } as never],
          },
        }}
      />,
    );

    expect(screen.getByLabelText('Description')).toHaveValue('Hosting');
    // The line has its own tax code, so its options start open.
    expect(screen.getByRole('combobox', { name: 'Tax code' })).toHaveTextContent('Software as a service');

    await user.click(screen.getByRole('button', { name: 'Save recurring invoice' }));

    await waitFor(() => expect(env.update).toHaveBeenCalledTimes(1));
    const { id, data } = env.update.mock.calls[0][0];
    expect(id).toBe('ri_1');
    expect(data).toMatchObject({ frequency: 'quarterly', nextIssueDate: '2026-04-01', autoFinalize: true });
    expect(data.templateData.internalNotes).toBe('Renegotiate in June');
    expect(data.templateData.items[0]).toMatchObject({ quantity: 3, unitPrice: 20, taxCode: 'saas', accountId: 'acc_4' });
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith('ri_1'));
  });
});
