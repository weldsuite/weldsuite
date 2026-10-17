import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { en } from '@weldsuite/i18n/locales/en';

const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), patch: vi.fn(), put: vi.fn(), delete: vi.fn() }));
vi.mock('@/lib/api/weldbooks-client', () => ({ weldbooksApi: api, setWeldbooksEntityId: vi.fn() }));
vi.mock('@/components/object-panel', () => import('@/components/objects/_shared/object-panel-test-mock'));
vi.mock('@tanstack/react-router', () => ({
  Link: ({ to, params, children }: { to: string; params?: Record<string, string>; children: React.ReactNode }) => (
    <a href={params ? Object.entries(params).reduce((acc, [key, value]) => acc.replace(`$${key}`, value), to) : to}>{children}</a>
  ),
}));
const permissions = vi.hoisted(() => ({ allowed: new Set<string>() }));
vi.mock('@weldsuite/permissions/react', () => ({
  usePermissions: () => ({ can: (permission: string) => permissions.allowed.has(permission) }),
}));
const jurisdiction = vi.hoisted(() => ({ salesTax: true }));
vi.mock('@/lib/weldbooks/use-jurisdiction', () => ({
  useCurrentJurisdiction: () => ({ features: { salesTax: jurisdiction.salesTax }, isResolved: true, isError: false }),
}));
vi.mock('@/lib/weldbooks/use-weldbooks-format', () => ({
  useWeldbooksFormat: () => ({
    formatDate: (value: string | null | undefined, empty = '') => (value ? `date:${value}` : empty),
    formatMoney: (value: string) => `$${value}`,
    today: () => '2026-10-08',
  }),
}));
const upload = vi.hoisted(() => ({ uploadFile: vi.fn() }));
vi.mock('@/hooks/use-file-upload', () => ({ useFileUpload: () => upload }));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), info: vi.fn() }));
vi.mock('sonner', () => ({ toast }));
vi.mock('@/hooks/use-workspace-url', () => ({ useWorkspaceUrl: () => (path: string) => `https://app.test${path}` }));
vi.mock('@/components/entity-audit-panel', () => ({
  EntityAuditPanel: ({ entityType, entityId }: { entityType: string; entityId: string }) => (
    <div data-testid="audit-panel">{`${entityType}:${entityId}`}</div>
  ),
}));

import { TaxExemptionCertificatePanel } from './tax-exemption-certificate-panel';
import { installPointerPolyfills, makeCertificate, renderWithProviders } from '@/app/weldbooks/sales-tax/setup/test-support';

const setup = en.weldbooksUs.salesTax.setup;
const td = setup.certificates.detail;

function serve(certificate: unknown) {
  api.get.mockImplementation(async (path: string) => {
    if (path === '/exemption-certificates/exc_1') {
      if (certificate === null) throw Object.assign(new Error('not found'), { status: 404 });
      return { data: certificate };
    }
    if (path === '/accounting-contacts/prt_1') return { data: { id: 'prt_1', name: 'Acme Corp', role: 'customer' } };
    if (path.startsWith('/accounting-documents/')) return { data: { id: 'doc_1', fileName: 'resale-2026.pdf' } };
    if (path.startsWith('/invoices/')) return { data: { id: 'inv_1', invoiceNumber: 'INV-0042' } };
    return { data: [] };
  });
}

function renderPanel(onClose = vi.fn()) {
  renderWithProviders(
    <TaxExemptionCertificatePanel id="exc_1" isOpen onClose={onClose} mode="fullscreen" onModeChange={vi.fn()} />,
  );
  return onClose;
}

async function openMenu(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole('button', { name: setup.jurisdictions.columns.actions }));
}

beforeAll(installPointerPolyfills);

beforeEach(() => {
  api.get.mockReset();
  api.patch.mockReset();
  api.delete.mockReset();
  toast.success.mockReset();
  toast.error.mockReset();
  jurisdiction.salesTax = true;
  permissions.allowed = new Set(['taxes:read', 'taxes:create', 'taxes:update', 'taxes:delete']);
  api.patch.mockResolvedValue({ data: makeCertificate() });
});

