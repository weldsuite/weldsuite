import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const env = vi.hoisted(() => ({
  bill: null as unknown,
  loading: false,
  us: true,
  permissions: new Set<string>(),
  approve: vi.fn(),
  recordPayment: vi.fn(),
  // Stable, like the real formatter's callbacks: the payment dialog resets its form when this changes.
  today: () => '2026-03-15',
  toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock('sonner', () => ({ toast: env.toast }));
vi.mock('@weldsuite/permissions/react', () => ({
  usePermissions: () => ({ can: (permission: string) => env.permissions.has(permission) }),
}));
vi.mock('@/hooks/use-workspace-url', () => ({ useWorkspaceUrl: () => (path: string) => `https://app.test${path}` }));
vi.mock('@weldsuite/ui/components/drawer-field-settings', () => ({ DrawerFieldSettings: () => null }));
vi.mock('@weldsuite/ui/components/entity-detail-view', () => ({
  EntityDetailView: ({
    title,
    actions,
    subheader,
    tabs,
    children,
  }: {
    title: ReactNode;
    actions: ReactNode;
    subheader: ReactNode;
    tabs: ReactNode;
    children: ReactNode;
  }) => (
    <div>
      <header>
        <div data-testid="title">{title}</div>
        {actions}
      </header>
      {subheader}
      {tabs}
      <main>{children}</main>
    </div>
  ),
}));
vi.mock('@/components/object-panel', () => ({
  useObjectPanelShell: () => ({ mode: 'fullscreen', setMode: vi.fn(), entityDetailViewProps: {} }),
  useObjectPanelTabConfig: () => ({
    visibility: {},
    isVisible: () => true,
    toggle: vi.fn(),
    resetToDefaults: vi.fn(),
  }),
  ObjectPanelTabs: ({
    tabs,
    activeTab,
    onChange,
  }: {
    tabs: { id: string; label: string }[];
    activeTab: string;
    onChange: (id: string) => void;
  }) => (
    <div role="tablist">
      {tabs.map((tab) => (
        <button key={tab.id} role="tab" aria-selected={tab.id === activeTab} onClick={() => onChange(tab.id)}>
          {tab.label}
        </button>
      ))}
    </div>
  ),
}));
vi.mock('@/components/entity-audit-panel', () => ({
  EntityAuditPanel: ({ entityType, entityId }: { entityType: string; entityId: string }) => (
    <div data-testid="audit" data-entity-type={entityType} data-entity-id={entityId} />
  ),
}));
vi.mock('@tanstack/react-router', async () => {
  const { RouteLink } = await import('@/app/weldbooks/invoices/components/test-utils');
  return { Link: RouteLink, useParams: () => ({ id: 'bil_1' }), useNavigate: () => vi.fn() };
});
vi.mock('@/lib/router', async () => {
  const { HrefLink } = await import('@/app/weldbooks/invoices/components/test-utils');
  return { Link: HrefLink };
});
vi.mock('@/hooks/queries/use-accounting-queries', () => ({
  useAccountingBill: () => ({
    data: env.bill ? { data: env.bill } : undefined,
    isLoading: env.loading,
    isError: false,
  }),
  useApproveBill: () => ({ mutate: env.approve, isPending: false }),
  useRejectBill: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock('@/hooks/queries/use-weldbooks-banking-queries', () => ({
  useBankAccounts: () => ({
    data: {
      data: [
        { id: 'ba_1', name: 'Operating', accountType: 'checking', isActive: true, isDefault: false },
        { id: 'ba_2', name: 'Savings', accountType: 'savings', isActive: true, isDefault: true },
      ],
    },
  }),
  useRecordBillPaymentWithTarget: () => ({ mutate: env.recordPayment, isPending: false }),
  useRecordInvoicePaymentWithTarget: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock('@/lib/weldbooks/use-jurisdiction', () => ({
  useCurrentJurisdiction: () => ({ code: env.us ? 'US' : 'NL' }),
  useJurisdictionLabels: () => ({
    labels: { tax: 'Tax' },
    features: { salesTax: env.us, form1099: env.us },
  }),
}));
vi.mock('@/lib/weldbooks/use-weldbooks-format', () => ({
  useWeldbooksFormat: () => ({
    formatMoney: (value: number | string | null | undefined) => `$${Number(value ?? 0).toFixed(2)}`,
    formatNumber: (value: number | string | null | undefined) => String(Number(value ?? 0)),
    formatDate: (value: string | null | undefined) => value ?? '-',
    today: env.today,
    entityCurrency: 'USD',
  }),
}));
vi.mock('@/lib/api/domains/weldbooks', () => ({ accountingApi: { getBillAttachment: vi.fn() } }));

import { BillPanel } from './bill-panel';
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

function renderPanel() {
  return renderWithProviders(<BillPanel id="bil_1" isOpen onClose={vi.fn()} />);
}

async function openTab(name: string) {
  await userEvent.click(screen.getByRole('tab', { name }));
}

describe('BillPanel', () => {
  beforeEach(() => {
    env.bill = bill();
    env.loading = false;
    env.us = true;
    env.permissions = new Set(['bills:read', 'bills:update']);
    env.approve.mockReset();
    env.recordPayment.mockReset();
    Object.values(env.toast).forEach((fn) => fn.mockReset());
  });

  it('shows the money, the supplier, the dates, the reference and the delivery address in the details', () => {
    renderPanel();

    expect(within(screen.getByTestId('title')).getByText('BILL-1')).toBeInTheDocument();
    expect(screen.getByText('Dell')).toBeInTheDocument();
    expect(screen.getByText(/1 Dell Way/)).toBeInTheDocument();
    expect(screen.getByText('2026-03-01')).toBeInTheDocument();
    expect(screen.getByText('2026-03-31')).toBeInTheDocument();
    expect(screen.getByText('D-77')).toBeInTheDocument();
    expect(screen.getByText('Delivery address')).toBeInTheDocument();
    expect(screen.getByText(/5 Depot Way/)).toBeInTheDocument();
    expect(screen.getAllByText('$1082.50').length).toBeGreaterThan(0);
  });

  it('shows the use tax the bill accrued on its own tab, apart from the vendor tax on the lines', async () => {
    renderPanel();

    await openTab('Tax');
    const card = screen.getByTestId('use-tax-card');
    expect(within(card).getByText('Use tax accrued')).toBeInTheDocument();
    expect(within(card).getByText('$62.50')).toBeInTheDocument();
    expect(within(card).getByText('6.25% on $1000.00')).toBeInTheDocument();

    await openTab('Line items');
    expect(screen.getByText('Sales tax paid (part of cost)')).toBeInTheDocument();
  });

  it('shows translated status labels in the title, not the raw status values', () => {
    env.bill = bill({ status: 'draft', approvalStatus: 'pending' });
    renderPanel();

    const title = within(screen.getByTestId('title'));
    // One chip: the approval while it is pending, not the status next to it.
    expect(title.getByText('Pending approval')).toBeInTheDocument();
    expect(title.queryByText('Draft')).not.toBeInTheDocument();
    expect(title.queryByText('draft')).not.toBeInTheDocument();
    expect(title.queryByText('pending')).not.toBeInTheDocument();
  });

  it('shows the status once an approved bill is no longer waiting for approval', () => {
    env.bill = bill({ status: 'partial', approvalStatus: 'approved' });
    renderPanel();

    const title = within(screen.getByTestId('title'));
    expect(title.getByText('Partially paid')).toBeInTheDocument();
    expect(title.queryByText('Approved')).not.toBeInTheDocument();
  });

  it('shows quantities without trailing zeros', async () => {
    env.bill = bill({ items: [{ ...(bill().items as object[])[0], quantity: '10.0000', discountPercent: '5.0000' }] });
    renderPanel();

    await openTab('Line items');
    const line = screen.getByText('Laptop').closest('div.group')!;
    expect(within(line as HTMLElement).getByText('10')).toBeInTheDocument();
    expect(within(line as HTMLElement).getByText('5%')).toBeInTheDocument();
  });

  it('shows the tax code, the use tax flag and the 1099 box of a line', async () => {
    renderPanel();

    await openTab('Line items');
    expect(screen.getByText('General goods · Accrue use tax · Omit from 1099')).toBeInTheDocument();
  });

  it('shows the totals, and what was paid only once a payment was made', async () => {
    renderPanel();
    await openTab('Line items');
    expect(screen.getByText('Subtotal')).toBeInTheDocument();
    expect(screen.queryByText('Balance due')).not.toBeInTheDocument();
  });

  it('shows the paid amount and the balance due of a part-paid bill under the lines', async () => {
    env.bill = bill({ status: 'partial', amountPaid: '500.00', balanceDue: '582.50' });
    renderPanel();

    await openTab('Line items');
    expect(screen.getByText('Balance due')).toBeInTheDocument();
    expect(screen.getAllByText('$582.50').length).toBeGreaterThan(0);
  });

  it('offers to create a fixed asset from each line of an approved bill', async () => {
    renderPanel();

    await openTab('Line items');
    const links = screen.getAllByRole('link', { name: 'Create fixed asset' });
    expect(links.map((link) => link.getAttribute('href'))).toEqual([
      '/weldbooks/fixed-assets/new?billItemId=bli_1',
      '/weldbooks/fixed-assets/new?billItemId=bli_2',
    ]);
  });

  it('does not offer fixed assets for a bill that is not approved yet', async () => {
    env.bill = bill({ status: 'draft', approvalStatus: 'pending' });
    renderPanel();

    await openTab('Line items');
    expect(screen.queryByRole('link', { name: 'Create fixed asset' })).not.toBeInTheDocument();
  });

  it('says so when the bill has no lines', async () => {
    env.bill = bill({ items: [] });
    renderPanel();

    await openTab('Line items');
    expect(screen.getByText('No line items')).toBeInTheDocument();
  });

  it('shows a refused approval as a notice when the tax engine is down, with a link to the settings', async () => {
    const user = userEvent.setup();
    env.bill = bill({ status: 'pending_approval', approvalStatus: 'pending', taxBreakdown: [] });
    env.approve.mockImplementation((_id, options) =>
      options.onError(Object.assign(new Error('refused'), { code: 'TAX_ENGINE_UNAVAILABLE', status: 503 })),
    );
    renderPanel();

    await user.click(screen.getByRole('button', { name: 'Approve' }));
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Approve' }));

    const notice = screen.getByTestId('sales-tax-error');
    expect(notice).toHaveTextContent('The sales tax engine is not reachable right now, so nothing was posted.');
    expect(within(notice).getByRole('link', { name: 'Open sales tax settings' })).toBeInTheDocument();
    expect(env.toast.error).not.toHaveBeenCalled();
  });

  it('asks before approving, then approves and says so', async () => {
    const user = userEvent.setup();
    env.bill = bill({ status: 'pending_approval', approvalStatus: 'pending' });
    env.approve.mockImplementation((_id, options) => options.onSuccess());
    renderPanel();

    await user.click(screen.getByRole('button', { name: 'Approve' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Approve this bill?')).toBeInTheDocument();
    expect(within(dialog).getByText(/Approving books the bill in the ledger/)).toBeInTheDocument();
    expect(env.approve).not.toHaveBeenCalled();

    await user.click(within(dialog).getByRole('button', { name: 'Approve' }));
    expect(env.approve).toHaveBeenCalledWith('bil_1', expect.any(Object));
    expect(env.toast.success).toHaveBeenCalledWith('Bill approved');
  });

  it('does not approve when the confirmation is dismissed', async () => {
    const user = userEvent.setup();
    env.bill = bill({ status: 'pending_approval', approvalStatus: 'pending' });
    renderPanel();

    await user.click(screen.getByRole('button', { name: 'Approve' }));
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Cancel' }));
    expect(env.approve).not.toHaveBeenCalled();
  });

  it('approves a bill that waits for approval, and only for a member who may update bills', () => {
    env.bill = bill({ status: 'pending_approval', approvalStatus: 'pending' });
    const { unmount } = renderPanel();
    expect(screen.getByRole('button', { name: 'Approve' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reject' })).toBeInTheDocument();
    unmount();

    env.permissions = new Set(['bills:read']);
    renderPanel();
    expect(screen.queryByRole('button', { name: 'Approve' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Reject' })).not.toBeInTheDocument();
  });

  it('offers to edit a draft bill only', () => {
    env.bill = bill({ status: 'draft', approvalStatus: 'pending' });
    const { unmount } = renderPanel();
    expect(screen.getByRole('link', { name: 'Edit' })).toHaveAttribute('href', '/weldbooks/bills/bil_1/edit');
    unmount();

    env.bill = bill();
    renderPanel();
    expect(screen.queryByRole('link', { name: 'Edit' })).not.toBeInTheDocument();
  });

  it('turns the balance due red only when the bill is overdue', () => {
    const redBalance = () =>
      screen.getAllByText('$1082.50').some((element) => element.classList.contains('text-destructive'));

    // Open, but not yet due.
    env.bill = bill({ dueDate: '2999-01-01' });
    const { unmount } = renderPanel();
    expect(redBalance()).toBe(false);
    unmount();

    env.bill = bill({ status: 'overdue' });
    renderPanel();
    expect(redBalance()).toBe(true);
  });

  it('uses the same sentence-case labels as the invoice for paid, balance due and the dates', () => {
    renderPanel();
    expect(screen.getByText('Paid')).toBeInTheDocument();
    expect(screen.getByText('Balance due')).toBeInTheDocument();
    expect(screen.getByText('Issue date')).toBeInTheDocument();
    expect(screen.getByText('Due date')).toBeInTheDocument();
  });

  it("names the supplier's default account on a line that has none", async () => {
    env.bill = bill({
      defaultExpenseAccount: { id: 'acc_9', code: '6100', name: 'Office costs' },
      items: [
        { ...(bill().items as object[])[0], accountId: null },
        { ...(bill().items as object[])[1], accountId: 'acc_1' },
      ],
    });
    renderPanel();

    await openTab('Line items');
    expect(screen.getAllByTestId('default-account')).toHaveLength(1);
    expect(screen.getByText('Default: 6100 — Office costs')).toBeInTheDocument();
  });

  it('shows no default account when the supplier has none', async () => {
    env.bill = bill({
      defaultExpenseAccount: null,
      items: [{ ...(bill().items as object[])[0], accountId: null }],
    });
    renderPanel();

    await openTab('Line items');
    expect(screen.queryByTestId('default-account')).not.toBeInTheDocument();
  });

  describe('payments', () => {
    beforeEach(() => {
      env.permissions = new Set(['bills:read', 'bills:update', 'banking:create']);
    });

    it('offers to record a payment on an approved bill with a balance due', () => {
      renderPanel();
      expect(screen.getByRole('button', { name: 'Record payment' })).toBeInTheDocument();
    });

    it.each([
      ['a paid bill', { status: 'paid', balanceDue: '0.00', amountPaid: '1082.50' }],
      ['a draft', { status: 'draft', approvalStatus: 'pending' }],
      ['a bill waiting for approval', { status: 'pending_approval', approvalStatus: 'pending' }],
    ])('does not offer a payment on %s', (_name, overrides) => {
      env.bill = bill(overrides);
      renderPanel();
      expect(screen.queryByRole('button', { name: 'Record payment' })).not.toBeInTheDocument();
    });

    it('needs banking:create to record a payment', () => {
      env.permissions = new Set(['bills:read', 'bills:update']);
      renderPanel();
      expect(screen.queryByRole('button', { name: 'Record payment' })).not.toBeInTheDocument();
    });

    it('pays the bill from the default bank account', async () => {
      const user = userEvent.setup();
      renderPanel();

      await user.click(screen.getByRole('button', { name: 'Record payment' }));
      const dialog = await screen.findByRole('dialog');
      expect(within(dialog).getByTestId('deposit-to')).toHaveTextContent('Savings');
      await user.click(within(dialog).getByRole('button', { name: 'Record payment' }));

      expect(env.recordPayment).toHaveBeenCalledTimes(1);
      expect(env.recordPayment.mock.calls[0][0]).toEqual({
        id: 'bil_1',
        data: {
          amount: '1082.50',
          date: '2026-03-15',
          paymentMethod: expect.any(String),
          reference: undefined,
          bankAccountId: 'ba_2',
        },
      });
    });

    it('lists the payments made on the Payments tab, with a record action when none were made', async () => {
      env.bill = bill({
        status: 'partial',
        amountPaid: '500.00',
        balanceDue: '582.50',
        payments: [
          { id: 'pay_1', type: 'payment', amount: '500.00', date: '2026-03-10', paymentMethod: 'ach', reference: 'RUN-4', invoiceId: null, billId: 'bil_1', contactId: 'sup_1' },
        ],
      });
      const { unmount } = renderPanel();
      await openTab('Payments');
      expect(screen.getByText('2026-03-10')).toBeInTheDocument();
      expect(screen.getByText('RUN-4')).toBeInTheDocument();
      expect(screen.getByText('$500.00')).toBeInTheDocument();
      unmount();

      env.bill = bill({ payments: [] });
      renderPanel();
      await openTab('Payments');
      expect(screen.getByText('No payments yet')).toBeInTheDocument();
      expect(screen.getAllByRole('button', { name: 'Record payment' }).length).toBeGreaterThan(1);
    });
  });

  it('shows the audit trail of the bill on the history tab', async () => {
    renderPanel();

    await openTab('Audit Log');
    expect(screen.getByTestId('audit')).toHaveAttribute('data-entity-type', 'bill');
    expect(screen.getByTestId('audit')).toHaveAttribute('data-entity-id', 'bil_1');
  });

  it('keeps a Dutch bill as it was: no tax tab, delivery address or fixed assets', async () => {
    env.us = false;
    env.bill = bill({
      currency: 'EUR',
      deliveryAddress: null,
      taxBreakdown: null,
      items: [{ ...(bill().items as object[])[0], taxCode: null, accrueUseTax: false, form1099Box: null }],
    });
    renderPanel();

    expect(screen.queryByRole('tab', { name: 'Tax' })).not.toBeInTheDocument();
    expect(screen.queryByText('Delivery address')).not.toBeInTheDocument();

    await openTab('Line items');
    expect(screen.queryByRole('link', { name: 'Create fixed asset' })).not.toBeInTheDocument();
    expect(screen.queryByText('Sales tax paid (part of cost)')).not.toBeInTheDocument();
  });
});
