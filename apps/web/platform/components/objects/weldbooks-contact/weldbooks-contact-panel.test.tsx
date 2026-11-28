import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { en } from '@weldsuite/i18n/locales/en';

const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), patch: vi.fn(), put: vi.fn(), delete: vi.fn() }));
vi.mock('@/lib/api/weldbooks-client', () => ({ weldbooksApi: api, setWeldbooksEntityId: vi.fn() }));
vi.mock('@tanstack/react-router', () => ({
  Link: ({
    to,
    search,
    params: _params,
    children,
    ...rest
  }: {
    to: string;
    search?: Record<string, string>;
    params?: Record<string, string>;
    children: React.ReactNode;
  }) => (
    <a href={search ? `${to}?${new URLSearchParams(search).toString()}` : to} {...rest}>
      {children}
    </a>
  ),
  useNavigate: () => vi.fn(),
}));
const permissions = vi.hoisted(() => ({ allowed: new Set<string>() }));
const edition = vi.hoisted(() => ({ processing: false }));
// The panel without the contact page (`books-contact-page`) and without quotes:
// the contact page has its tests in weldbooks-contact-page.test.tsx, the
// Quotes tab in weldbooks-contact-quotes-tab.test.tsx.
vi.mock('@/lib/edition', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/edition')>();
  return {
    ...actual,
    isFeatureAvailable: (feature: Parameters<typeof actual.isFeatureAvailable>[0]) => {
      if (feature === 'books-bank-processing') return edition.processing;
      if (feature === 'books-contact-page' || feature === 'books-quotes') return false;
      return actual.isFeatureAvailable(feature);
    },
  };
});
vi.mock('@weldsuite/permissions/react', () => ({
  usePermissions: () => ({ can: (permission: string) => permissions.allowed.has(permission) }),
}));
const jurisdiction = vi.hoisted(() => ({ salesTax: true }));
vi.mock('@/lib/weldbooks/use-jurisdiction', () => ({
  useJurisdictionLabels: () => ({
    labels: { supplier: 'Vendor', taxId: 'EIN', registrationId: 'State ID', customerAndSupplier: 'Customer + vendor' },
    features: { salesTax: jurisdiction.salesTax },
  }),
}));
vi.mock('@/hooks/use-current-entity-currency', () => ({
  useCurrentEntityCurrency: () => ({ formatMoney: (value: string | null | undefined) => `$${value ?? '0'}`, entityCurrency: 'USD' }),
}));
vi.mock('@/lib/weldbooks/use-weldbooks-format', () => ({
  useWeldbooksFormat: () => ({
    formatDate: (value: string | null | undefined) => `date:${value ?? ''}`,
    formatMoney: (value: string) => `$${value}`,
    today: () => '2026-10-08',
  }),
}));
vi.mock('@/hooks/use-workspace-url', () => ({ useWorkspaceUrl: () => (path: string) => `https://app.test${path}` }));
// Tab visibility is a per-user setting; the defaults are all these tests need.
vi.mock('@/hooks/queries/use-settings-queries', () => ({
  useGridViewSettings: () => ({ data: undefined, isLoading: false }),
  useUpdateGridView: () => ({ mutate: vi.fn() }),
}));
vi.mock('@/components/entity-audit-panel', () => ({
  EntityAuditPanel: ({ entityType, entityId }: { entityType: string; entityId: string }) => (
    <div data-testid="audit-panel">{`${entityType}:${entityId}`}</div>
  ),
}));
const panel = vi.hoisted(() => ({ open: vi.fn() }));
vi.mock('@/components/object-panel', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/components/object-panel')>()),
  useObjectPanel: () => ({ open: panel.open }),
}));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock('sonner', () => ({ toast }));

import { WeldbooksContactPanel } from './weldbooks-contact-panel';
import {
  installPointerPolyfills,
  makeCertificate,
  renderWithProviders,
} from '@/app/weldbooks/sales-tax/setup/test-support';

const tx = en.weldbooksUs.salesTax.setup.exemptions;
const tc = en.accounting.contacts;

const noBalance = { receivable: { totalOutstanding: '0', totalOverdue: '0' }, payable: { totalOutstanding: '0', totalOverdue: '0' } };

