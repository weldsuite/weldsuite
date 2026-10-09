import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { en } from '@weldsuite/i18n/locales/en';

const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), patch: vi.fn(), put: vi.fn(), delete: vi.fn() }));
vi.mock('@/lib/api/weldbooks-client', () => ({ weldbooksApi: api, setWeldbooksEntityId: vi.fn() }));
vi.mock('@tanstack/react-router', () => ({
  Link: ({ to, search, children }: { to: string; search?: Record<string, string>; children: React.ReactNode }) => (
    <a href={search ? `${to}?${new URLSearchParams(search).toString()}` : to}>{children}</a>
  ),
  useNavigate: () => vi.fn(),
  useParams: () => ({ id: 'prt_1' }),
}));
const permissions = vi.hoisted(() => ({ allowed: new Set<string>() }));
vi.mock('@weldsuite/permissions/react', () => ({
  usePermissions: () => ({ can: (permission: string) => permissions.allowed.has(permission) }),
}));
const jurisdiction = vi.hoisted(() => ({ salesTax: true }));
vi.mock('@/lib/weldbooks/use-jurisdiction', () => ({
  useJurisdictionLabels: () => ({
    labels: { supplier: 'Vendor', taxId: 'EIN', registrationId: 'State ID' },
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
vi.mock('@/components/page-loader', () => ({ PageLoader: () => <div>loading</div> }));

import ContactDetailPage from './page';
import { makeCertificate, renderWithProviders } from '@/app/weldbooks/sales-tax/setup/test-support';

const tx = en.weldbooksUs.salesTax.setup.exemptions;

function serve(contact: Record<string, unknown>, certificates: unknown[] = []) {
  api.get.mockImplementation(async (path: string) => {
    if (path.startsWith('/exemption-certificates')) return { data: certificates };
    if (path.startsWith('/accounting-contacts/')) return { data: contact };
    return { data: [] };
  });
}

const customer = { id: 'prt_1', name: 'Acme Corp', role: 'customer', email: 'ap@acme.test', taxUse: 'business' };

beforeEach(() => {
  api.get.mockReset();
  jurisdiction.salesTax = true;
  permissions.allowed = new Set(['taxes:read', 'taxes:create']);
});

describe('customer detail page: Exemptions tab', () => {
  it('adds an Exemptions tab for a customer of a US entity, next to the details', async () => {
    serve(customer);
    renderWithProviders(<ContactDetailPage />);

    const tablist = await screen.findByRole('tablist');
    expect(within(tablist).getByRole('tab', { name: tx.tabDetails })).toHaveAttribute('aria-selected', 'true');
    expect(within(tablist).getByRole('tab', { name: tx.tabExemptions })).toBeInTheDocument();
    // The details are what opens first.
    expect(screen.getByText('ap@acme.test')).toBeInTheDocument();
  });

  it('shows the certificates, the add link and the default use on the tab', async () => {
    const user = userEvent.setup();
    serve(customer, [makeCertificate({ certificateNumber: '32-123' })]);
    renderWithProviders(<ContactDetailPage />);

    await user.click(await screen.findByRole('tab', { name: tx.tabExemptions }));

    expect(await screen.findByText('32-123')).toBeInTheDocument();
    expect(screen.getByTestId('customer-default-use')).toHaveTextContent('Business');
    expect(screen.getByRole('link', { name: tx.add })).toHaveAttribute('href', '/weldbooks/sales-tax/certificates/new?partyId=prt_1');
  });

  it('has no tabs at all for a non-US entity: the page is as it was', async () => {
    jurisdiction.salesTax = false;
    serve(customer);
    renderWithProviders(<ContactDetailPage />);

    expect(await screen.findByText('ap@acme.test')).toBeInTheDocument();
    expect(screen.queryByRole('tablist')).not.toBeInTheDocument();
    expect(api.get.mock.calls.some(([path]) => String(path).startsWith('/exemption-certificates'))).toBe(false);
  });

  it('has no Exemptions tab for a vendor who is not also a customer', async () => {
    serve({ ...customer, role: 'supplier' });
    renderWithProviders(<ContactDetailPage />);

    expect(await screen.findByText('ap@acme.test')).toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: tx.tabExemptions })).not.toBeInTheDocument();
  });

  it('keeps the tab for a contact who is both customer and vendor', async () => {
    serve({ ...customer, role: 'both' });
    renderWithProviders(<ContactDetailPage />);
    expect(await screen.findByRole('tab', { name: tx.tabExemptions })).toBeInTheDocument();
  });
});
