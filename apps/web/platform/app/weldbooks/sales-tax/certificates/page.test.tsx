import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { en } from '@weldsuite/i18n/locales/en';

const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), patch: vi.fn(), put: vi.fn(), delete: vi.fn() }));
vi.mock('@/lib/api/weldbooks-client', () => ({ weldbooksApi: api, setWeldbooksEntityId: vi.fn() }));
const navigate = vi.hoisted(() => vi.fn());
vi.mock('@tanstack/react-router', () => ({
  Link: ({ to, children }: { to: string; children: React.ReactNode }) => <a href={to}>{children}</a>,
  useNavigate: () => navigate,
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

import ExemptionCertificatesPage from './page';
import { installPointerPolyfills, makeCertificate, renderWithProviders } from '../setup/test-support';

const tc = en.weldbooksUs.salesTax.setup.certificates;

function serve(certificates: unknown[]) {
  api.get.mockImplementation(async (path: string) => {
    if (path === '/accounting-contacts/prt_1') return { data: { id: 'prt_1', name: 'Acme Corp' } };
    if (path === '/accounting-contacts/prt_2') return { data: { id: 'prt_2', name: 'Bolt Inc' } };
    if (path.startsWith('/accounting-contacts')) {
      return { data: [{ id: 'prt_1', name: 'Acme Corp' }, { id: 'prt_2', name: 'Bolt Inc' }] };
    }
    if (path.startsWith('/exemption-certificates')) return { data: certificates };
    return { data: [] };
  });
}

const certificatePaths = () => api.get.mock.calls.map(([path]) => String(path)).filter((p) => p.startsWith('/exemption-certificates'));

beforeAll(installPointerPolyfills);

beforeEach(() => {
  api.get.mockReset();
  navigate.mockReset();
  permissions.allowed = new Set(['taxes:read', 'taxes:create']);
});

describe('ExemptionCertificatesPage', () => {
  it('lists the certificates of every customer with their names, states, expiry and status', async () => {
    serve([
      makeCertificate({ id: 'exc_1', partyId: 'prt_1' }),
      makeCertificate({ id: 'exc_2', partyId: 'prt_2', status: 'pending', storedStatus: 'pending', certificateNumber: '77-9', states: ['WA'] }),
    ]);
    renderWithProviders(<ExemptionCertificatesPage />);

    expect(await screen.findByText('Acme Corp')).toBeInTheDocument();
    expect(await screen.findByText('Bolt Inc')).toBeInTheDocument();
    expect(screen.getByText('Pending')).toBeInTheDocument();
    expect(screen.getByText('2 certificates')).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: tc.columns.customer })).toBeInTheDocument();
  });

  it('opens a certificate from its row', async () => {
    const user = userEvent.setup();
    serve([makeCertificate({ id: 'exc_5' })]);
    renderWithProviders(<ExemptionCertificatesPage />);

    await user.click(await screen.findByText('32-123'));
    expect(navigate).toHaveBeenCalledWith({ to: '/weldbooks/sales-tax/certificates/$id', params: { id: 'exc_5' } });
  });

  it('asks the server for the chosen status', async () => {
    const user = userEvent.setup();
    serve([makeCertificate()]);
    renderWithProviders(<ExemptionCertificatesPage />);
    await screen.findByText('32-123');

    await user.click(screen.getByRole('combobox', { name: tc.filters.status }));
    await user.click(await screen.findByRole('option', { name: 'Expired' }));

    await waitFor(() => expect(certificatePaths().some((p) => p.includes('status=expired'))).toBe(true));
  });

  it('asks the server for certificates expiring within the chosen number of days', async () => {
    const user = userEvent.setup();
    serve([makeCertificate()]);
    renderWithProviders(<ExemptionCertificatesPage />);
    await screen.findByText('32-123');
    expect(certificatePaths()[0]).not.toContain('expiringWithinDays');

    await user.click(screen.getByRole('combobox', { name: tc.filters.expiring }));
    await user.click(await screen.findByRole('option', { name: /Within 60 days/ }));

    await waitFor(() => expect(certificatePaths().some((p) => p.includes('expiringWithinDays=60'))).toBe(true));
  });

  it('filters by customer through the customer search', async () => {
    const user = userEvent.setup();
    serve([makeCertificate()]);
    renderWithProviders(<ExemptionCertificatesPage />);
    await screen.findByText('32-123');

    await user.click(screen.getByRole('combobox', { name: tc.filters.customer }));
    const list = await screen.findByRole('listbox');
    await user.click(within(list).getByText('Bolt Inc'));

    await waitFor(() => expect(certificatePaths().some((p) => p.includes('partyId=prt_2'))).toBe(true));
  });

  it('says so when the filters match nothing, without offering to add the first certificate', async () => {
    const user = userEvent.setup();
    serve([]);
    renderWithProviders(<ExemptionCertificatesPage />);
    await screen.findByText(tc.emptyTitle);

    await user.click(screen.getByRole('combobox', { name: tc.filters.status }));
    await user.click(await screen.findByRole('option', { name: 'Valid' }));

    expect(await screen.findByText(tc.emptyFiltered)).toBeInTheDocument();
    expect(screen.queryByText(tc.emptyDescription)).not.toBeInTheDocument();
  });

  it('explains an empty list and offers to add one', async () => {
    serve([]);
    renderWithProviders(<ExemptionCertificatesPage />);

    expect(await screen.findByText(tc.emptyTitle)).toBeInTheDocument();
    expect(screen.getByText(tc.emptyDescription)).toBeInTheDocument();
    expect(screen.getAllByRole('link', { name: tc.add }).every((l) => l.getAttribute('href') === '/weldbooks/sales-tax/certificates/new')).toBe(true);
  });

  it('links to the certificate reports and hides the add link without the create permission', async () => {
    permissions.allowed = new Set(['taxes:read']);
    serve([makeCertificate()]);
    renderWithProviders(<ExemptionCertificatesPage />);

    expect(await screen.findByRole('link', { name: tc.reports })).toHaveAttribute('href', '/weldbooks/sales-tax/certificates/reports');
    expect(screen.queryByRole('link', { name: tc.add })).not.toBeInTheDocument();
  });

  it('offers to try again when the certificates cannot be loaded', async () => {
    const user = userEvent.setup();
    api.get.mockRejectedValueOnce(new Error('boom'));
    renderWithProviders(<ExemptionCertificatesPage />);

    expect(await screen.findByText(tc.loadError)).toBeInTheDocument();
    serve([makeCertificate()]);
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('32-123')).toBeInTheDocument();
  });
});