function page<T>(rows: T[]) {
  return { data: rows, pagination: { page: 1, pageSize: 50, totalCount: rows.length, totalPages: 1, hasMore: false } };
}

function serve(
  contact: Record<string, unknown>,
  certificates: unknown[] = [],
  documents: { balance?: unknown; invoices?: unknown[]; bills?: unknown[]; credits?: unknown[] } = {},
) {
  api.get.mockImplementation(async (path: string) => {
    if (path.endsWith('/credits')) return { data: documents.credits ?? [] };
    if (path.startsWith('/exemption-certificates')) return { data: certificates };
    if (path.endsWith('/balance')) return { data: documents.balance ?? noBalance };
    if (path.startsWith('/invoices')) return page(documents.invoices ?? []);
    if (path.startsWith('/bills')) return page(documents.bills ?? []);
    if (path.startsWith('/accounting-contacts/')) return { data: contact };
    return { data: [] };
  });
}

const customer = { id: 'prt_1', name: 'Acme Corp', role: 'customer', email: 'ap@acme.test', taxUse: 'business' };

const onClose = vi.fn();

function renderPanel(mode: 'panel' | 'fullscreen' = 'fullscreen', initialTab?: string) {
  return renderWithProviders(
    <WeldbooksContactPanel id="prt_1" isOpen onClose={onClose} mode={mode} onModeChange={vi.fn()} initialTab={initialTab} />,
  );
}

async function openMenu(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole('button', { name: en.accounting.invoiceDetail.moreActions }));
}

beforeAll(installPointerPolyfills);

beforeEach(() => {
  api.get.mockReset();
  onClose.mockReset();
  panel.open.mockReset();
  toast.success.mockReset();
  toast.error.mockReset();
  jurisdiction.salesTax = true;
  edition.processing = false;
  api.post.mockReset();
  permissions.allowed = new Set(['taxes:read', 'taxes:create']);
});

describe('WeldBooks contact panel: editing the details in place', () => {
  const company = { ...customer, kind: 'company', companyName: 'Acme Corp' };

  beforeEach(() => {
    api.patch.mockReset().mockResolvedValue({ data: {} });
  });

  it('fills in an empty field and saves just that field', async () => {
    const user = userEvent.setup();
    permissions.allowed.add('invoices:update');
    serve(company);
    renderPanel();

    await screen.findByText('ap@acme.test');
    await user.click(screen.getByRole('button', { name: tc.phone }));
    await user.keyboard('+31 20 999{Enter}');

    expect(api.patch).toHaveBeenCalledWith('/accounting-contacts/prt_1', { phone: '+31 20 999' });
  });

  it('keeps the name on invoices in step with a renamed company', async () => {
    const user = userEvent.setup();
    permissions.allowed.add('invoices:update');
    serve(company);
    renderPanel();

    await screen.findByText('ap@acme.test');
    await user.click(screen.getByRole('button', { name: tc.companyName }));
    await user.keyboard('{Control>}a{/Control}Acme Holding{Enter}');

    expect(api.patch).toHaveBeenCalledWith('/accounting-contacts/prt_1', {
      companyName: 'Acme Holding',
      name: 'Acme Holding',
    });
  });

  it('saves a same-as-billing shipping address along with the billing address', async () => {
    const user = userEvent.setup();
    permissions.allowed.add('invoices:update');
    serve(company);
    renderPanel();

    await screen.findByText('ap@acme.test');
    await user.click(screen.getByRole('button', { name: tc.billingAddress }));
    await user.type(await screen.findByLabelText(/Address line 1/), 'Main Street 1');
    await user.click(screen.getByRole('button', { name: /^Save$/ }));

    const [, body] = api.patch.mock.calls.at(-1) as [string, Record<string, unknown>];
    expect(body.billingAddress).toEqual(body.shippingAddress);
    expect(body.billingAddress).toMatchObject({ line1: 'Main Street 1' });
  });

  it('does not save an emptied name of a person', async () => {
    const user = userEvent.setup();
    permissions.allowed.add('invoices:update');
    serve({ ...customer, kind: 'person', firstName: 'Jane', lastName: 'Doe', name: 'Jane Doe' });
    renderPanel();

    await screen.findByText('ap@acme.test');
    await user.click(screen.getByRole('button', { name: tc.firstName }));
    await user.keyboard('{Control>}a{/Control}{Backspace}{Enter}');

    expect(api.patch).not.toHaveBeenCalled();
  });

  it('keeps the fields read-only for a member who may archive contacts but not edit them', async () => {
    permissions.allowed.add('customers:update');
    serve(company);
    renderPanel();

    await screen.findByText('ap@acme.test');
    expect(screen.queryByRole('button', { name: tc.phone })).not.toBeInTheDocument();
  });

  it('only shows the details to a member who may not edit contacts', async () => {
    serve(company);
    renderPanel();

    await screen.findByText('ap@acme.test');
    expect(screen.queryByRole('button', { name: tc.phone })).not.toBeInTheDocument();
    expect(screen.queryByText(`Set ${tc.phone}…`)).not.toBeInTheDocument();
  });
});

