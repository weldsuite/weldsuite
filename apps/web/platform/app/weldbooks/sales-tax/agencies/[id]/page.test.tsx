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
  useParams: () => ({ id: 'sta_1' }),
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
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), info: vi.fn() }));
vi.mock('sonner', () => ({ toast }));

import SalesTaxAgencyDetailPage from './page';
import {
  installPointerPolyfills,
  makeAgency,
  makeJurisdiction,
  makeRate,
  makeSettings,
  renderWithProviders,
} from '../../setup/test-support';

const setup = en.weldbooksUs.salesTax.setup;
const ta = setup.agency;

const agency = { ...makeAgency(), hasTaxLines: false };
const texas = makeJurisdiction({ id: 'stj_1', name: 'Texas', level: 'state', currentRate: 6.25 });
const travis = makeJurisdiction({ id: 'stj_2', name: 'Travis County', level: 'county', code: '48453', currentRate: 0.5, rates: [makeRate({ id: 'r2', rate: '0.5000' })] });

function serve(overrides: { agency?: unknown; settings?: unknown; jurisdictions?: unknown[]; zones?: unknown[]; rules?: unknown[] } = {}) {
  api.get.mockImplementation(async (path: string) => {
    if (path.startsWith('/sales-tax-agencies/')) {
      if ('agency' in overrides && overrides.agency === null) throw Object.assign(new Error('not found'), { status: 404 });
      return { data: overrides.agency ?? agency };
    }
    if (path.startsWith('/sales-tax/settings')) return { data: overrides.settings ?? makeSettings() };
    if (path.startsWith('/sales-tax-jurisdictions')) return { data: overrides.jurisdictions ?? [texas, travis] };
    if (path.startsWith('/sales-tax-zones')) return { data: overrides.zones ?? [] };
    if (path.startsWith('/sales-tax-rules')) return { data: overrides.rules ?? [] };
    return { data: [] };
  });
}

beforeAll(installPointerPolyfills);

beforeEach(() => {
  api.get.mockReset();
  api.delete.mockReset();
  navigate.mockReset();
  toast.success.mockReset();
  toast.error.mockReset();
  toast.info.mockReset();
  permissions.allowed = new Set(['taxes:read', 'taxes:create', 'taxes:update', 'taxes:delete']);
  serve();
});