describe('TaxExemptionCertificatePanel', () => {
  it('shows the certificate: customer, reason, form, number, dates, last use and the scan', async () => {
    serve(makeCertificate({ documentId: 'doc_1', lastUsedOn: '2026-09-15', notes: 'Original in the filing cabinet' }));
    renderPanel();

    // The customer is named in the header and in the Details tab.
    expect((await screen.findAllByText('Acme Corp')).length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText('Valid', { selector: 'span.rounded' })).toBeInTheDocument();
    expect(screen.getByText('State-specific form')).toBeInTheDocument();
    expect(screen.getByText('Resale')).toBeInTheDocument();
    expect(screen.getByText('32-123')).toBeInTheDocument();
    expect(screen.getByText('Blanket')).toBeInTheDocument();
    expect(screen.getByText('date:2026-01-15')).toBeInTheDocument();
    expect(screen.getByText('date:2026-09-15')).toBeInTheDocument();
    expect(await screen.findByText('resale-2026.pdf')).toBeInTheDocument();
    expect(screen.getByText('Original in the filing cabinet')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Acme Corp' })).toHaveAttribute('href', '/weldbooks/customers/prt_1');
  });

  it('shows the last valid day per state and which states have lapsed', async () => {
    const user = userEvent.setup();
    serve(
      makeCertificate({
        states: ['FL', 'TX', 'WA'],
        expiresOn: null,
        expiryByState: { FL: '2026-12-31', TX: null, WA: '2026-06-30' },
        expiredStates: ['WA'],
        effectiveExpiresOn: null,
        daysUntilExpiry: null,
      }),
    );
    renderPanel();
    await user.click(await screen.findByRole('tab', { name: new RegExp(td.statesTitle) }));

    const florida = screen.getByText('Florida (FL)').closest('div.group') as HTMLElement;
    expect(within(florida).getByText('date:2026-12-31')).toBeInTheDocument();
    expect(within(florida).getByText(td.stateValid)).toBeInTheDocument();
    const texas = screen.getByText('Texas (TX)').closest('div.group') as HTMLElement;
    expect(within(texas).getByText(setup.certificates.expiry.noneInState)).toBeInTheDocument();
    const washington = screen.getByText('Washington (WA)').closest('div.group') as HTMLElement;
    expect(within(washington).getByText('date:2026-06-30')).toBeInTheDocument();
    expect(within(washington).getByText(td.stateExpired)).toBeInTheDocument();
  });

  it('names the invoice of a single-purchase certificate and links to it', async () => {
    serve(makeCertificate({ blanket: false, invoiceId: 'inv_1' }));
    renderPanel();

    const link = await screen.findByRole('link', { name: 'INV-0042' });
    expect(link).toHaveAttribute('href', '/weldbooks/invoices/inv_1');
    expect(screen.getByText('Single purchase')).toBeInTheDocument();
  });

  it('shows the audit log of the certificate in the History tab', async () => {
    const user = userEvent.setup();
    serve(makeCertificate());
    renderPanel();
    await user.click(await screen.findByRole('tab', { name: 'Audit Log' }));
    expect(screen.getByTestId('audit-panel')).toHaveTextContent('exemption_certificate:exc_1');
  });

  it('revokes a certificate only after a confirmation that says what it means', async () => {
    const user = userEvent.setup();
    serve(makeCertificate());
    renderPanel();

    await openMenu(user);
    await user.click(await screen.findByRole('menuitem', { name: td.revoke }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent(td.revokeDialog.description);
    expect(api.patch).not.toHaveBeenCalled();
    await user.click(within(dialog).getByRole('button', { name: td.revokeDialog.confirm }));

    await waitFor(() => expect(api.patch).toHaveBeenCalledWith('/exemption-certificates/exc_1', { status: 'revoked' }));
    expect(toast.success).toHaveBeenCalledWith(td.revoked);
  });

  it('restores a revoked certificate in one click', async () => {
    const user = userEvent.setup();
    serve(makeCertificate({ status: 'revoked', storedStatus: 'revoked' }));
    renderPanel();

    await openMenu(user);
    expect(screen.queryByRole('menuitem', { name: td.revoke })).not.toBeInTheDocument();
    await user.click(await screen.findByRole('menuitem', { name: td.restore }));

    await waitFor(() => expect(api.patch).toHaveBeenCalledWith('/exemption-certificates/exc_1', { status: 'valid' }));
    expect(toast.success).toHaveBeenCalledWith(td.restored);
  });

  it('deletes a certificate after a confirmation and closes the panel', async () => {
    const user = userEvent.setup();
    api.delete.mockResolvedValue(undefined);
    serve(makeCertificate());
    const onClose = renderPanel();

    await openMenu(user);
    await user.click(await screen.findByRole('menuitem', { name: 'Delete' }));
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: td.deleteDialog.confirm }));

    await waitFor(() => expect(api.delete).toHaveBeenCalledWith('/exemption-certificates/exc_1'));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(toast.success).toHaveBeenCalledWith(td.deleted);
  });

  it('keeps the panel open and says why when the delete fails', async () => {
    const user = userEvent.setup();
    api.delete.mockRejectedValue(new Error('Still in use'));
    serve(makeCertificate());
    const onClose = renderPanel();

    await openMenu(user);
    await user.click(await screen.findByRole('menuitem', { name: 'Delete' }));
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: td.deleteDialog.confirm }));

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Still in use'));
    expect(onClose).not.toHaveBeenCalled();
  });

  it('edits in a dialog: the form starts from what is recorded, the customer cannot change, and the update has no customer', async () => {
    const user = userEvent.setup();
    serve(makeCertificate({ certificateNumber: '32-123', expiresOn: '2027-01-14' }));
    renderPanel();

    await user.click(await screen.findByRole('button', { name: 'Edit' }));

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByRole('heading', { name: setup.certificates.form.editTitle })).toBeInTheDocument();
    expect(within(dialog).getByRole('combobox', { name: setup.certificates.form.customer })).toBeDisabled();
    expect(within(dialog).getByLabelText(setup.certificates.form.number)).toHaveValue('32-123');
    expect(within(dialog).getByLabelText(setup.certificates.form.expiresOn)).toHaveValue('2027-01-14');

    await user.clear(within(dialog).getByLabelText(setup.certificates.form.number));
    await user.type(within(dialog).getByLabelText(setup.certificates.form.number), '99-001');
    await user.click(within(dialog).getByRole('button', { name: setup.certificates.form.submitUpdate }));

    await waitFor(() => expect(api.patch).toHaveBeenCalledTimes(1));
    const [path, body] = api.patch.mock.calls[0] as [string, Record<string, unknown>];
    expect(path).toBe('/exemption-certificates/exc_1');
    expect(body).toMatchObject({ certificateNumber: '99-001', states: ['TX', 'OK'], expiresOn: '2027-01-14', blanket: true });
    expect(body).not.toHaveProperty('partyId');
    // Back on the certificate afterwards.
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(toast.success).toHaveBeenCalledWith(td.saved);
  });

  it('offers only what the permissions allow', async () => {
    const user = userEvent.setup();
    permissions.allowed = new Set(['taxes:read']);
    serve(makeCertificate());
    renderPanel();

    await screen.findAllByText('Acme Corp');
    expect(screen.queryByRole('button', { name: 'Edit' })).not.toBeInTheDocument();
    await openMenu(user);
    expect(await screen.findByRole('menuitem', { name: 'Copy link' })).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: td.revoke })).not.toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: 'Delete' })).not.toBeInTheDocument();
  });

  it('says when the certificate does not exist', async () => {
    serve(null);
    renderPanel();
    expect(await screen.findByText(td.notFound)).toBeInTheDocument();
  });

  it('shows nothing of the certificate for an entity that is not a US one', async () => {
    jurisdiction.salesTax = false;
    serve(makeCertificate());
    renderPanel();
    expect(await screen.findByText(setup.common.usOnly)).toBeInTheDocument();
    expect(api.get).not.toHaveBeenCalled();
  });

  it('shows nothing of the certificate to a member who cannot read taxes', async () => {
    permissions.allowed = new Set();
    serve(makeCertificate());
    renderPanel();
    expect(await screen.findByText(setup.common.noAccess)).toBeInTheDocument();
    expect(api.get).not.toHaveBeenCalled();
  });
});
