import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { en } from '@weldsuite/i18n/locales/en';

const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), patch: vi.fn(), put: vi.fn(), delete: vi.fn() }));
vi.mock('@/lib/api/weldbooks-client', () => ({ weldbooksApi: api, setWeldbooksEntityId: vi.fn() }));
const navigate = vi.hoisted(() => vi.fn());
vi.mock('@tanstack/react-router', () => ({
  Link: ({ to, search, children }: { to: string; search?: Record<string, string>; children: React.ReactNode }) => (
    <a href={search ? `${to}?${new URLSearchParams(search).toString()}` : to}>{children}</a>
  ),
  useNavigate: () => navigate,
}));
const permissions = vi.hoisted(() => ({ allowed: new Set<string>() }));
vi.mock('@weldsuite/permissions/react', () => ({
  usePermissions: () => ({ can: (permission: string) => permissions.allowed.has(permission) }),
}));
vi.mock('@/lib/weldbooks/use-weldbooks-format', () => ({
  useWeldbooksFormat: () => ({
    formatDate: (value: string | null | undefined) => `date:${value ?? ''}`,
    formatMoney: (value: string) => `$${value}`,
    today: () => '2026-10-08',
  }),
}));

import { CustomerExemptionsTab } from './customer-exemptions-tab';
import { makeCertificate, renderWithProviders } from '../setup/test-support';

const te = en.weldbooksUs.salesTax.setup.exemptions;
const tc = en.weldbooksUs.salesTax.setup.certificates;

function serve(certificates: unknown[]) {
  api.get.mockImplementation(async () => ({ data: certificates, pagination: { totalCount: certificates.length, hasMore: false, cursor: null } }));
}

beforeEach(() => {
  api.get.mockReset();
  navigate.mockReset();
  permissions.allowed = new Set(['taxes:read', 'taxes:create']);
  serve([]);
});

describe('CustomerExemptionsTab', () => {
  it('lists the certificates of this customer only, with states, status and expiry', async () => {
    serve([
      makeCertificate({ id: 'exc_1', states: ['TX', 'OK'], certificateNumber: '32-123' }),
      makeCertificate({
        id: 'exc_2',
        states: ['WA'],
        certificateNumber: null,
        reason: 'nonprofit',
        status: 'expired',
        storedStatus: 'valid',
        expiresOn: '2026-09-30',
        effectiveExpiresOn: '2026-09-30',
        daysUntilExpiry: -8,
      }),
    ]);
    renderWithProviders(<CustomerExemptionsTab partyId="prt_1" taxUse="business" />);

    const rows = await screen.findAllByRole('row');
    const first = within(rows[1]);
    expect(first.getByText('TX')).toBeInTheDocument();
    expect(first.getByText('OK')).toBeInTheDocument();
    expect(first.getByText('32-123')).toBeInTheDocument();
    expect(first.getByText('Valid')).toBeInTheDocument();
    expect(first.getByText(/Expires date:2027-01-14/)).toHaveTextContent('(in 98 days)');
    const second = within(rows[2]);
    expect(second.getByText('Expired')).toBeInTheDocument();
    expect(second.getByText('Expired date:2026-09-30')).toBeInTheDocument();
    expect(second.getByText('Nonprofit')).toBeInTheDocument();

    expect(api.get).toHaveBeenCalledTimes(1);
    expect(api.get.mock.calls[0][0]).toContain('/exemption-certificates?');
    expect(api.get.mock.calls[0][0]).toContain('partyId=prt_1');
  });

  it('leaves the customer column out, since every row is the same customer', async () => {
    serve([makeCertificate()]);
    renderWithProviders(<CustomerExemptionsTab partyId="prt_1" />);
    await screen.findByText('32-123');
    expect(screen.queryByRole('columnheader', { name: tc.columns.customer })).not.toBeInTheDocument();
  });

  it('shows the default use the contact form sets', async () => {
    renderWithProviders(<CustomerExemptionsTab partyId="prt_1" taxUse="personal" />);
    expect(await screen.findByTestId('customer-default-use')).toHaveTextContent('Personal');
  });

  it('says when no default use is set', async () => {
    renderWithProviders(<CustomerExemptionsTab partyId="prt_1" taxUse={null} />);
    expect(await screen.findByTestId('customer-default-use')).toHaveTextContent(te.defaultUseNone);
  });

  it('links to add a certificate for this customer', async () => {
    renderWithProviders(<CustomerExemptionsTab partyId="prt_1" />);
    const link = await screen.findByRole('link', { name: te.add });
    expect(link).toHaveAttribute('href', '/weldbooks/sales-tax/certificates/new?partyId=prt_1');
  });

  it('does not offer to add one without the create permission', async () => {
    permissions.allowed = new Set(['taxes:read']);
    renderWithProviders(<CustomerExemptionsTab partyId="prt_1" />);
    await screen.findByText(te.emptyTitle);
    expect(screen.queryByRole('link', { name: te.add })).not.toBeInTheDocument();
  });

  it('explains an empty list', async () => {
    renderWithProviders(<CustomerExemptionsTab partyId="prt_1" />);
    expect(await screen.findByText(te.emptyTitle)).toBeInTheDocument();
    expect(screen.getByText(te.emptyDescription)).toBeInTheDocument();
  });

  it('offers to try again when the certificates cannot be loaded', async () => {
    const user = userEvent.setup();
    api.get.mockRejectedValueOnce(new Error('boom'));
    renderWithProviders(<CustomerExemptionsTab partyId="prt_1" />);

    expect(await screen.findByText(te.loadError)).toBeInTheDocument();
    serve([makeCertificate()]);
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('32-123')).toBeInTheDocument();
  });

  it('opens a certificate from its row', async () => {
    const user = userEvent.setup();
    serve([makeCertificate({ id: 'exc_7' })]);
    renderWithProviders(<CustomerExemptionsTab partyId="prt_1" />);

    await user.click(await screen.findByText('32-123'));
    expect(navigate).toHaveBeenCalledWith({ to: '/weldbooks/sales-tax/certificates/$id', params: { id: 'exc_7' } });
  });

  it('asks for nothing without the read permission', async () => {
    permissions.allowed = new Set();
    renderWithProviders(<CustomerExemptionsTab partyId="prt_1" />);
    expect(screen.getByText(en.weldbooksUs.salesTax.setup.common.noAccess)).toBeInTheDocument();
    await waitFor(() => expect(api.get).not.toHaveBeenCalled());
  });
});
