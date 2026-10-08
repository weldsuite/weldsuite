import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { en } from '@weldsuite/i18n/locales/en';

const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), patch: vi.fn(), put: vi.fn(), delete: vi.fn() }));
vi.mock('@/lib/api/weldbooks-client', () => ({ weldbooksApi: api, setWeldbooksEntityId: vi.fn() }));
const navigate = vi.hoisted(() => vi.fn());
const search = vi.hoisted(() => ({ current: { partyId: 'prt_1' } as { partyId?: string } }));
vi.mock('@tanstack/react-router', () => ({
  Link: ({ to, children }: { to: string; children: React.ReactNode }) => <a href={to}>{children}</a>,
  useNavigate: () => navigate,
  useSearch: () => search.current,
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
    formatDate: (value: string | null | undefined) => `date:${value ?? ''}`,
    formatMoney: (value: string) => `$${value}`,
    today: () => '2026-10-08',
  }),
}));
const upload = vi.hoisted(() => ({ uploadFile: vi.fn() }));
vi.mock('@/hooks/use-file-upload', () => ({ useFileUpload: () => upload }));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), info: vi.fn() }));
vi.mock('sonner', () => ({ toast }));

import NewExemptionCertificatePage from './page';
import { installPointerPolyfills, makeCertificate, renderWithProviders } from '../../setup/test-support';

const setup = en.weldbooksUs.salesTax.setup;
const tf = setup.certificates.form;

function routes() {
  api.get.mockImplementation(async (path: string) => {
    if (path === '/accounting-contacts/prt_1') return { data: { id: 'prt_1', name: 'Acme Corp', role: 'customer' } };
    if (path.startsWith('/accounting-contacts')) return { data: [{ id: 'prt_1', name: 'Acme Corp', email: 'ap@acme.test' }] };
    if (path.startsWith('/invoices')) {
      return { data: [{ id: 'inv_1', invoiceNumber: 'INV-0001', issueDate: '2026-09-01', total: '120.00' }] };
    }
    if (path === '/accounting-documents/doc_1') return { data: { id: 'doc_1', fileName: 'resale.pdf' } };
    return { data: [] };
  });
  api.post.mockImplementation(async (path: string) => {
    if (path === '/accounting-documents') return { data: { id: 'doc_1' } };
    return { data: makeCertificate({ id: 'exc_9' }) };
  });
}

/** Pick states in the multi-select and close it again. */
async function pickStates(user: ReturnType<typeof userEvent.setup>, ...names: string[]) {
  await user.click(screen.getByRole('combobox', { name: tf.states }));
  for (const name of names) await user.click(await screen.findByRole('option', { name: new RegExp(name) }));
  await user.keyboard('{Escape}');
}

beforeAll(installPointerPolyfills);

beforeEach(() => {
  api.get.mockReset();
  api.post.mockReset();
  navigate.mockReset();
  toast.success.mockReset();
  upload.uploadFile.mockReset();
  permissions.allowed = new Set(['taxes:read', 'taxes:create']);
  search.current = { partyId: 'prt_1' };
  routes();
});

