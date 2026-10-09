import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { en } from '@weldsuite/i18n/locales/en';

const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), patch: vi.fn(), put: vi.fn(), delete: vi.fn() }));
vi.mock('@/lib/api/weldbooks-client', () => ({ weldbooksApi: api, setWeldbooksEntityId: vi.fn() }));
const navigate = vi.hoisted(() => vi.fn());
vi.mock('@tanstack/react-router', () => ({
  Link: ({ to, params, children }: { to: string; params?: Record<string, string>; children: React.ReactNode }) => (
    <a href={params ? Object.entries(params).reduce((acc, [key, value]) => acc.replace(`$${key}`, value), to) : to}>{children}</a>
  ),
  useNavigate: () => navigate,
  useParams: () => ({ id: 'exc_1' }),
}));
const permissions = vi.hoisted(() => ({ allowed: new Set<string>() }));
vi.mock('@weldsuite/permissions/react', () => ({
  usePermissions: () => ({ can: (permission: string) => permissions.allowed.has(permission) }),
}));
vi.mock('@/lib/weldbooks/use-jurisdiction', () => ({
  useCurrentJurisdiction: () => ({ features: { salesTax: true }, isResolved: true, isError: false }),
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

import ExemptionCertificateDetailPage from './page';
import { installPointerPolyfills, makeCertificate, renderWithProviders } from '../../setup/test-support';

const setup = en.weldbooksUs.salesTax.setup;
const td = setup.certificates.detail;

function serve(certificate: unknown, extra: Record<string, unknown> = {}) {
  api.get.mockImplementation(async (path: string) => {
    if (path === '/exemption-certificates/exc_1') {
      if (certificate === null) throw Object.assign(new Error('not found'), { status: 404 });
      return { data: certificate };
    }
    if (path === '/accounting-contacts/prt_1') return { data: { id: 'prt_1', name: 'Acme Corp', role: 'customer' } };
    if (path.startsWith('/accounting-documents/')) return { data: { id: 'doc_1', fileName: 'resale-2026.pdf' } };
    if (path.startsWith('/invoices/')) return { data: { id: 'inv_1', invoiceNumber: 'INV-0042' } };
    if (path in extra) return extra[path];
    return { data: [] };
  });
}

beforeAll(installPointerPolyfills);

beforeEach(() => {
  api.get.mockReset();
  api.patch.mockReset();
  api.delete.mockReset();
  navigate.mockReset();
  toast.success.mockReset();
  toast.error.mockReset();
  permissions.allowed = new Set(['taxes:read', 'taxes:create', 'taxes:update', 'taxes:delete']);
  api.patch.mockResolvedValue({ data: makeCertificate() });
});

describe('ExemptionCertificateDetailPage', () => {
  it('shows the certificate: customer, reason, form, number, dates, last use and the scan', async () => {
    serve(makeCertificate({ documentId: 'doc_1', lastUsedOn: '2026-09-15', notes: 'Original in the filing cabinet' }));
    renderWithProviders(<ExemptionCertificateDetailPage />);

    expect(await screen.findByRole('heading', { name: 'Acme Corp' })).toBeInTheDocument();
    expect(screen.getByText('Valid', { selector: '[data-slot="badge"]' })).toBeInTheDocument();
    expect(screen.getByText('State-specific form')).toBeInTheDocument();
    expect(screen.getAllByText('32-123').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('Blanket')).toBeInTheDocument();
    expect(screen.getByText('date:2026-01-15')).toBeInTheDocument();
    expect(screen.getByText('date:2026-09-15')).toBeInTheDocument();
    expect(await screen.findByText('resale-2026.pdf')).toBeInTheDocument();
    expect(screen.getByText('Original in the filing cabinet')).toBeInTheDocument();
  });

  it('shows the last valid day per state and which states have lapsed', async () => {
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
    renderWithProviders(<ExemptionCertificateDetailPage />);

    await screen.findByRole('heading', { name: 'Acme Corp' });
    const rows = screen.getAllByRole('row').filter((row) => /\((FL|TX|WA)\)/.test(row.textContent ?? ''));
    expect(rows).toHaveLength(3);
    expect(within(rows[0]).getByText('date:2026-12-31')).toBeInTheDocument();
    expect(within(rows[0]).getByText(td.stateValid)).toBeInTheDocument();
    expect(within(rows[1]).getByText(setup.certificates.expiry.noneInState)).toBeInTheDocument();
    expect(within(rows[2]).getByText('date:2026-06-30')).toBeInTheDocument();
    expect(within(rows[2]).getByText(td.stateExpired)).toBeInTheDocument();
  });

  it('names the invoice of a single-purchase certificate and links to it', async () => {
    serve(makeCertificate({ blanket: false, invoiceId: 'inv_1' }));
    renderWithProviders(<ExemptionCertificateDetailPage />);

    const link = await screen.findByRole('link', { name: 'INV-0042' });
    expect(link).toHaveAttribute('href', '/weldbooks/invoices/inv_1');
    expect(screen.getByText('Single purchase')).toBeInTheDocument();
  });

  it('revokes a certificate only after a confirmation that says what it means', async () => {
    const user = userEvent.setup();
    serve(makeCertificate());
    renderWithProviders(<ExemptionCertificateDetailPage />);

    await user.click(await screen.findByRole('button', { name: td.revoke }));
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
    renderWithProviders(<ExemptionCertificateDetailPage />);

    expect(screen.queryByRole('button', { name: td.revoke })).not.toBeInTheDocument();
    await user.click(await screen.findByRole('button', { name: td.restore }));

    await waitFor(() => expect(api.patch).toHaveBeenCalledWith('/exemption-certificates/exc_1', { status: 'valid' }));
    expect(toast.success).toHaveBeenCalledWith(td.restored);
  });

  it('deletes a certificate after a confirmation and goes back to the list', async () => {
    const user = userEvent.setup();
    api.delete.mockResolvedValue(undefined);
    serve(makeCertificate());
    renderWithProviders(<ExemptionCertificateDetailPage />);

    await user.click(await screen.findByRole('button', { name: 'Delete' }));
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: td.deleteDialog.confirm }));

    await waitFor(() => expect(api.delete).toHaveBeenCalledWith('/exemption-certificates/exc_1'));
    await waitFor(() => expect(navigate).toHaveBeenCalledWith({ to: '/weldbooks/sales-tax/certificates' }));
    expect(toast.success).toHaveBeenCalledWith(td.deleted);
  });

  it('edits in place: the form starts from what is recorded, the customer cannot change, and the update has no customer', async () => {
    const user = userEvent.setup();
    serve(makeCertificate({ certificateNumber: '32-123', expiresOn: '2027-01-14' }));
    renderWithProviders(<ExemptionCertificateDetailPage />);

    await user.click(await screen.findByRole('button', { name: 'Edit' }));

    expect(await screen.findByRole('heading', { name: setup.certificates.form.editTitle })).toBeInTheDocument();
    const customer = screen.getByRole('combobox', { name: setup.certificates.form.customer });
    expect(customer).toBeDisabled();
    expect(screen.getByLabelText(setup.certificates.form.number)).toHaveValue('32-123');
    expect(screen.getByLabelText(setup.certificates.form.expiresOn)).toHaveValue('2027-01-14');

    await user.clear(screen.getByLabelText(setup.certificates.form.number));
    await user.type(screen.getByLabelText(setup.certificates.form.number), '99-001');
    await user.click(screen.getByRole('button', { name: setup.certificates.form.submitUpdate }));

    await waitFor(() => expect(api.patch).toHaveBeenCalledTimes(1));
    const [path, body] = api.patch.mock.calls[0] as [string, Record<string, unknown>];
    expect(path).toBe('/exemption-certificates/exc_1');
    expect(body).toMatchObject({ certificateNumber: '99-001', states: ['TX', 'OK'], expiresOn: '2027-01-14', blanket: true });
    expect(body).not.toHaveProperty('partyId');
    // Back on the certificate afterwards.
    expect(await screen.findByRole('button', { name: 'Edit' })).toBeInTheDocument();
    expect(toast.success).toHaveBeenCalledWith(td.saved);
  });

  it('offers only what the permissions allow', async () => {
    permissions.allowed = new Set(['taxes:read']);
    serve(makeCertificate());
    renderWithProviders(<ExemptionCertificateDetailPage />);

    await screen.findByRole('heading', { name: 'Acme Corp' });
    expect(screen.queryByRole('button', { name: 'Edit' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: td.revoke })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Delete' })).not.toBeInTheDocument();
  });

  it('says when the certificate does not exist', async () => {
    serve(null);
    renderWithProviders(<ExemptionCertificateDetailPage />);
    expect(await screen.findByText(td.notFound)).toBeInTheDocument();
  });
});
