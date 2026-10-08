import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { TaxBreakdownRow } from '@/lib/api/domains/weldbooks-sales-tax-preview';

const env = vi.hoisted(() => ({
  invoice: null as unknown,
  salesTax: true,
  finalize: vi.fn(),
  commit: vi.fn(),
  createCreditMemo: vi.fn(),
  generatePdf: vi.fn(),
  push: vi.fn(),
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() },
  certificates: new Map<string, { id: string; certificateNumber: string | null; reason: string; states: string[] }>(),
}));

vi.mock('sonner', () => ({ toast: env.toast }));
vi.mock('@/lib/router', async () => {
  const { HrefLink } = await import('../components/test-utils');
  return { Link: HrefLink, useParams: () => ({ id: 'inv_1' }), useRouter: () => ({ push: env.push, back: vi.fn() }) };
});
vi.mock('@tanstack/react-router', async () => {
  const { RouteLink } = await import('../components/test-utils');
  return { Link: RouteLink };
});
vi.mock('@weldsuite/permissions/react', () => ({ useCan: () => true }));
vi.mock('@/hooks/queries/use-accounting-queries', () => ({
  useAccountingEntity: () => ({ data: { name: 'Acme LLC', jurisdictionCode: 'US' } }),
  useAccountingInvoice: () => ({ data: { data: env.invoice }, isLoading: false }),
  useFinalizeInvoice: () => ({ mutate: env.finalize, isPending: false }),
  useUpdateInvoiceStatus: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useSendInvoice: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock('@/hooks/use-current-accounting-entity', () => ({ useCurrentAccountingEntity: () => ({ entityId: 'ent_1' }) }));
vi.mock('@/hooks/queries/use-weldbooks-tax-preview', () => ({
  useCommitInvoiceTax: () => ({ mutate: env.commit, isPending: false }),
  useCreateCreditMemo: () => ({ mutate: env.createCreditMemo, isPending: false }),
  useExemptionCertificates: () => env.certificates,
}));
vi.mock('@/lib/weldbooks/use-jurisdiction', () => ({
  useJurisdictionLabels: () => ({
    labels: { tax: 'Sales tax', taxId: 'EIN', registrationId: 'State ID', creditNote: 'Credit memo' },
    features: { salesTax: env.salesTax, form1099: env.salesTax },
  }),
}));
vi.mock('@/lib/weldbooks/use-weldbooks-format', () => ({
  useWeldbooksFormat: () => ({
    formatMoney: (value: number | string | null | undefined) => `$${Number(value ?? 0).toFixed(2)}`,
    formatDate: (value: string | null | undefined) => value ?? '-',
    formatDateTime: (value: string | null | undefined) => `at ${value}`,
  }),
}));
vi.mock('@/lib/weldbooks/invoice-pdf', () => ({
  generateInvoicePdf: env.generatePdf,
  downloadPdf: vi.fn(),
}));
vi.mock('@/lib/api/domains/weldbooks', () => ({ accountingApi: { getInvoiceAttachment: vi.fn() } }));
vi.mock('../components/record-payment-dialog', () => ({ RecordPaymentDialog: () => null }));
vi.mock('@/components/page-loader', () => ({ PageLoader: () => null }));

import InvoiceDetailPage from './page';
import { renderWithProviders } from '../components/test-utils';

const refusal = (code: string, extra: Record<string, unknown> = {}) => Object.assign(new Error('refused'), { code, ...extra });

const row = (overrides: Partial<TaxBreakdownRow>): TaxBreakdownRow => ({
  taxRateName: 'Sales tax',
  taxRate: 0,
  taxableAmount: 0,
  taxAmount: 0,
  ...overrides,
});

const usRows: TaxBreakdownRow[] = [
  row({ lineId: 'ili_1', jurisdictionCode: 'TX', jurisdictionName: 'Texas', jurisdictionLevel: 'state', taxRate: 6.25, taxableAmount: 100, taxAmount: 6.25 }),
  row({ lineId: 'ili_1', jurisdictionCode: 'AUSTIN', jurisdictionName: 'Austin', jurisdictionLevel: 'city', taxRate: 2, taxableAmount: 100, taxAmount: 2 }),
];

function invoice(overrides: Record<string, unknown> = {}) {
  return {
    id: 'inv_1',
    invoiceNumber: 'INV-0001',
    type: 'standard',
    status: 'sent',
    contactId: 'cus_1',
    contactName: 'Globex',
    contactEmail: 'ap@globex.test',
    issueDate: '2026-03-01',
    dueDate: '2026-03-31',
    currency: 'USD',
    subtotal: '100.00',
    taxTotal: '8.25',
    total: '108.25',
    amountPaid: '0',
    balanceDue: '108.25',
    reference: null,
    notes: null,
    internalNotes: null,
    createdAt: '2026-03-01T00:00:00Z',
    billingAddress: { line1: '9 Dock Rd', city: 'Seattle', state: 'WA', postalCode: '98101', country: 'US' },
    shippingAddress: null,
    taxEngine: 'manual',
    taxCalculatedAt: '2026-03-01T10:00:00Z',
    taxCommittedAt: null,
    taxWarnings: [],
    taxBreakdown: usRows,
    items: [
      {
        id: 'ili_1',
        invoiceId: 'inv_1',
        description: 'Hosting',
        quantity: '1',
        unitPrice: '100.00',
        unit: null,
        discountPercent: '0',
        taxRateId: null,
        taxRate: '8.25',
        taxAmount: '8.25',
        lineTotal: '100.00',
        lineTotalWithTax: '108.25',
        accountId: null,
        sortOrder: 0,
        taxCode: 'saas',
        taxUse: 'business',
        taxIncluded: false,
        taxOverrideAmount: null,
        taxOverrideReason: null,
      },
    ],
    payments: [],
    ...overrides,
  };
}

describe('InvoiceDetailPage: sales tax', () => {
  beforeEach(() => {
    env.invoice = invoice();
    env.salesTax = true;
    env.certificates = new Map();
    env.finalize.mockReset();
    env.commit.mockReset();
    env.createCreditMemo.mockReset();
    env.generatePdf.mockReset().mockResolvedValue(new Uint8Array());
    env.push.mockReset();
    Object.values(env.toast).forEach((fn) => fn.mockReset());
  });

  it('shows the tax per jurisdiction in the totals and the engine that calculated it', () => {
    renderWithProviders(<InvoiceDetailPage />);

    const rows = screen.getAllByTestId('tax-breakdown-row');
    expect(rows).toHaveLength(2);
    expect(within(rows[0]).getByText(/Texas/)).toBeInTheDocument();
    expect(within(rows[0]).getByText('6.25% on $100.00')).toBeInTheDocument();
    expect(within(rows[1]).getByText(/Austin/)).toBeInTheDocument();

    const card = screen.getByTestId('sales-tax-card');
    expect(within(card).getByText('Manual rates')).toBeInTheDocument();
    // A manual engine has no provider to record with.
    expect(within(card).queryByTestId('provider-status')).not.toBeInTheDocument();
    expect(within(card).queryByRole('button', { name: 'Retry tax commit' })).not.toBeInTheDocument();
  });

  it('shows each line\'s tax code, use and overrides under its description', () => {
    env.invoice = invoice({
      items: [
        {
          ...(invoice().items as object[])[0],
          taxIncluded: true,
          taxOverrideAmount: '5.00',
          taxOverrideReason: 'State ruling',
        },
      ],
    });
    renderWithProviders(<InvoiceDetailPage />);
    expect(
      screen.getByText('Software as a service · Business use · Tax included · Tax overridden: State ruling'),
    ).toBeInTheDocument();
  });

  it('shows the engine warnings as readable messages', () => {
    env.invoice = invoice({ taxWarnings: ['not_registered_in_state', 'address_unverified'], taxBreakdown: [], taxTotal: '0.00' });
    renderWithProviders(<InvoiceDetailPage />);

    const warnings = screen.getByTestId('tax-warnings');
    expect(within(warnings).getByText('No sales tax: you are not registered to collect it in WA.')).toBeInTheDocument();
    expect(within(warnings).getByText('The address could not be verified, so the state rate was used.')).toBeInTheDocument();
  });

  it('shows the exempt notice with the certificate number and the exempt amount per jurisdiction', () => {
    env.invoice = invoice({
      taxTotal: '0.00',
      total: '100.00',
      taxBreakdown: [
        row({
          lineId: 'ili_1',
          jurisdictionCode: 'TX',
          jurisdictionName: 'Texas',
          jurisdictionLevel: 'state',
          taxRate: 6.25,
          exemptAmount: 100,
          exemptReason: 'resale',
          certificateId: 'cert_1',
        }),
      ],
    });
    env.certificates = new Map([['cert_1', { id: 'cert_1', certificateNumber: 'A-123', reason: 'resale', states: ['TX'] }]]);
    renderWithProviders(<InvoiceDetailPage />);

    expect(screen.getByTestId('exempt-notice')).toHaveTextContent('Exempt sale: Resale. Certificate no. A-123.');
    expect(screen.getByText('$100.00 exempt')).toBeInTheDocument();
  });

  it('passes the jurisdiction wording and the certificate numbers to the PDF', async () => {
    const user = userEvent.setup();
    env.invoice = invoice({
      taxBreakdown: [row({ jurisdictionCode: 'TX', jurisdictionName: 'Texas', jurisdictionLevel: 'state', taxRate: 6.25, exemptAmount: 100, exemptReason: 'resale', certificateId: 'cert_1' })],
    });
    env.certificates = new Map([['cert_1', { id: 'cert_1', certificateNumber: 'A-123', reason: 'resale', states: ['TX'] }]]);
    renderWithProviders(<InvoiceDetailPage />);

    await user.click(screen.getByRole('button', { name: 'Download PDF' }));

    await waitFor(() => expect(env.generatePdf).toHaveBeenCalledTimes(1));
    const [, , options] = env.generatePdf.mock.calls[0];
    expect(options.certificateNumbers).toEqual(['A-123']);
    expect(options.labels.jurisdictionTax).toBe('{tax} – {jurisdiction} {rate}%');
    expect(options.labels.creditNote).toBe('CREDIT MEMO');
    expect(options.labels.exempt.reasonWithCertificate).toBe('Exempt sale: {reason}. Certificate no. {number}.');
  });

  describe('provider sync', () => {
    const provider = (overrides: Record<string, unknown> = {}) =>
      invoice({ taxEngine: 'avalara', taxWarnings: ['commit_failed: provider returned 502'], ...overrides });

    it('says when the invoice is not recorded with the provider and offers to retry', async () => {
      const user = userEvent.setup();
      env.invoice = provider();
      env.commit.mockImplementation((_id, options) => options.onSuccess({ data: { status: 'committed', ref: 'avl_1' } }));
      renderWithProviders(<InvoiceDetailPage />);

      expect(screen.getByTestId('provider-status')).toHaveTextContent('Not recorded with the provider yet');
      expect(screen.getByText('The invoice could not be recorded with your tax provider.')).toBeInTheDocument();

      await user.click(screen.getByRole('button', { name: 'Retry tax commit' }));
      expect(env.commit).toHaveBeenCalledWith('inv_1', expect.any(Object));
      expect(env.toast.success).toHaveBeenCalledWith('The invoice was recorded with your tax provider.');
    });

    it('says when the invoice is recorded and has no retry button', () => {
      env.invoice = provider({ taxWarnings: [], taxCommittedAt: '2026-03-02T09:00:00Z' });
      renderWithProviders(<InvoiceDetailPage />);

      expect(screen.getByTestId('provider-status')).toHaveTextContent('Recorded at 2026-03-02T09:00:00Z');
      expect(screen.queryByRole('button', { name: 'Retry tax commit' })).not.toBeInTheDocument();
    });

    it('reports a retry that fails again', async () => {
      const user = userEvent.setup();
      env.invoice = provider();
      env.commit.mockImplementation((_id, options) =>
        options.onSuccess({ data: { status: 'failed', warning: 'commit_failed: still down' } }),
      );
      renderWithProviders(<InvoiceDetailPage />);

      await user.click(screen.getByRole('button', { name: 'Retry tax commit' }));
      expect(env.toast.error).toHaveBeenCalledWith('Recording with your tax provider failed.', {
        description: 'commit_failed: still down',
      });
    });

    it('offers no retry on a draft', () => {
      env.invoice = provider({ status: 'draft' });
      renderWithProviders(<InvoiceDetailPage />);
      expect(screen.queryByRole('button', { name: 'Retry tax commit' })).not.toBeInTheDocument();
    });
  });

  describe('finalize', () => {
    beforeEach(() => {
      env.invoice = invoice({ status: 'draft', taxBreakdown: [], taxTotal: '0.00' });
    });

    it('ADDRESS_REQUIRED stays on the page as a notice that links to the invoice addresses', async () => {
      const user = userEvent.setup();
      env.finalize.mockImplementation((_id, options) => options.onError(refusal('ADDRESS_REQUIRED', { status: 400 })));
      renderWithProviders(<InvoiceDetailPage />);

      await user.click(screen.getByRole('button', { name: 'Finalize' }));

      const notice = screen.getByTestId('sales-tax-error');
      expect(notice).toHaveTextContent(/state and ZIP code is needed/);
      expect(within(notice).getByRole('link', { name: 'Edit the invoice addresses' })).toHaveAttribute(
        'href',
        '/weldbooks/invoices/inv_1/edit',
      );
      expect(env.toast.error).not.toHaveBeenCalled();
    });

    it('TAX_ENGINE_UNAVAILABLE links to the sales tax settings', async () => {
      const user = userEvent.setup();
      env.finalize.mockImplementation((_id, options) => options.onError(refusal('TAX_ENGINE_UNAVAILABLE', { status: 503 })));
      renderWithProviders(<InvoiceDetailPage />);

      await user.click(screen.getByRole('button', { name: 'Finalize' }));

      expect(screen.getByRole('link', { name: 'Open sales tax settings' })).toHaveAttribute('href', '/weldbooks/sales-tax/settings');
    });

    it('TAX_RATES_NOT_CONFIGURED links to the agencies', async () => {
      const user = userEvent.setup();
      env.finalize.mockImplementation((_id, options) => options.onError(refusal('TAX_RATES_NOT_CONFIGURED', { status: 400 })));
      renderWithProviders(<InvoiceDetailPage />);

      await user.click(screen.getByRole('button', { name: 'Finalize' }));

      expect(screen.getByRole('link', { name: 'Open sales tax agencies' })).toHaveAttribute('href', '/weldbooks/sales-tax/agencies');
    });

    it('any other failure is a toast, not a notice', async () => {
      const user = userEvent.setup();
      env.finalize.mockImplementation((_id, options) => options.onError(new Error('Period is closed')));
      renderWithProviders(<InvoiceDetailPage />);

      await user.click(screen.getByRole('button', { name: 'Finalize' }));

      expect(screen.queryByTestId('sales-tax-error')).not.toBeInTheDocument();
      expect(env.toast.error).toHaveBeenCalledWith(expect.any(String), { description: 'Period is closed' });
    });

    it('warns when the finalized invoice could not be recorded with the provider', async () => {
      const user = userEvent.setup();
      env.finalize.mockImplementation((_id, options) =>
        options.onSuccess({ data: { taxSync: { status: 'failed', warning: 'commit_failed: 502' } } }),
      );
      renderWithProviders(<InvoiceDetailPage />);

      await user.click(screen.getByRole('button', { name: 'Finalize' }));

      expect(env.toast.warning).toHaveBeenCalledWith('Recording with your tax provider failed.', {
        description: 'commit_failed: 502',
      });
    });
  });

  describe('credit memo', () => {
    it('creates a draft credit memo from a finalized invoice and opens it', async () => {
      const user = userEvent.setup();
      env.createCreditMemo.mockImplementation((_id, options) =>
        options.onSuccess({ data: { id: 'inv_cm1', invoiceNumber: 'CM-0001' } }),
      );
      renderWithProviders(<InvoiceDetailPage />);

      await user.click(screen.getByRole('button', { name: 'More actions' }));
      await user.click(await screen.findByRole('menuitem', { name: 'Create credit memo' }));

      expect(env.createCreditMemo).toHaveBeenCalledWith('inv_1', expect.any(Object));
      expect(env.push).toHaveBeenCalledWith('/weldbooks/invoices/inv_cm1/edit');
    });

    it('links a credit memo to the invoice it credits', () => {
      env.invoice = invoice({ type: 'credit_note', creditNoteForInvoiceId: 'inv_0' });
      renderWithProviders(<InvoiceDetailPage />);

      expect(screen.getByRole('link', { name: 'View the original invoice' })).toHaveAttribute('href', '/weldbooks/invoices/inv_0');
      expect(screen.queryByRole('menuitem', { name: 'Create credit memo' })).not.toBeInTheDocument();
    });
  });

  describe('Dutch invoice', () => {
    it('keeps the VAT rows and has no sales tax card', () => {
      env.salesTax = false;
      env.invoice = invoice({
        currency: 'EUR',
        taxEngine: null,
        taxCalculatedAt: null,
        taxBreakdown: [row({ taxRateName: 'BTW 21%', taxRate: 21, taxableAmount: 100, taxAmount: 21 })],
        items: [{ ...(invoice().items as object[])[0], taxCode: null, taxUse: null }],
      });
      renderWithProviders(<InvoiceDetailPage />);

      expect(screen.getByText('BTW 21%')).toBeInTheDocument();
      expect(screen.queryByTestId('sales-tax-card')).not.toBeInTheDocument();
      expect(screen.queryByTestId('tax-breakdown-row')).not.toBeInTheDocument();
    });
  });
});
