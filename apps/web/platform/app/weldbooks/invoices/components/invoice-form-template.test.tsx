import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { InvoiceDetail } from '@/lib/api/domains/weldbooks';

const env = vi.hoisted(() => ({
  updateMutate: vi.fn(),
  createMutate: vi.fn(),
  templates: [] as Array<{ id: string; name: string; isDefault: boolean }>,
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
  useAccountingCustomer: () => ({ data: { data: { id: 'cus_1', name: 'Globex', paymentTermsDays: 30, billingAddress: null, shippingAddress: null } } }),
  useAccountingCustomers: () => ({ data: { data: [{ id: 'cus_1', name: 'Globex' }] } }),
  useAccountingTaxRates: () => ({ data: { data: [] } }),
  useDimensionValues: () => ({ data: [] }),
}));
vi.mock('@/hooks/queries/use-invoice-template-queries', () => ({
  useInvoiceTemplates: (entityId: string | null | undefined) => ({ data: entityId ? env.templates : undefined }),
}));
vi.mock('@/lib/weldbooks/use-jurisdiction', () => {
  const labels = { tax: 'Tax', taxRate: 'Tax rate', noTax: 'No tax', creditNote: 'Credit memo' };
  return {
    useCurrentJurisdiction: () => ({ features: { salesTax: false, form1099: false }, isResolved: true, code: 'NL' }),
    useJurisdictionLabels: () => ({ labels, features: { salesTax: false, form1099: false }, isResolved: true }),
  };
});
vi.mock('@/lib/weldbooks/use-weldbooks-format', () => ({
  useWeldbooksFormat: () => ({
    currency: 'EUR',
    entityCurrency: 'EUR',
    formatMoney: (value: number | string) => `€${Number(value).toFixed(2)}`,
    formatDate: (value: string) => value,
    today: () => '2026-03-01',
    entity: { id: 'ent_1', address: null },
  }),
}));
vi.mock('@/hooks/queries/use-weldbooks-tax-preview', () => ({
  useTaxPreview: () => ({ result: null, isCalculating: false, error: null, errorCode: null, isStale: false }),
  useProductOptions: () => ({ data: [] }),
  useProductSearch: () => async () => [],
}));

import { InvoiceForm } from './invoice-form';
import { polyfillRadixSelect, renderWithProviders } from './test-utils';

function invoice(overrides: Record<string, unknown> = {}): InvoiceDetail {
  return {
    id: 'inv_1',
    invoiceNumber: 'INV-0001',
    type: 'standard',
    status: 'draft',
    contactId: 'cus_1',
    contactName: 'Globex',
    issueDate: '2026-03-01',
    dueDate: '2026-03-31',
    currency: 'EUR',
    subtotal: '100.00',
    taxTotal: '0.00',
    total: '100.00',
    amountPaid: '0',
    balanceDue: '100.00',
    createdAt: '2026-03-01T00:00:00Z',
    billingAddress: { line1: '9 Dock Rd', city: 'Rotterdam', postalCode: '3011 AA', country: 'NL' },
    shippingAddress: null,
    items: [
      {
        id: 'ili_1',
        invoiceId: 'inv_1',
        description: 'Consulting',
        quantity: '1.0000',
        unitPrice: '100.0000',
        discountPercent: '0.00',
        taxRateId: null,
        taxRate: '0',
        taxAmount: '0.00',
        lineTotal: '100.00',
        lineTotalWithTax: '100.00',
        sortOrder: 0,
      },
    ],
    payments: [],
    ...overrides,
  } as unknown as InvoiceDetail;
}

const submit = (user: ReturnType<typeof userEvent.setup>) => user.click(screen.getByRole('button', { name: 'Update Invoice' }));

describe('InvoiceForm template picker', { timeout: 30_000 }, () => {
  beforeAll(polyfillRadixSelect);
  beforeEach(() => {
    env.updateMutate.mockReset().mockResolvedValue({});
    env.createMutate.mockReset().mockResolvedValue({});
    env.templates = [];
  });

  it('is hidden while the company has no templates', () => {
    renderWithProviders(<InvoiceForm mode="edit" invoice={invoice()} />);
    expect(screen.queryByLabelText('Template')).not.toBeInTheDocument();
  });

  it('offers the default template first, named, and the company templates', async () => {
    env.templates = [
      { id: 'itpl_1', name: 'Standard', isDefault: true },
      { id: 'itpl_2', name: 'Letterhead', isDefault: false },
    ];
    const user = userEvent.setup();
    renderWithProviders(<InvoiceForm mode="edit" invoice={invoice()} />);

    await user.click(screen.getByLabelText('Template'));
    expect(await screen.findByRole('option', { name: 'Default template (Standard)' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Standard' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Letterhead' })).toBeInTheDocument();
  });

  it('sends the chosen template, and nothing when the choice is unchanged', async () => {
    env.templates = [{ id: 'itpl_2', name: 'Letterhead', isDefault: false }];
    const user = userEvent.setup();
    renderWithProviders(<InvoiceForm mode="edit" invoice={invoice()} />);

    await submit(user);
    await waitFor(() => expect(env.updateMutate).toHaveBeenCalledTimes(1));
    expect(env.updateMutate.mock.calls[0][0].data).not.toHaveProperty('templateId');

    await user.click(screen.getByLabelText('Template'));
    await user.click(await screen.findByRole('option', { name: 'Letterhead' }));
    await submit(user);
    await waitFor(() => expect(env.updateMutate).toHaveBeenCalledTimes(2));
    expect(env.updateMutate.mock.calls[1][0].data).toMatchObject({ templateId: 'itpl_2' });
  });

  it('sends null when an invoice goes back to the default template', async () => {
    env.templates = [{ id: 'itpl_2', name: 'Letterhead', isDefault: false }];
    const user = userEvent.setup();
    renderWithProviders(<InvoiceForm mode="edit" invoice={invoice({ templateId: 'itpl_2' })} />);

    await user.click(screen.getByLabelText('Template'));
    await user.click(await screen.findByRole('option', { name: 'Default template' }));
    await submit(user);
    await waitFor(() => expect(env.updateMutate).toHaveBeenCalledTimes(1));
    expect(env.updateMutate.mock.calls[0][0].data).toMatchObject({ templateId: null });
  });
});
