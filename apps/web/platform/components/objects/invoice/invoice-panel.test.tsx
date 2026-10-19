import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { TaxBreakdownRow } from '@/lib/api/domains/weldbooks-sales-tax-preview';

const env = vi.hoisted(() => ({
  invoice: null as unknown,
  loading: false,
  salesTax: true,
  finalize: vi.fn(),
  commit: vi.fn(),
  createCreditMemo: vi.fn(),
  applyCredit: vi.fn(),
  generatePdf: vi.fn(),
  listTemplates: vi.fn(),
  push: vi.fn(),
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() },
  certificates: new Map<string, { id: string; certificateNumber: string | null; reason: string; states: string[] }>(),
}));

vi.mock('sonner', () => ({ toast: env.toast }));
vi.mock('@weldsuite/permissions/react', () => ({ useCan: () => true }));
vi.mock('@/hooks/use-workspace-url', () => ({ useWorkspaceUrl: () => (path: string) => `https://app.test${path}` }));
vi.mock('@weldsuite/ui/components/drawer-field-settings', () => ({ DrawerFieldSettings: () => null }));
vi.mock('@weldsuite/ui/components/entity-detail-view', () => ({
  EntityDetailView: ({
    title,
    actions,
    subheader,
    tabs,
    children,
    footer,
  }: {
    title: ReactNode;
    actions: ReactNode;
    subheader: ReactNode;
    tabs: ReactNode;
    children: ReactNode;
    footer?: ReactNode;
  }) => (
    <div>
      <header>
        <div data-testid="title">{title}</div>
        {actions}
      </header>
      {subheader}
      {tabs}
      <main>{children}</main>
      {footer}
    </div>
  ),
}));
vi.mock('@/components/object-panel', () => import('@/components/objects/_shared/object-panel-test-mock'));
vi.mock('@/components/entity-audit-panel', () => ({
  EntityAuditPanel: ({ entityType, entityId }: { entityType: string; entityId: string }) => (
    <div data-testid="audit" data-entity-type={entityType} data-entity-id={entityId} />
  ),
}));
vi.mock('@/lib/router', async () => {
  const { HrefLink } = await import('@/app/weldbooks/invoices/components/test-utils');
  return { Link: HrefLink, useRouter: () => ({ push: env.push, back: vi.fn() }) };
});
vi.mock('@tanstack/react-router', async () => {
  const { RouteLink } = await import('@/app/weldbooks/invoices/components/test-utils');
  return { Link: RouteLink };
});
vi.mock('@/hooks/queries/use-accounting-queries', () => ({
  useAccountingEntity: () => ({ data: { name: 'Acme LLC', jurisdictionCode: 'US' } }),
  useAccountingInvoice: () => ({
    data: env.invoice ? { data: env.invoice } : undefined,
    isLoading: env.loading,
    isError: false,
  }),
  useFinalizeInvoice: () => ({ mutate: env.finalize, isPending: false }),
  useApplyCreditNote: () => ({ mutate: env.applyCredit, isPending: false }),
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
    entityCurrency: 'USD',
    formatMoney: (value: number | string | null | undefined) => `$${Number(value ?? 0).toFixed(2)}`,
    formatNumber: (value: number | string | null | undefined) => String(Number(value ?? 0)),
    formatDate: (value: string | null | undefined) => value ?? '-',
    formatDateTime: (value: string | null | undefined) => `at ${value}`,
  }),
}));
vi.mock('@/lib/weldbooks/invoice-pdf', () => ({
  generateInvoicePdf: env.generatePdf,
  downloadPdf: vi.fn(),
}));
vi.mock('@/lib/api/domains/weldbooks', () => ({
  accountingApi: { getInvoiceAttachment: vi.fn(), listInvoiceTemplates: env.listTemplates },
}));
vi.mock('@/app/weldbooks/invoices/components/record-payment-dialog', () => ({ RecordPaymentDialog: () => null }));

import { panelOpen } from '@/components/objects/_shared/object-panel-test-mock';
import { InvoicePanel } from './invoice-panel';
import { renderWithProviders } from '@/app/weldbooks/invoices/components/test-utils';

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

