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

function serve(contact: Record<string, unknown>, certificates: unknown[] = []) {
  api.get.mockImplementation(async (path: string) => {
    if (path.startsWith('/exemption-certificates')) return { data: certificates };
    if (path.startsWith('/accounting-contacts/')) return { data: contact };
    return { data: [] };
  });
}

const customer = { id: 'prt_1', name: 'Acme Corp', role: 'customer', email: 'ap@acme.test', taxUse: 'business' };

const onClose = vi.fn();

function renderPanel() {
  return renderWithProviders(
    <WeldbooksContactPanel id="prt_1" isOpen onClose={onClose} mode="fullscreen" onModeChange={vi.fn()} />,
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
  permissions.allowed = new Set(['taxes:read', 'taxes:create']);
});

describe('WeldBooks contact panel: editing the details in place', () => {
  const company = { ...customer, kind: 'company', companyName: 'Acme Corp' };

  beforeEach(() => {
    api.patch.mockReset().mockResolvedValue({ data: {} });
  });

  it('fills in an empty field and saves just that field', async () => {
    const user = userEvent.setup();
    permissions.allowed.add('customers:update');
    serve(company);
    renderPanel();

    await screen.findByText('ap@acme.test');
    await user.click(screen.getByRole('button', { name: tc.phone }));
    await user.keyboard('+31 20 999{Enter}');

    expect(api.patch).toHaveBeenCalledWith('/accounting-contacts/prt_1', { phone: '+31 20 999' });
  });

  it('keeps the name on invoices in step with a renamed company', async () => {
    const user = userEvent.setup();
    permissions.allowed.add('customers:update');
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
