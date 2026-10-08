import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { BillDetail } from '@/lib/api/domains/weldbooks';
import type { TaxPreviewRequest } from '@/lib/api/domains/weldbooks-sales-tax-preview';
import type { TaxPreviewState } from '@/hooks/queries/use-weldbooks-tax-preview';

const env = vi.hoisted(() => ({
  us: true,
  previewState: null as unknown,
  requests: [] as unknown[],
}));

vi.mock('@/lib/router', async () => {
  const { HrefLink } = await import('@/app/weldbooks/invoices/components/test-utils');
  return { Link: HrefLink, useRouter: () => ({ push: vi.fn(), back: vi.fn() }) };
});
vi.mock('@tanstack/react-router', async () => {
  const { RouteLink } = await import('@/app/weldbooks/invoices/components/test-utils');
  return { Link: RouteLink };
});
vi.mock('@/hooks/queries/use-accounting-queries', () => ({
  useAccountingCustomer: () => ({ data: { data: { id: 'sup_1', name: 'Dell', billingAddress: null } } }),
  useAccountingCustomers: () => ({ data: { data: [{ id: 'sup_1', name: 'Dell' }] } }),
  useAccountingTaxRates: () => ({ data: { data: [{ id: 'tax_21', name: 'BTW 21%', rate: '21' }] } }),
  useAccountingAccounts: () => ({
    data: {
      data: [
        { id: 'acc_1', code: '6100', name: 'Equipment', form1099Box: null },
        { id: 'acc_2', code: '6200', name: 'Contractors', form1099Box: 'nec_1' },
      ],
    },
  }),
  useDimensionValues: () => ({
    data: [{ id: 'dim_c1', entityId: 'e', dimension: 'class', name: 'Retail', code: null, parentId: null, isActive: true }],
  }),
}));
vi.mock('@/lib/weldbooks/use-jurisdiction', () => {
  const labels = {
    tax: 'Tax',
    taxRate: 'Tax rate',
    noTax: 'No tax',
    supplier: 'Vendor',
    supplierAddress: 'Vendor address',
  };
  return {
    useCurrentJurisdiction: () => ({ features: { salesTax: env.us, form1099: env.us }, isResolved: true }),
    useJurisdictionLabels: () => ({ labels, features: { salesTax: env.us, form1099: env.us }, isResolved: true }),
  };
});
vi.mock('@/lib/weldbooks/use-weldbooks-format', () => ({
  useWeldbooksFormat: () => ({
    formatMoney: (value: number | string) => `$${Number(value).toFixed(2)}`,
    today: () => '2026-03-01',
    entity: { address: { line1: '1 Main St', city: 'Austin', state: 'TX', postalCode: '78701', country: 'US' } },
  }),
}));
vi.mock('@/hooks/queries/use-weldbooks-tax-preview', () => ({
  useTaxPreview: (request: TaxPreviewRequest | null) => {
    env.requests.push(request);
    return env.previewState;
  },
}));

import { BillForm } from './bill-form';
import { polyfillRadixSelect, previewResult, renderWithProviders } from '@/app/weldbooks/invoices/components/test-utils';

function previewState(overrides: Partial<TaxPreviewState> = {}): TaxPreviewState {
  return {
    result: previewResult({
      subtotal: '1000.00',
      taxTotal: '82.50',
      total: '1082.50',
      lines: [{ index: 0, id: 'line_0', lineTotal: '1000.00', taxAmount: '82.50', lineTotalWithTax: '1082.50', taxRate: '8.25', taxRateId: null, taxCode: null }],
    }),
    isCalculating: false,
    error: null,
    errorCode: null,
    isStale: false,
    ...overrides,
  };
}