function renderPanel() {
  return renderWithProviders(<InvoicePanel id="inv_1" isOpen onClose={vi.fn()} />);
}

async function openTab(user: ReturnType<typeof userEvent.setup>, name: string) {
  await user.click(screen.getByRole('tab', { name }));
}

describe('InvoicePanel', () => {
  beforeEach(() => {
    env.invoice = invoice();
    env.loading = false;
    env.salesTax = true;
    env.certificates = new Map();
    env.finalize.mockReset();
    env.commit.mockReset();
    env.createCreditMemo.mockReset();
    env.applyCredit.mockReset();
    env.generatePdf.mockReset().mockResolvedValue(new Uint8Array());
    // No designed templates: the built-in layout prints.
    env.listTemplates.mockReset().mockResolvedValue({ data: [] });
    env.push.mockReset();
    panelOpen.mockReset();
    Object.values(env.toast).forEach((fn) => fn.mockReset());
  });

  describe('details', () => {
    it('shows the number, the status, the customer, the dates, the address and the figures', () => {
      renderPanel();

      const title = within(screen.getByTestId('title'));
      expect(title.getByText('INV-0001')).toBeInTheDocument();
      expect(title.queryByText('Sent')).not.toBeInTheDocument();
      expect(screen.getByText('Sent')).toBeInTheDocument();
      expect(screen.getByText('Globex')).toBeInTheDocument();
      expect(screen.getByText('ap@globex.test')).toBeInTheDocument();
      expect(screen.getByText('2026-03-01')).toBeInTheDocument();
      expect(screen.getByText('2026-03-31')).toBeInTheDocument();
      expect(screen.getByText('9 Dock Rd')).toBeInTheDocument();
      expect(screen.getByText('Bill to')).toBeInTheDocument();
      expect(screen.getAllByText('$108.25').length).toBeGreaterThan(0);
    });

    it('shows the exchange rate of a foreign currency invoice', () => {
      env.invoice = invoice({ currency: 'EUR', exchangeRate: '0.9200' });
      renderPanel();
      expect(screen.getByTestId('exchange-rate')).toHaveTextContent('1 USD = 0.92 EUR');
    });

    it('shows the audit log of the invoice on its own tab', async () => {
      const user = userEvent.setup();
      renderPanel();

      await openTab(user, 'Audit Log');
      expect(screen.getByTestId('audit')).toHaveAttribute('data-entity-type', 'invoice');
      expect(screen.getByTestId('audit')).toHaveAttribute('data-entity-id', 'inv_1');
    });

    it('says so when the invoice cannot be found', () => {
      env.invoice = null;
      renderPanel();
      expect(screen.getByText('Invoice not found')).toBeInTheDocument();
    });
  });

  describe('actions by status', () => {
    it('a finalized invoice keeps Send and Record payment in its menu, and no longer offers Finalize or Edit', async () => {
      const user = userEvent.setup();
      env.invoice = invoice({ status: 'finalized' });
      renderPanel();

      expect(screen.queryByRole('button', { name: 'Finalize' })).not.toBeInTheDocument();
      await user.click(screen.getByRole('button', { name: 'More actions' }));
      expect(await screen.findByRole('menuitem', { name: 'Send' })).toBeInTheDocument();
      expect(screen.getByRole('menuitem', { name: 'Record Payment' })).toBeInTheDocument();
      expect(screen.queryByRole('link', { name: 'Edit' })).not.toBeInTheDocument();
    });

    it('a draft links to the edit page', () => {
      env.invoice = invoice({ status: 'draft', taxBreakdown: [], taxTotal: '0.00' });
      renderPanel();
      expect(screen.getByRole('link', { name: 'Edit' })).toHaveAttribute('href', '/weldbooks/invoices/inv_1/edit');
    });

    it('a sent invoice can be sent again', async () => {
      const user = userEvent.setup();
      env.invoice = invoice({ status: 'sent' });
      renderPanel();
      await user.click(screen.getByRole('button', { name: 'More actions' }));
      expect(await screen.findByRole('menuitem', { name: 'Send' })).toBeInTheDocument();
    });

    it('asks before finalizing, and does nothing when the user keeps the draft', async () => {
      const user = userEvent.setup();
      env.invoice = invoice({ status: 'draft', taxBreakdown: [], taxTotal: '0.00' });
      renderPanel();

      await user.click(screen.getByRole('button', { name: 'Finalize' }));
      const dialog = await screen.findByRole('dialog');
      expect(within(dialog).getByText(/books the invoice in the ledger and locks it/)).toBeInTheDocument();
      expect(env.finalize).not.toHaveBeenCalled();

      await user.click(within(dialog).getByRole('button', { name: 'Keep as draft' }));
      expect(env.finalize).not.toHaveBeenCalled();
    });
  });

  describe('line items and totals', () => {
    it('shows the tax per jurisdiction in the totals', async () => {
      const user = userEvent.setup();
      renderPanel();

      await openTab(user, 'Line Items');
      const rows = screen.getAllByTestId('tax-breakdown-row');
      expect(rows).toHaveLength(2);
      expect(within(rows[0]).getByText(/Texas/)).toBeInTheDocument();
      expect(within(rows[0]).getByText('6.25% on $100.00')).toBeInTheDocument();
      expect(within(rows[1]).getByText(/Austin/)).toBeInTheDocument();
    });

    it("shows each line's tax code, use and overrides under its description", async () => {
      const user = userEvent.setup();
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
      renderPanel();

      await openTab(user, 'Line Items');
      expect(
        screen.getByText('Software as a service · Business use · Tax included · Tax overridden: State ruling'),
      ).toBeInTheDocument();
    });

    it('shows quantities and rates without trailing zeros', async () => {
      const user = userEvent.setup();
      env.invoice = invoice({
        items: [{ ...(invoice().items as object[])[0], quantity: '10.0000', taxRate: '21.0000', discountPercent: '0.00' }],
      });
      renderPanel();

      await openTab(user, 'Line Items');
      const line = screen.getByText('Hosting').closest('div.group')!;
      expect(within(line as HTMLElement).getByText('10 × $100.00 · Sales tax 21%')).toBeInTheDocument();
      expect(within(line as HTMLElement).queryByText(/10.0000|21.0000/)).not.toBeInTheDocument();
    });

    it('shows the discount of a line', async () => {
      const user = userEvent.setup();
      env.invoice = invoice({ items: [{ ...(invoice().items as object[])[0], discountPercent: '10.0000' }] });
      renderPanel();

      await openTab(user, 'Line Items');
      expect(screen.getByText('1 × $100.00 · Discount 10% · Sales tax 8.25%')).toBeInTheDocument();
    });

    it('says so when the invoice has no lines', async () => {
      const user = userEvent.setup();
      env.invoice = invoice({ items: [], taxBreakdown: [] });
      renderPanel();

      await openTab(user, 'Line Items');
      expect(screen.getByText('No line items')).toBeInTheDocument();
    });
  });

  describe('payments', () => {
    it('lists the payments with their method and reference', async () => {
      const user = userEvent.setup();
      env.invoice = invoice({
        payments: [
          { id: 'pay_1', type: 'received', amount: '50.00', date: '2026-03-05', paymentMethod: 'bank_transfer', reference: 'WIRE-9', invoiceId: 'inv_1', billId: null, contactId: 'cus_1' },
        ],
      });
      renderPanel();

      await openTab(user, 'Payments');
      expect(screen.getByText('2026-03-05')).toBeInTheDocument();
      expect(screen.getByText('WIRE-9')).toBeInTheDocument();
      expect(screen.getByText('$50.00')).toBeInTheDocument();
    });

    it('offers to record the first payment of an open invoice', async () => {
      const user = userEvent.setup();
      renderPanel();

      await openTab(user, 'Payments');
      expect(screen.getByText('No payments yet')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Record Payment' })).toBeInTheDocument();
    });
  });

  describe('sales tax', () => {
    it('shows the engine that calculated the tax, and no provider status for a manual engine', async () => {
      const user = userEvent.setup();
      renderPanel();

      await openTab(user, 'Sales tax');
      const card = screen.getByTestId('sales-tax-card');
      expect(within(card).getByText('Manual rates')).toBeInTheDocument();
      // A manual engine has no provider to record with.
      expect(within(card).queryByTestId('provider-status')).not.toBeInTheDocument();
      expect(within(card).queryByRole('button', { name: 'Retry tax commit' })).not.toBeInTheDocument();
    });

    it('shows the engine warnings as readable messages', async () => {
      const user = userEvent.setup();
      env.invoice = invoice({ taxWarnings: ['not_registered_in_state', 'address_unverified'], taxBreakdown: [], taxTotal: '0.00' });
      renderPanel();

      await openTab(user, 'Sales tax');
      const warnings = screen.getByTestId('tax-warnings');
      expect(within(warnings).getByText('No sales tax: you are not registered to collect it in WA.')).toBeInTheDocument();
      expect(within(warnings).getByText('The address could not be verified, so the state rate was used.')).toBeInTheDocument();
    });

    it('shows the exempt notice with the certificate number and the exempt amount per jurisdiction', async () => {
      const user = userEvent.setup();
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
      renderPanel();

      await openTab(user, 'Sales tax');
      expect(screen.getByTestId('exempt-notice')).toHaveTextContent('Exempt sale: Resale. Certificate no. A-123.');
      await openTab(user, 'Line Items');
      expect(screen.getByText('$100.00 exempt')).toBeInTheDocument();
    });

    describe('provider sync', () => {
      const provider = (overrides: Record<string, unknown> = {}) =>
        invoice({ taxEngine: 'avalara', taxWarnings: ['commit_failed: provider returned 502'], ...overrides });

      it('says when the invoice is not recorded with the provider and offers to retry', async () => {
        const user = userEvent.setup();
        env.invoice = provider();
        env.commit.mockImplementation((_id, options) => options.onSuccess({ data: { status: 'committed', ref: 'avl_1' } }));
        renderPanel();

        await openTab(user, 'Sales tax');
        expect(screen.getByTestId('provider-status')).toHaveTextContent('Not recorded with the provider yet');
        expect(screen.getByText('The invoice could not be recorded with your tax provider.')).toBeInTheDocument();

        await user.click(screen.getByRole('button', { name: 'Retry tax commit' }));
        expect(env.commit).toHaveBeenCalledWith('inv_1', expect.any(Object));
        expect(env.toast.success).toHaveBeenCalledWith('The invoice was recorded with your tax provider.');
      });

      it('says when the invoice is recorded and has no retry button', async () => {
        const user = userEvent.setup();
        env.invoice = provider({ taxWarnings: [], taxCommittedAt: '2026-03-02T09:00:00Z' });
        renderPanel();

        await openTab(user, 'Sales tax');
        expect(screen.getByTestId('provider-status')).toHaveTextContent('Recorded at 2026-03-02T09:00:00Z');
        expect(screen.queryByRole('button', { name: 'Retry tax commit' })).not.toBeInTheDocument();
      });

      it('reports a retry that fails again', async () => {
        const user = userEvent.setup();
        env.invoice = provider();
        env.commit.mockImplementation((_id, options) =>
          options.onSuccess({ data: { status: 'failed', warning: 'commit_failed: still down' } }),
        );
        renderPanel();

        await openTab(user, 'Sales tax');
        await user.click(screen.getByRole('button', { name: 'Retry tax commit' }));
        expect(env.toast.error).toHaveBeenCalledWith('Recording with your tax provider failed.', {
          description: 'commit_failed: still down',
        });
      });

      it('offers no retry on a draft', async () => {
        const user = userEvent.setup();
        env.invoice = provider({ status: 'draft' });
        renderPanel();

        await openTab(user, 'Sales tax');
        expect(screen.queryByRole('button', { name: 'Retry tax commit' })).not.toBeInTheDocument();
      });
    });
  });

  describe('PDF', () => {
    it('passes the jurisdiction wording and the certificate numbers to the PDF', async () => {
      const user = userEvent.setup();
      env.invoice = invoice({
        taxBreakdown: [row({ jurisdictionCode: 'TX', jurisdictionName: 'Texas', jurisdictionLevel: 'state', taxRate: 6.25, exemptAmount: 100, exemptReason: 'resale', certificateId: 'cert_1' })],
      });
      env.certificates = new Map([['cert_1', { id: 'cert_1', certificateNumber: 'A-123', reason: 'resale', states: ['TX'] }]]);
      renderPanel();

      await user.click(screen.getByRole('button', { name: 'More actions' }));
      await user.click(await screen.findByRole('menuitem', { name: 'Download PDF' }));

      await waitFor(() => expect(env.generatePdf).toHaveBeenCalledTimes(1));
      const [, , options] = env.generatePdf.mock.calls[0];
      expect(options.certificateNumbers).toEqual(['A-123']);
      expect(options.labels.jurisdictionTax).toBe('{tax} – {jurisdiction} {rate}%');
      expect(options.labels.creditNote).toBe('CREDIT MEMO');
      expect(options.labels.exempt.reasonWithCertificate).toBe('Exempt sale: {reason}. Certificate no. {number}.');
    });

    it('does not fall back to the built-in layout when the invoice templates cannot be loaded', async () => {
      const user = userEvent.setup();
      env.listTemplates.mockRejectedValue(new Error('offline'));
      renderPanel();

      await user.click(screen.getByRole('button', { name: 'More actions' }));
      await user.click(await screen.findByRole('menuitem', { name: 'Download PDF' }));

      await waitFor(() => expect(env.toast.error).toHaveBeenCalled());
      expect(env.generatePdf).not.toHaveBeenCalled();
    });
  });

  describe('finalize', () => {
    /** Finalizing is irreversible: the button asks first. */
    const finalize = async (user: ReturnType<typeof userEvent.setup>) => {
      await user.click(screen.getByRole('button', { name: 'Finalize' }));
      const dialog = await screen.findByRole('dialog');
      expect(within(dialog).getByText('Finalize this invoice?')).toBeInTheDocument();
      await user.click(within(dialog).getByRole('button', { name: 'Finalize' }));
    };

    beforeEach(() => {
      env.invoice = invoice({ status: 'draft', taxBreakdown: [], taxTotal: '0.00' });
    });

    it('ADDRESS_REQUIRED stays in the panel as a notice that links to the invoice addresses', async () => {
      const user = userEvent.setup();
      env.finalize.mockImplementation((_id, options) => options.onError(refusal('ADDRESS_REQUIRED', { status: 400 })));
      renderPanel();

      await finalize(user);

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
      renderPanel();

      await finalize(user);

      expect(screen.getByRole('link', { name: 'Open sales tax settings' })).toHaveAttribute('href', '/weldbooks/sales-tax/settings');
    });

    it('TAX_RATES_NOT_CONFIGURED links to the agencies', async () => {
      const user = userEvent.setup();
      env.finalize.mockImplementation((_id, options) => options.onError(refusal('TAX_RATES_NOT_CONFIGURED', { status: 400 })));
      renderPanel();

      await finalize(user);

      expect(screen.getByRole('link', { name: 'Open sales tax agencies' })).toHaveAttribute('href', '/weldbooks/sales-tax/agencies');
    });

    it('any other failure is a toast, not a notice', async () => {
      const user = userEvent.setup();
      env.finalize.mockImplementation((_id, options) => options.onError(new Error('Period is closed')));
      renderPanel();

      await finalize(user);

      expect(screen.queryByTestId('sales-tax-error')).not.toBeInTheDocument();
      expect(env.toast.error).toHaveBeenCalledWith(expect.any(String), { description: 'Period is closed' });
    });

    it('warns when the finalized invoice could not be recorded with the provider', async () => {
      const user = userEvent.setup();
      env.finalize.mockImplementation((_id, options) =>
        options.onSuccess({ data: { taxSync: { status: 'failed', warning: 'commit_failed: 502' } } }),
      );
      renderPanel();

      await finalize(user);

      expect(env.toast.warning).toHaveBeenCalledWith('Recording with your tax provider failed.', {
        description: 'commit_failed: 502',
      });
    });
  });

  describe('credit memo', () => {
    it('creates a draft credit memo from a finalized invoice and opens its edit page', async () => {
      const user = userEvent.setup();
      env.createCreditMemo.mockImplementation((_id, options) =>
        options.onSuccess({ data: { id: 'inv_cm1', invoiceNumber: 'CM-0001' } }),
      );
      renderPanel();

      await user.click(screen.getByRole('button', { name: 'More actions' }));
      await user.click(await screen.findByRole('menuitem', { name: 'Create credit memo' }));

      expect(env.createCreditMemo).toHaveBeenCalledWith('inv_1', expect.any(Object));
      expect(env.push).toHaveBeenCalledWith('/weldbooks/invoices/inv_cm1/edit');
    });

    it('opens the invoice a credit memo credits, in place with a back arrow', async () => {
      const user = userEvent.setup();
      env.invoice = invoice({ type: 'credit_note', creditNoteForInvoiceId: 'inv_0' });
      renderPanel();

      expect(within(screen.getByTestId('title')).getByText('Credit memo')).toBeInTheDocument();
      await user.click(screen.getByRole('button', { name: 'View the original invoice' }));
      expect(panelOpen).toHaveBeenCalledWith({ type: 'invoice', id: 'inv_0', stack: true });

      await user.click(screen.getByRole('button', { name: 'More actions' }));
      expect(screen.queryByRole('menuitem', { name: 'Create credit memo' })).not.toBeInTheDocument();
    });

    it('an open credit memo is refunded or applied, never paid in or written off', async () => {
      const user = userEvent.setup();
      env.invoice = invoice({ type: 'credit_note', creditNoteForInvoiceId: 'inv_0', amountPaid: '8.25', balanceDue: '100.00' });
      env.applyCredit.mockImplementation((_vars, options) => options.onSuccess({ data: { amount: '100.00' } }));
      renderPanel();

      await user.click(screen.getByRole('button', { name: 'More actions' }));
      expect(await screen.findByRole('menuitem', { name: 'Record refund' })).toBeInTheDocument();
      expect(screen.queryByRole('menuitem', { name: 'Record Payment' })).not.toBeInTheDocument();
      await user.keyboard('{Escape}');
      expect(screen.getByText('Credit remaining')).toBeInTheDocument();
      expect(screen.getByText('Applied or refunded')).toBeInTheDocument();

      await user.click(screen.getByRole('button', { name: 'Apply to the invoice' }));
      expect(env.applyCredit).toHaveBeenCalledWith({ id: 'inv_1' }, expect.any(Object));
      expect(env.toast.success).toHaveBeenCalledWith('$100.00 applied to the invoice');

      await user.click(screen.getByRole('button', { name: 'More actions' }));
      expect(screen.queryByRole('menuitem', { name: 'Mark as uncollectible' })).not.toBeInTheDocument();
    });

    it('lists the credit memos issued against an invoice and opens one in place', async () => {
      const user = userEvent.setup();
      env.invoice = invoice({
        creditNotes: [{ id: 'inv_cm1', invoiceNumber: 'CM-0001', status: 'paid', issueDate: '2026-03-05', total: '20.00' }],
      });
      renderPanel();

      await openTab(user, 'Credit notes');
      expect(screen.getByText('-$20.00')).toBeInTheDocument();
      await user.click(screen.getByRole('button', { name: 'CM-0001' }));
      expect(panelOpen).toHaveBeenCalledWith({ type: 'invoice', id: 'inv_cm1', stack: true });
    });

    it('has no credit notes tab until one was issued', () => {
      renderPanel();
      expect(screen.queryByRole('tab', { name: 'Credit notes' })).not.toBeInTheDocument();
    });
  });

  describe('Dutch invoice', () => {
    it('keeps the VAT rows and has no sales tax tab', async () => {
      const user = userEvent.setup();
      env.salesTax = false;
      env.invoice = invoice({
        currency: 'EUR',
        taxEngine: null,
        taxCalculatedAt: null,
        taxBreakdown: [row({ taxRateName: 'BTW 21%', taxRate: 21, taxableAmount: 100, taxAmount: 21 })],
        items: [{ ...(invoice().items as object[])[0], taxCode: null, taxUse: null }],
      });
      renderPanel();

      expect(screen.queryByRole('tab', { name: 'Sales tax' })).not.toBeInTheDocument();
      await openTab(user, 'Line Items');
      expect(screen.getByText('BTW 21%')).toBeInTheDocument();
      expect(screen.queryByTestId('sales-tax-card')).not.toBeInTheDocument();
      expect(screen.queryByTestId('tax-breakdown-row')).not.toBeInTheDocument();
    });
  });
});