describe('NewExemptionCertificatePage', () => {
  it('has the customer from the link selected', async () => {
    renderWithProviders(<NewExemptionCertificatePage />);
    const picker = await screen.findByRole('combobox', { name: tf.customer });
    await waitFor(() => expect(picker).toHaveTextContent('Acme Corp'));
  });

  it('is closed to a member who cannot create', () => {
    permissions.allowed = new Set(['taxes:read']);
    renderWithProviders(<NewExemptionCertificatePage />);
    expect(screen.getByText(setup.common.noAccess)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: tf.submitCreate })).not.toBeInTheDocument();
  });

  it('needs a customer and a state before it saves anything', async () => {
    const user = userEvent.setup();
    search.current = {};
    renderWithProviders(<NewExemptionCertificatePage />);

    await user.click(await screen.findByRole('button', { name: tf.submitCreate }));

    expect(await screen.findByText(setup.validation.customer)).toBeInTheDocument();
    expect(screen.getByText(setup.validation.statesRequired)).toBeInTheDocument();
    expect(api.post).not.toHaveBeenCalled();
  });

  it('saves a blanket resale certificate with its states and number, then opens it', async () => {
    const user = userEvent.setup();
    renderWithProviders(<NewExemptionCertificatePage />);
    await screen.findByRole('combobox', { name: tf.customer });

    await pickStates(user, 'Texas', 'Oklahoma');
    await user.type(screen.getByLabelText(tf.number), '32-123');
    await user.click(screen.getByRole('button', { name: tf.submitCreate }));

    await waitFor(() => expect(api.post).toHaveBeenCalledTimes(1));
    expect(api.post).toHaveBeenCalledWith('/exemption-certificates', {
      partyId: 'prt_1',
      states: ['TX', 'OK'],
      reason: 'resale',
      form: 'state_form',
      blanket: true,
      status: 'valid',
      certificateNumber: '32-123',
      receivedOn: '2026-10-08',
    });
    await waitFor(() =>
      expect(navigate).toHaveBeenCalledWith({ to: '/weldbooks/sales-tax/certificates/$id', params: { id: 'exc_9' } }),
    );
    expect(toast.success).toHaveBeenCalledWith(setup.certificates.detail.created);
  });

  it('wants the invoice a single-purchase certificate covers, and sends it', async () => {
    const user = userEvent.setup();
    renderWithProviders(<NewExemptionCertificatePage />);
    await screen.findByRole('combobox', { name: tf.customer });

    await pickStates(user, 'Texas');
    await user.click(screen.getByRole('radio', { name: tf.single }));
    await user.click(screen.getByRole('button', { name: tf.submitCreate }));
    expect(await screen.findByText(setup.validation.invoice)).toBeInTheDocument();
    expect(api.post).not.toHaveBeenCalled();

    await user.click(screen.getByRole('combobox', { name: tf.invoice }));
    await user.click(await screen.findByRole('option', { name: /INV-0001/ }));
    await user.click(screen.getByRole('button', { name: tf.submitCreate }));

    await waitFor(() => expect(api.post).toHaveBeenCalledTimes(1));
    expect(api.post.mock.calls[0][1]).toMatchObject({ blanket: false, invoiceId: 'inv_1', states: ['TX'] });
  });

  it('explains the state rule that decides validity when there is no expiry date', async () => {
    const user = userEvent.setup();
    renderWithProviders(<NewExemptionCertificatePage />);
    await screen.findByRole('combobox', { name: tf.customer });

    await pickStates(user, 'Florida');
    expect(screen.getByTestId('rule-hints')).toHaveTextContent('Florida: without an expiry date, a resale certificate is valid until 31 December');

    await user.type(screen.getByLabelText(tf.expiresOn), '2027-06-30');
    expect(screen.queryByTestId('rule-hints')).not.toBeInTheDocument();
  });

  it('refuses an expiry date before the issue date', async () => {
    const user = userEvent.setup();
    renderWithProviders(<NewExemptionCertificatePage />);
    await screen.findByRole('combobox', { name: tf.customer });

    await pickStates(user, 'Texas');
    await user.type(screen.getByLabelText(tf.issuedOn), '2026-06-01');
    await user.type(screen.getByLabelText(tf.expiresOn), '2026-05-31');
    await user.click(screen.getByRole('button', { name: tf.submitCreate }));

    expect(await screen.findByText(setup.validation.endBeforeStart)).toBeInTheDocument();
    expect(api.post).not.toHaveBeenCalled();
  });

  it('files the scan as a tax form and sends its document id with the certificate', async () => {
    const user = userEvent.setup();
    upload.uploadFile.mockResolvedValue({ fileName: 'resale.pdf', fileKey: 'k/resale.pdf', mimeType: 'application/pdf', fileSize: 1024 });
    renderWithProviders(<NewExemptionCertificatePage />);
    await screen.findByRole('combobox', { name: tf.customer });

    await user.upload(screen.getByLabelText(tf.scan.label), new File(['%PDF'], 'resale.pdf', { type: 'application/pdf' }));

    expect(await screen.findByTestId('certificate-scan-status')).toHaveTextContent('resale.pdf');
    expect(api.post).toHaveBeenCalledWith('/accounting-documents', {
      type: 'tax_form',
      fileName: 'resale.pdf',
      fileKey: 'k/resale.pdf',
      mimeType: 'application/pdf',
      fileSize: 1024,
      source: 'upload',
    });

    await pickStates(user, 'Texas');
    await user.click(screen.getByRole('button', { name: tf.submitCreate }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/exemption-certificates', expect.objectContaining({ documentId: 'doc_1' })));
  });

  it('refuses a scan that is not a PDF or an image', async () => {
    const user = userEvent.setup({ applyAccept: false });
    renderWithProviders(<NewExemptionCertificatePage />);
    await screen.findByRole('combobox', { name: tf.customer });

    await user.upload(screen.getByLabelText(tf.scan.label), new File(['hello'], 'notes.txt', { type: 'text/plain' }));

    expect(await screen.findByText(tf.scan.problems.type)).toBeInTheDocument();
    expect(upload.uploadFile).not.toHaveBeenCalled();
    expect(screen.queryByTestId('certificate-scan-status')).not.toBeInTheDocument();
  });

  it('shows the server sentence when the certificate is refused, and stays on the form', async () => {
    const user = userEvent.setup();
    api.post.mockRejectedValue(new Error('Customer prt_1 not found'));
    renderWithProviders(<NewExemptionCertificatePage />);
    await screen.findByRole('combobox', { name: tf.customer });

    await pickStates(user, 'Texas');
    await user.click(screen.getByRole('button', { name: tf.submitCreate }));

    const alert = await screen.findByText('Customer prt_1 not found');
    expect(within(alert.closest('[role="alert"]') as HTMLElement).getByText('Customer prt_1 not found')).toBeInTheDocument();
    expect(navigate).not.toHaveBeenCalled();
  });
});