describe('WeldBooks contact panel: details', () => {
  it('shows the contact record in the Details tab, with its name in the header', async () => {
    serve({
      ...customer,
      kind: 'company',
      companyName: 'Acme Corp',
      phone: '+31 20 123',
      iban: 'NL91ABNA0417164300',
      paymentTermsDays: 30,
      outstandingBalance: '125.50',
      notes: 'Pays late',
    });
    renderPanel();

    expect(await screen.findByText('ap@acme.test')).toBeInTheDocument();
    expect(screen.getAllByText('Acme Corp').length).toBeGreaterThan(0);
    expect(screen.getByText(tc.kinds.company)).toBeInTheDocument();
    expect(screen.getByText(tc.roles.customer)).toBeInTheDocument();
    expect(screen.getByText('+31 20 123')).toBeInTheDocument();
    expect(screen.getByText('NL91ABNA0417164300')).toBeInTheDocument();
    expect(screen.getByText('30')).toBeInTheDocument();
    expect(screen.getByText('$125.50')).toBeInTheDocument();
    expect(screen.getByText('Pays late')).toBeInTheDocument();
  });

  it('opens the WeldCRM company on top of the contact, so back returns to it', async () => {
    const user = userEvent.setup();
    serve({ ...customer, kind: 'company', companyId: 'cmp_9' });
    renderPanel();

    await openMenu(user);
    await user.click(await screen.findByRole('menuitem', { name: tc.openInCrm }));
    expect(panel.open).toHaveBeenCalledWith({ type: 'company', id: 'cmp_9', stack: true });
  });

  it('opens the contact person in WeldCRM on top of the contact', async () => {
    const user = userEvent.setup();
    serve({
      ...customer,
      kind: 'company',
      contactPerson: { personId: 'per_3', name: 'Jo Bloggs', firstName: 'Jo', lastName: 'Bloggs', email: 'jo@acme.test', phone: null },
    });
    renderPanel();

    expect(await screen.findByText('Jo Bloggs')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: tc.openInCrm }));
    expect(panel.open).toHaveBeenCalledWith({ type: 'person', id: 'per_3', stack: true });
  });

  it('links to the edit page', async () => {
    serve(customer);
    renderPanel();
    expect(await screen.findByRole('link', { name: tc.editContact })).toHaveAttribute(
      'href',
      '/weldbooks/customers/$id/edit',
    );
  });

  it('shows the audit trail of the contact in the History tab', async () => {
    const user = userEvent.setup();
    serve(customer);
    renderPanel();

    await user.click(await screen.findByRole('tab', { name: en.sweep.entities.auditLogTab }));
    expect(screen.getByTestId('audit-panel')).toHaveTextContent('accounting_contact:prt_1');
  });

  it('says so when the contact does not exist', async () => {
    api.get.mockRejectedValue(Object.assign(new Error('missing'), { status: 404 }));
    renderPanel();
    expect(await screen.findByText(en.sweep.entities.failedToLoad)).toBeInTheDocument();
  });
});