describe('SalesTaxAgencyDetailPage', () => {
  it('shows the registration, filing setup and ledger accounts of the agency', async () => {
    renderWithProviders(<SalesTaxAgencyDetailPage />);

    expect(await screen.findByRole('heading', { name: /Texas \(TX\)/ })).toBeInTheDocument();
    // The agency's name under the heading (the state panel below repeats it).
    expect(screen.getAllByText('Texas Comptroller of Public Accounts').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('32-1234567')).toBeInTheDocument();
    // Registered from and the first period both start on 1 January.
    expect(screen.getAllByText('date:2026-01-01', { selector: 'dd' })).toHaveLength(2);
    expect(screen.getByText('Day 20 of the next month')).toBeInTheDocument();
    expect(screen.getByText('2201 Sales Tax Payable – Texas')).toBeInTheDocument();
    expect(screen.getByText('$1250.00')).toBeInTheDocument();
  });

  it('shows the jurisdictions tab first, with the rate in force today', async () => {
    renderWithProviders(<SalesTaxAgencyDetailPage />);

    expect(await screen.findByRole('tab', { name: ta.tabs.jurisdictions })).toHaveAttribute('aria-selected', 'true');
    expect(await screen.findByText('Travis County')).toBeInTheDocument();
    expect(screen.getByText('6.25%')).toBeInTheDocument();
    expect(screen.getByText('0.5%')).toBeInTheDocument();
    expect(screen.getByText('48453')).toBeInTheDocument();
  });

  it('expands a jurisdiction to its rate history, with the rate in force marked', async () => {
    const user = userEvent.setup();
    renderWithProviders(<SalesTaxAgencyDetailPage />);
    await screen.findByText('Travis County');

    const row = screen.getByText('Travis County').closest('tr') as HTMLElement;
    await user.click(within(row).getByRole('button', { name: setup.jurisdictions.showHistory }));

    expect(await screen.findByText('In force')).toBeInTheDocument();
    expect(screen.getByText('No end date')).toBeInTheDocument();
  });

  it('says plainly when the engine is not the manual one, and links to its settings', async () => {
    serve({ settings: makeSettings({ engine: 'stripe_tax', hasCredentials: true }) });
    renderWithProviders(<SalesTaxAgencyDetailPage />);

    expect(await screen.findByText('Your tax engine is Stripe Tax')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: ta.notManual.link })).toHaveAttribute('href', '/weldbooks/sales-tax/settings');
  });

  it('does not show that note while the engine is manual', async () => {
    renderWithProviders(<SalesTaxAgencyDetailPage />);
    await screen.findByRole('heading', { name: /Texas/ });
    await screen.findByText('Travis County');
    expect(screen.queryByText(/Your tax engine is/)).not.toBeInTheDocument();
  });

  it('says tax is not charged while the agency is not registered', async () => {
    serve({ agency: { ...agency, status: 'pending' } });
    renderWithProviders(<SalesTaxAgencyDetailPage />);
    expect(await screen.findByText('Tax is not charged for this agency while its status is Pending.')).toBeInTheDocument();
  });

  it('deletes an agency that was never used and goes back to the list', async () => {
    const user = userEvent.setup();
    api.delete.mockResolvedValue(undefined);
    renderWithProviders(<SalesTaxAgencyDetailPage />);

    await user.click(await screen.findByRole('button', { name: ta.delete }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent(ta.deleteDialog.description);
    await user.click(within(dialog).getByRole('button', { name: ta.deleteDialog.confirm }));

    await waitFor(() => expect(api.delete).toHaveBeenCalledWith('/sales-tax-agencies/sta_1'));
    await waitFor(() => expect(navigate).toHaveBeenCalledWith({ to: '/weldbooks/sales-tax/agencies' }));
    expect(toast.success).toHaveBeenCalledWith(ta.deleted);
  });

  it('says so when the agency was closed instead of deleted, because tax was collected under it', async () => {
    const user = userEvent.setup();
    api.delete.mockResolvedValue({ data: { id: 'sta_1', deleted: false, closed: true, status: 'closed', registeredUntil: '2026-10-08' } });
    renderWithProviders(<SalesTaxAgencyDetailPage />);

    await user.click(await screen.findByRole('button', { name: ta.delete }));
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: ta.deleteDialog.confirm }));

    await waitFor(() => expect(toast.info).toHaveBeenCalledWith(ta.closedInstead));
    expect(navigate).not.toHaveBeenCalled();
  });

  it('offers only what the permissions allow', async () => {
    permissions.allowed = new Set(['taxes:read']);
    renderWithProviders(<SalesTaxAgencyDetailPage />);

    await screen.findByRole('heading', { name: /Texas/ });
    await screen.findByText('Travis County');
    expect(screen.queryByRole('button', { name: ta.editRegistration })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: new RegExp(ta.changeStatus) })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: ta.delete })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: setup.jurisdictions.add })).not.toBeInTheDocument();
  });

  it('says when the agency does not exist', async () => {
    serve({ agency: null });
    renderWithProviders(<SalesTaxAgencyDetailPage />);
    expect(await screen.findByText(ta.notFound)).toBeInTheDocument();
  });

  it('says so when the agency cannot be loaded, and offers to try again', async () => {
    const user = userEvent.setup();
    api.get.mockRejectedValueOnce(new Error('boom'));
    api.get.mockRejectedValueOnce(new Error('boom'));
    renderWithProviders(<SalesTaxAgencyDetailPage />);

    expect(await screen.findByText(ta.loadError)).toBeInTheDocument();
    serve();
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('heading', { name: /Texas/ })).toBeInTheDocument();
  });

  it('shows the server sentence when a jurisdiction is still in a zone and cannot be deleted', async () => {
    const user = userEvent.setup();
    api.delete.mockRejectedValue(new Error('This jurisdiction is part of the tax zone "Austin". Remove it from it first.'));
    renderWithProviders(<SalesTaxAgencyDetailPage />);

    await screen.findByText('Travis County');
    await user.click(screen.getByRole('button', { name: `${setup.common.delete}: Travis County` }));
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: setup.jurisdictions.deleteDialog.confirm }));

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith('This jurisdiction is part of the tax zone "Austin". Remove it from it first.'),
    );
  });
});