function bill(overrides: Record<string, unknown> = {}): BillDetail {
  return {
    id: 'bil_1',
    billNumber: 'BILL-1',
    type: 'standard',
    status: 'draft',
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
    externalReference: null,
    approvalStatus: null,
    notes: null,
    internalNotes: null,
    createdAt: '2026-03-01T00:00:00Z',
    vendorAddress: { line1: '1 Dell Way', city: 'Round Rock', state: 'TX', postalCode: '78682', country: 'US' },
    items: [
      {
        id: 'bli_1',
        billId: 'bil_1',
        description: 'Laptop',
        quantity: '1.0000',
        unitPrice: '1000.0000',
        unit: null,
        discountPercent: '0.00',
        taxRateId: null,
        taxRate: '8.2500',
        taxAmount: '82.50',
        lineTotal: '1000.00',
        lineTotalWithTax: '1082.50',
        accountId: 'acc_1',
        sortOrder: 0,
        taxCode: null,
        accrueUseTax: false,
        form1099Box: null,
        classId: null,
        locationId: null,
      },
    ],
    ...overrides,
  } as unknown as BillDetail;
}

const lastRequest = () => env.requests.at(-1) as TaxPreviewRequest | null;

describe('BillForm', { timeout: 30_000 }, () => {
  beforeAll(polyfillRadixSelect);
  beforeEach(() => {
    env.us = true;
    env.previewState = previewState();
    env.requests = [];
  });

  describe('US bill', () => {
    it('shows the vendor tax as part of the cost, with the totals the server calculated', () => {
      renderWithProviders(<BillForm mode="edit" bill={bill()} onSubmit={vi.fn()} />);

      expect(screen.getByText(/part of the cost of the item/)).toBeInTheDocument();
      expect(screen.getByText('Sales tax paid (part of cost)')).toBeInTheDocument();
      expect(screen.getByRole('columnheader', { name: 'Cost with tax' })).toBeInTheDocument();
      expect(screen.getByText('$82.50')).toBeInTheDocument();
      expect(screen.getAllByText('$1082.50').length).toBeGreaterThan(0);
    });

    it('sends the accrue-use-tax flag, the tax code, the vendor rate, the 1099 box and the delivery address', async () => {
      const user = userEvent.setup();
      const onSubmit = vi.fn();
      renderWithProviders(<BillForm mode="edit" bill={bill()} onSubmit={onSubmit} />);

      await user.clear(screen.getByLabelText('Sales tax charged by vendor (%)'));
      await user.click(screen.getByLabelText('Accrue use tax'));
      await user.click(screen.getByRole('combobox', { name: 'Tax code' }));
      await user.click(await screen.findByRole('option', { name: 'Services' }));
      await user.click(screen.getByRole('combobox', { name: '1099 box' }));
      await user.click(await screen.findByRole('option', { name: 'Omit from 1099' }));
      await user.click(screen.getByRole('combobox', { name: 'Class' }));
      await user.click(await screen.findByRole('option', { name: 'Retail' }));
      await user.click(screen.getByLabelText('Delivered to a different address than my business address'));
      await user.click(screen.getByRole('button', { name: /Update Bill/ }));

      await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
      const payload = onSubmit.mock.calls[0][0];
      expect(payload.deliveryAddress).toMatchObject({ city: 'Austin', state: 'TX', postalCode: '78701' });
      expect(payload.items[0]).toEqual({
        description: 'Laptop',
        quantity: '1',
        unitPrice: '1000',
        taxRateId: null,
        accountId: 'acc_1',
        taxCode: 'services',
        accrueUseTax: true,
        form1099Box: 'omit',
        classId: 'dim_c1',
        locationId: null,
      });
    });

    it('asks the server for the use tax of the bill at its delivery address', async () => {
      const user = userEvent.setup();
      renderWithProviders(<BillForm mode="edit" bill={bill()} onSubmit={vi.fn()} />);

      await user.click(screen.getByLabelText('Accrue use tax'));

      expect(lastRequest()).toMatchObject({
        kind: 'bill',
        contactId: 'sup_1',
        deliveryAddress: null,
        items: [{ description: 'Laptop', quantity: '1', unitPrice: '1000', taxRate: '8.25', accrueUseTax: true, taxCode: null }],
      });
    });

    it('names the 1099 box the account gives a line by default', async () => {
      const user = userEvent.setup();
      const onSubmit = vi.fn();
      const contractor = bill();
      Object.assign(contractor.items[0], { accountId: 'acc_2' });
      renderWithProviders(<BillForm mode="edit" bill={contractor} onSubmit={onSubmit} />);

      expect(screen.getByRole('combobox', { name: '1099 box' })).toHaveTextContent(
        'Account default (1099-NEC (1): Nonemployee compensation)',
      );

      await user.click(screen.getByRole('button', { name: /Update Bill/ }));
      // The default is not sent as a box: the account decides.
      await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
      expect(onSubmit.mock.calls[0][0].items[0].form1099Box).toBeNull();
    });

    it('does not accrue use tax unless it is turned on, and clears a stored delivery address by default', async () => {
      const user = userEvent.setup();
      const onSubmit = vi.fn();
      renderWithProviders(<BillForm mode="edit" bill={bill()} onSubmit={onSubmit} />);

      await user.click(screen.getByRole('button', { name: /Update Bill/ }));
      await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
      const payload = onSubmit.mock.calls[0][0];
      expect(payload.items[0]).toMatchObject({ accrueUseTax: false, taxRate: '8.25', form1099Box: null });
      expect(payload.deliveryAddress).toBeNull();
    });

    it('shows the engine being unavailable inline and keeps the last totals', () => {
      env.previewState = previewState({
        error: Object.assign(new Error('down'), { code: 'TAX_ENGINE_UNAVAILABLE', status: 503 }),
        errorCode: 'TAX_ENGINE_UNAVAILABLE',
        isStale: true,
      });
      renderWithProviders(<BillForm mode="edit" bill={bill()} onSubmit={vi.fn()} />);
      expect(screen.getByTestId('engine-unavailable')).toBeInTheDocument();
      expect(screen.getAllByText('$1082.50').length).toBeGreaterThan(0);
    });

    it('lists the use tax the server accrued on the bill apart from the vendor tax', () => {
      env.previewState = previewState({
        result: previewResult({
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
        }),
      });
      renderWithProviders(<BillForm mode="edit" bill={bill()} onSubmit={vi.fn()} />);

      const panel = screen.getByTestId('document-tax-panel');
      expect(within(panel).getByText('Use tax accrued')).toBeInTheDocument();
      expect(within(panel).getByText('$62.50')).toBeInTheDocument();
    });
  });

  describe('Dutch bill', () => {
    beforeEach(() => {
      env.us = false;
      env.previewState = previewState({ result: previewResult({ engine: null, shipToState: null }) });
    });

    it('keeps the VAT rate picker and sends no sales tax fields', async () => {
      const user = userEvent.setup();
      const onSubmit = vi.fn();
      const dutch = bill();
      Object.assign(dutch.items[0], { taxRateId: 'tax_21', taxRate: '21.0000' });
      renderWithProviders(<BillForm mode="edit" bill={dutch} onSubmit={onSubmit} />);

      expect(screen.getByRole('combobox', { name: 'Tax rate' })).toBeInTheDocument();
      expect(screen.queryByLabelText('Accrue use tax')).not.toBeInTheDocument();
      expect(screen.queryByText('Delivery address')).not.toBeInTheDocument();
      expect(lastRequest()?.items[0]).toMatchObject({ taxRateId: 'tax_21' });
      expect(lastRequest()?.items[0]).not.toHaveProperty('accrueUseTax');
      expect(lastRequest()).not.toHaveProperty('deliveryAddress');

      await user.click(screen.getByRole('button', { name: /Update Bill/ }));
      await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
      const payload = onSubmit.mock.calls[0][0];
      expect(payload).not.toHaveProperty('deliveryAddress');
      expect(payload.items[0]).toMatchObject({ taxRateId: 'tax_21', quantity: '1', unitPrice: '1000' });
      expect(payload.items[0]).not.toHaveProperty('accrueUseTax');
      expect(payload.items[0]).not.toHaveProperty('form1099Box');
    });
  });
});