describe('WeldBooks contact panel: Exemptions tab', () => {
  it('adds an Exemptions tab for a customer of a US entity, next to the details', async () => {
    serve(customer);
    renderPanel();

    const tablist = await screen.findByRole('tablist');
    expect(within(tablist).getByRole('tab', { name: en.sweep.entities.detailsTab })).toBeInTheDocument();
    expect(await within(tablist).findByRole('tab', { name: tx.tabExemptions })).toBeInTheDocument();
    // The details are what opens first.
    expect(screen.getByText('ap@acme.test')).toBeInTheDocument();
  });

  it('shows the certificates, the add link and the default use on the tab', async () => {
    const user = userEvent.setup();
    serve(customer, [makeCertificate({ certificateNumber: '32-123' })]);
    renderPanel();

    await user.click(await screen.findByRole('tab', { name: tx.tabExemptions }));

    expect(await screen.findByRole('button', { name: '32-123' })).toBeInTheDocument();
    expect(screen.getByTestId('customer-default-use')).toHaveTextContent('Business');
    expect(screen.getByRole('link', { name: tx.add })).toHaveAttribute(
      'href',
      '/weldbooks/sales-tax/certificates/new?partyId=prt_1',
    );
  });

  it('has no Exemptions tab for a non-US entity, and never asks for certificates', async () => {
    jurisdiction.salesTax = false;
    serve(customer);
    renderPanel();

    expect(await screen.findByText('ap@acme.test')).toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: tx.tabExemptions })).not.toBeInTheDocument();
    expect(api.get.mock.calls.some(([path]) => String(path).startsWith('/exemption-certificates'))).toBe(false);
  });

  it('has no Exemptions tab for a vendor who is not also a customer', async () => {
    serve({ ...customer, role: 'supplier' });
    renderPanel();

    expect(await screen.findByText('ap@acme.test')).toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: tx.tabExemptions })).not.toBeInTheDocument();
  });

  it('keeps the tab for a contact who is both customer and vendor', async () => {
    serve({ ...customer, role: 'both' });
    renderPanel();
    expect(await screen.findByRole('tab', { name: tx.tabExemptions })).toBeInTheDocument();
  });
});

describe('WeldBooks contact panel: delete and archive', () => {
  const inUse = Object.assign(
    new Error("This contact can't be deleted because it is used by 2 invoices. Archive it instead to hide it from lists and pickers."),
    {
      status: 409,
      body: {
        error: {
          code: 'CONFLICT',
          message: 'in use',
          details: { code: 'CONTACT_IN_USE', references: { invoices: 2 }, canArchive: true },
        },
      },
    },
  );

  beforeEach(() => {
    api.post.mockReset().mockResolvedValue({ data: { ...customer, archivedAt: '2026-10-01T00:00:00Z' } });
    api.delete.mockReset();
    permissions.allowed = new Set(['customers:delete', 'customers:update']);
  });

  it('deletes after a confirmation and closes the panel', async () => {
    const user = userEvent.setup();
    serve(customer);
    api.delete.mockResolvedValueOnce({});
    renderPanel();

    await openMenu(user);
    await user.click(await screen.findByTestId('contact-delete'));
    expect(api.delete).not.toHaveBeenCalled();
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: tc.delete }));

    await vi.waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(api.delete).toHaveBeenCalledWith('/accounting-contacts/prt_1');
  });

  it('shows the reason a used contact can not be deleted and offers Archive instead', async () => {
    const user = userEvent.setup();
    serve(customer);
    api.delete.mockRejectedValueOnce(inUse);
    renderPanel();

    await openMenu(user);
    await user.click(await screen.findByTestId('contact-delete'));
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: tc.delete }));

    const blocked = await screen.findByText(tc.deleteBlockedTitle);
    const dialog = blocked.closest('[role="dialog"]') as HTMLElement;
    expect(dialog).toHaveTextContent('used by 2 invoices');
    expect(onClose).not.toHaveBeenCalled();

    await user.click(within(dialog).getByRole('button', { name: tc.archiveInstead }));
    expect(api.post).toHaveBeenCalledWith('/accounting-contacts/prt_1/archive');
  });

  it('archives after a confirmation and restores an archived contact in one click', async () => {
    const user = userEvent.setup();
    serve(customer);
    renderPanel();

    await openMenu(user);
    await user.click(await screen.findByTestId('contact-archive'));
    expect(api.post).not.toHaveBeenCalled();
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: tc.archive }));
    expect(api.post).toHaveBeenCalledWith('/accounting-contacts/prt_1/archive');
  });

  it('marks an archived contact and offers Restore', async () => {
    const user = userEvent.setup();
    serve({ ...customer, archivedAt: '2026-10-01T00:00:00Z' });
    renderPanel();

    expect(await screen.findByText(tc.archived)).toBeInTheDocument();
    await openMenu(user);
    await user.click(await screen.findByTestId('contact-archive'));
    expect(api.post).toHaveBeenCalledWith('/accounting-contacts/prt_1/unarchive');
  });

  it('hides delete and archive without the permissions', async () => {
    const user = userEvent.setup();
    permissions.allowed = new Set(['taxes:read']);
    serve(customer);
    renderPanel();

    expect(await screen.findByText('ap@acme.test')).toBeInTheDocument();
    await openMenu(user);
    expect(await screen.findByRole('menuitem', { name: en.sweep.entities.copyLink })).toBeInTheDocument();
    expect(screen.queryByTestId('contact-delete')).not.toBeInTheDocument();
    expect(screen.queryByTestId('contact-archive')).not.toBeInTheDocument();
  });
});

describe('WeldBooks contact panel: connected documents', () => {
  const cn = en.accounting.contacts.connected;
  const supplier = { ...customer, role: 'supplier' };
  const both = { ...customer, role: 'both' };
  const invoice = {
    id: 'inv_7',
    invoiceNumber: 'INV-0007',
    type: 'standard',
    status: 'sent',
    issueDate: '2026-10-01',
    total: '120.00',
    currency: 'USD',
  };
  const bill = {
    id: 'bill_3',
    billNumber: 'B-0003',
    type: 'bill',
    status: 'approved',
    issueDate: '2026-09-15',
    total: '80.00',
    currency: 'USD',
  };

  async function tabNames() {
    // The tabs depend on the contact's role: wait until it is loaded.
    await screen.findByText('ap@acme.test');
    const tablist = await screen.findByRole('tablist');
    return within(tablist)
      .getAllByRole('tab')
      .map((tab) => tab.textContent);
  }

  it('shows Invoices for a customer, and no Bills tab', async () => {
    jurisdiction.salesTax = false;
    serve(customer);
    renderPanel();
    expect(await tabNames()).toEqual([en.sweep.entities.detailsTab, cn.tabInvoices, en.sweep.entities.auditLogTab]);
  });

  it('shows Bills for a supplier, and no Invoices tab', async () => {
    serve(supplier);
    renderPanel();
    expect(await tabNames()).toEqual([en.sweep.entities.detailsTab, cn.tabBills, en.sweep.entities.auditLogTab]);
  });

  it('shows both for a contact that is a customer and a supplier', async () => {
    jurisdiction.salesTax = false;
    serve(both);
    renderPanel();
    expect(await tabNames()).toEqual([
      en.sweep.entities.detailsTab,
      cn.tabInvoices,
      cn.tabBills,
      en.sweep.entities.auditLogTab,
    ]);
  });

  it('keeps the History tab in the side panel, not only in fullscreen', async () => {
    const user = userEvent.setup();
    serve(customer);
    renderPanel('panel');

    await user.click(await screen.findByRole('tab', { name: en.sweep.entities.auditLogTab }));
    expect(screen.getByTestId('audit-panel')).toHaveTextContent('accounting_contact:prt_1');
  });

  it('lists the contact\'s invoices, asked by contact, and opens one as a stacked panel', async () => {
    const user = userEvent.setup();
    serve(customer, [], { invoices: [invoice] });
    renderPanel();

    await user.click(await screen.findByRole('tab', { name: cn.tabInvoices }));
    await user.click(await screen.findByRole('button', { name: 'INV-0007' }));

    expect(api.get).toHaveBeenCalledWith(expect.stringMatching(/^\/invoices\?.*contactId=prt_1/));
    expect(api.get).toHaveBeenCalledWith(expect.stringMatching(/^\/invoices\?.*pageSize=50/));
    expect(panel.open).toHaveBeenCalledWith({ type: 'invoice', id: 'inv_7', stack: true });
  });

  it('lists the contact\'s bills and opens one as a stacked panel', async () => {
    const user = userEvent.setup();
    serve(supplier, [], { bills: [bill] });
    renderPanel();

    await user.click(await screen.findByRole('tab', { name: cn.tabBills }));
    await user.click(await screen.findByRole('button', { name: 'B-0003' }));

    expect(api.get).toHaveBeenCalledWith(expect.stringMatching(/^\/bills\?.*contactId=prt_1/));
    expect(panel.open).toHaveBeenCalledWith({ type: 'bill', id: 'bill_3', stack: true });
  });

  it('says so when the contact has no invoices yet', async () => {
    const user = userEvent.setup();
    serve(customer);
    renderPanel();

    await user.click(await screen.findByRole('tab', { name: cn.tabInvoices }));
    expect(await screen.findByText(cn.noInvoices)).toBeInTheDocument();
  });

  it('shows what is to receive and overdue for a customer', async () => {
    serve(customer, [], {
      balance: {
        receivable: { totalOutstanding: '1200.00', totalOverdue: '300.00' },
        payable: { totalOutstanding: '0', totalOverdue: '0' },
      },
    });
    renderPanel();

    expect(await screen.findByText(cn.toReceive)).toBeInTheDocument();
    expect(await screen.findByText('$1200.00')).toBeInTheDocument();
    expect(screen.getByText(cn.overdue)).toBeInTheDocument();
    expect(screen.getByText('$300.00')).toBeInTheDocument();
    expect(screen.queryByText(cn.toPay)).not.toBeInTheDocument();
  });

  it('shows what is to pay for a supplier', async () => {
    serve(supplier, [], {
      balance: {
        receivable: { totalOutstanding: '0', totalOverdue: '0' },
        payable: { totalOutstanding: '80.00', totalOverdue: '0' },
      },
    });
    renderPanel();

    expect(await screen.findByText(cn.toPay)).toBeInTheDocument();
    expect(await screen.findByText('$80.00')).toBeInTheDocument();
    expect(screen.queryByText(cn.toReceive)).not.toBeInTheDocument();
  });

  it('starts a new invoice with this customer picked', async () => {
    permissions.allowed.add('invoices:create');
    serve(customer);
    renderPanel();

    expect(await screen.findByRole('link', { name: cn.newInvoice })).toHaveAttribute(
      'href',
      '/weldbooks/invoices/add?contactId=prt_1',
    );
    expect(screen.queryByRole('link', { name: cn.newBill })).not.toBeInTheDocument();
  });

  it('starts a new bill with this supplier picked', async () => {
    permissions.allowed.add('bills:create');
    serve(supplier);
    renderPanel();

    expect(await screen.findByRole('link', { name: cn.newBill })).toHaveAttribute(
      'href',
      '/weldbooks/bills/add?contactId=prt_1',
    );
  });

  it('offers no new invoice without the permission to create one', async () => {
    serve(customer);
    renderPanel();

    await screen.findByText('ap@acme.test');
    expect(screen.queryByRole('link', { name: cn.newInvoice })).not.toBeInTheDocument();
  });

  describe('unapplied credit', () => {
    const credit = {
      paymentId: 'pay_1',
      type: 'received',
      date: '2026-10-02',
      currency: 'USD',
      reference: 'Prepayment',
      amount: '100.00',
      unallocatedAmount: '40.00',
      bankTransactionId: 'bt_1',
    };
    const openInvoice = {
      id: 'inv_7',
      invoiceNumber: 'INV-0007',
      type: 'standard',
      status: 'sent',
      issueDate: '2026-10-01',
      total: '120.00',
      balanceDue: '90.00',
      currency: 'USD',
    };
    const paidInvoice = { ...openInvoice, id: 'inv_8', invoiceNumber: 'INV-0008', status: 'paid', balanceDue: '0.00' };

    async function openCreditTab(user: ReturnType<typeof userEvent.setup>) {
      await screen.findByText('ap@acme.test');
      await user.click(await screen.findByRole('tab', { name: en.weldbooksConnected.credit.tab }));
    }

    it('has no Credit tab, and never asks for credit, where the edition lacks bank processing', async () => {
      jurisdiction.salesTax = false;
      serve(customer, [], { credits: [credit] });
      renderPanel();
      await screen.findByText('ap@acme.test');
      expect(screen.queryByRole('tab', { name: en.weldbooksConnected.credit.tab })).not.toBeInTheDocument();
      expect(api.get.mock.calls.some(([path]) => String(path).endsWith('/credits'))).toBe(false);
    });

    it('has no Credit tab while the contact has no credit', async () => {
      edition.processing = true;
      jurisdiction.salesTax = false;
      serve(customer, [], { credits: [] });
      renderPanel();
      await screen.findByText('ap@acme.test');
      await vi.waitFor(() => expect(api.get.mock.calls.some(([path]) => String(path).endsWith('/credits'))).toBe(true));
      expect(screen.queryByRole('tab', { name: en.weldbooksConnected.credit.tab })).not.toBeInTheDocument();
    });

    it('shows a Credit tab with the credit that is left, and opens on it when asked for', async () => {
      edition.processing = true;
      jurisdiction.salesTax = false;
      serve(customer, [], { credits: [credit] });
      renderPanel('fullscreen', 'credit');
      const rows = await screen.findByTestId('credit-rows');
      expect(within(rows).getByText('Prepayment')).toBeInTheDocument();
      expect(within(rows).getByText(/\$40.00 left of \$100.00/)).toBeInTheDocument();
    });

    it('applies credit to an open invoice of the contact, by default the smaller of credit and balance', async () => {
      const user = userEvent.setup();
      edition.processing = true;
      jurisdiction.salesTax = false;
      permissions.allowed.add('banking:update');
      serve(customer, [], { credits: [credit], invoices: [openInvoice, paidInvoice] });
      api.post.mockResolvedValue({ data: { paymentId: 'pay_1', invoiceId: 'inv_7', amount: '40.00', unallocatedAmount: '0.00' } });
      renderPanel();
      await openCreditTab(user);

      await user.click(await screen.findByTestId('apply-credit-pay_1'));
      const dialog = await screen.findByTestId('apply-credit-dialog');
      // Nothing to apply until a document is picked.
      expect(within(dialog).getByTestId('apply-credit-submit')).toBeDisabled();
      await user.click(await within(dialog).findByRole('combobox', { name: 'Open document' }));
      // The paid invoice is not offered.
      expect(screen.queryByRole('option', { name: /INV-0008/ })).not.toBeInTheDocument();
      await user.click(await screen.findByRole('option', { name: /Invoice INV-0007/ }));
      expect(within(dialog).getByLabelText('Amount')).toHaveValue('40.00');

      await user.click(within(dialog).getByTestId('apply-credit-submit'));
      await vi.waitFor(() =>
        expect(api.post).toHaveBeenCalledWith('/payments/pay_1/apply', { invoiceId: 'inv_7', amount: '40.00' }),
      );
      expect(toast.success).toHaveBeenCalledWith('Credit applied');
    });

    it('will not apply more than the credit or the balance', async () => {
      const user = userEvent.setup();
      edition.processing = true;
      jurisdiction.salesTax = false;
      permissions.allowed.add('banking:update');
      serve(customer, [], { credits: [credit], invoices: [openInvoice] });
      renderPanel();
      await openCreditTab(user);
      await user.click(await screen.findByTestId('apply-credit-pay_1'));
      const dialog = await screen.findByTestId('apply-credit-dialog');
      await user.click(await within(dialog).findByRole('combobox', { name: 'Open document' }));
      await user.click(await screen.findByRole('option', { name: /Invoice INV-0007/ }));
      const amount = within(dialog).getByLabelText('Amount');
      await user.clear(amount);
      await user.type(amount, '50');
      expect(within(dialog).getByTestId('apply-credit-submit')).toBeDisabled();
      await user.clear(amount);
      await user.type(amount, '25.50');
      expect(within(dialog).getByTestId('apply-credit-submit')).toBeEnabled();
    });

    it('says so when the contact has nothing open to apply credit to', async () => {
      const user = userEvent.setup();
      edition.processing = true;
      jurisdiction.salesTax = false;
      permissions.allowed.add('banking:update');
      serve(customer, [], { credits: [credit], invoices: [] });
      renderPanel();
      await openCreditTab(user);
      await user.click(await screen.findByTestId('apply-credit-pay_1'));
      expect(await screen.findByTestId('no-open-documents')).toBeInTheDocument();
    });

    it('offers no Apply without banking:update', async () => {
      const user = userEvent.setup();
      edition.processing = true;
      jurisdiction.salesTax = false;
      serve(customer, [], { credits: [credit] });
      renderPanel();
      await openCreditTab(user);
      await screen.findByTestId('credit-rows');
      expect(screen.queryByTestId('apply-credit-pay_1')).not.toBeInTheDocument();
    });
  });
});
