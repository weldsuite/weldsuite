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
vi.mock('@/components/object-panel', () => import('@/components/objects/_shared/object-panel-test-mock'));
vi.mock('@weldsuite/permissions/react', () => ({
  usePermissions: () => ({ can: (permission: string) => permissions.allowed.has(permission) }),
}));
const jurisdiction = vi.hoisted(() => ({ salesTax: true, resolved: true }));
vi.mock('@/lib/weldbooks/use-jurisdiction', () => ({
  useCurrentJurisdiction: () => ({
    features: { salesTax: jurisdiction.salesTax },
    isResolved: jurisdiction.resolved,
    isError: false,
  }),
}));
vi.mock('@/lib/weldbooks/use-weldbooks-format', () => ({
  useWeldbooksFormat: () => ({
    formatDate: (value: string | null | undefined, empty = '') => (value ? `date:${value}` : empty),
    formatMoney: (value: string) => `$${value}`,
    today: () => '2026-10-08',
  }),
}));

import SalesTaxAgenciesPage from './page';
import { panelOpen } from '@/components/objects/_shared/object-panel-test-mock';
import { installPointerPolyfills, makeAgency, renderWithProviders } from '../setup/test-support';

const ta = en.weldbooksUs.salesTax.setup.agencies;

/** The list rows (the `group` divs of the standard list), in the order shown. */
function listRows(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>('div.group'));
}

/**
 * Adds a finished `is` filter pill through the toolbar: "Filter" > field > "is" > value.
 * The pill opens its value picker on a timer, and the focus returning to the operator
 * button can dismiss it again: when the options are not there, open the picker by hand.
 */
async function addIsFilter(user: ReturnType<typeof userEvent.setup>, field: string, value: string): Promise<void> {
  await user.click(screen.getByRole('button', { name: 'Filter' }));
  await user.click(await screen.findByRole('button', { name: field }));
  await user.click(await screen.findByRole('button', { name: 'is' }));
  const option = await screen.findByRole('button', { name: value }, { timeout: 400 }).catch(async () => {
    await user.click(screen.getByRole('button', { name: `Select ${field.toLowerCase()}` }));
    return screen.findByRole('button', { name: value });
  });
  await user.click(option);
}

function serve(agencies: unknown[]) {
  api.get.mockImplementation(async () => ({ data: agencies, pagination: { totalCount: agencies.length, hasMore: false, cursor: null } }));
}

const texas = makeAgency({ id: 'sta_tx', stateCode: 'TX', name: 'Texas Comptroller of Public Accounts' });
const washington = makeAgency({
  id: 'sta_wa',
  stateCode: 'WA',
  name: 'Washington State Department of Revenue',
  filingFrequency: 'monthly',
  dueDay: 25,
  registrationNumber: '602-123-456',
  liabilityAccount: { id: 'acc_9', code: '2203', name: 'Sales Tax Payable – Washington', balance: '310.50' },
});
const monitoring = makeAgency({ id: 'sta_ca', stateCode: 'CA', name: 'CDTFA', status: 'monitoring', registeredFrom: null, registrationNumber: null, dueDay: 31 });

beforeAll(installPointerPolyfills);

beforeEach(() => {
  api.get.mockReset();
  navigate.mockReset();
  panelOpen.mockReset();
  jurisdiction.salesTax = true;
  jurisdiction.resolved = true;
  permissions.allowed = new Set(['taxes:read', 'taxes:create']);
});

describe('SalesTaxAgenciesPage', () => {
  it('lists the agencies with state, status, filing, due day, owed balance and registration number, registered first', async () => {
    serve([monitoring, washington, texas]);
    renderWithProviders(<SalesTaxAgenciesPage />);

    await screen.findByText('Texas');
    const rows = listRows();
    expect(rows).toHaveLength(3);
    // Registered agencies come first, by state; the one only being watched comes last.
    expect(within(rows[0]).getByText('Texas')).toBeInTheDocument();
    expect(within(rows[1]).getByText('Washington')).toBeInTheDocument();
    expect(within(rows[2]).getByText('California')).toBeInTheDocument();

    const wa = within(rows[1]);
    expect(wa.getByText('WA')).toBeInTheDocument();
    expect(wa.getByText('Washington State Department of Revenue')).toBeInTheDocument();
    expect(wa.getByText('Registered')).toBeInTheDocument();
    expect(wa.getByText('Monthly')).toBeInTheDocument();
    expect(wa.getByText('Day 25 of the next month')).toBeInTheDocument();
    expect(wa.getByText('$310.50')).toBeInTheDocument();
    expect(wa.getByText('602-123-456')).toBeInTheDocument();
    expect(wa.getByText('date:2026-01-01')).toBeInTheDocument();

    const ca = within(rows[2]);
    expect(ca.getByText('Monitoring')).toBeInTheDocument();
    expect(ca.getByText('Last day of the next month')).toBeInTheDocument();
  });

  it('opens an agency in its record panel from its row', async () => {
    const user = userEvent.setup();
    serve([texas]);
    renderWithProviders(<SalesTaxAgenciesPage />);

    await user.click(await screen.findByRole('button', { name: 'Texas Comptroller of Public Accounts' }));
    expect(panelOpen).toHaveBeenCalledWith({ type: 'sales_tax_agency', id: 'sta_tx' });
    expect(navigate).not.toHaveBeenCalled();
  });

  it('filters by the chosen status', async () => {
    const user = userEvent.setup();
    const pending = makeAgency({ id: 'sta_or', stateCode: 'OR', name: 'Oregon Department of Revenue', status: 'pending' });
    serve([texas, pending]);
    renderWithProviders(<SalesTaxAgenciesPage />);
    await screen.findByText('Texas');
    expect(listRows()).toHaveLength(2);

    await addIsFilter(user, ta.filterStatus, 'Pending');

    await waitFor(() => expect(listRows()).toHaveLength(1));
    expect(screen.getByText('Oregon')).toBeInTheDocument();
    expect(screen.queryByText('Texas')).not.toBeInTheDocument();
  });

  it('explains an empty list and offers to register', async () => {
    const user = userEvent.setup();
    serve([]);
    renderWithProviders(<SalesTaxAgenciesPage />);

    expect(await screen.findByText(ta.emptyTitle)).toBeInTheDocument();
    expect(screen.getByText(ta.emptyDescription)).toBeInTheDocument();
    const buttons = screen.getAllByRole('button', { name: ta.register });
    expect(buttons).toHaveLength(2);
    await user.click(buttons[buttons.length - 1]);
    expect(navigate).toHaveBeenCalledWith({ to: '/weldbooks/sales-tax/agencies/new' });
  });

  it('does not offer to register without the create permission', async () => {
    permissions.allowed = new Set(['taxes:read']);
    serve([texas]);
    renderWithProviders(<SalesTaxAgenciesPage />);
    await screen.findByText('Texas');
    expect(screen.queryByRole('button', { name: ta.register })).not.toBeInTheDocument();
  });

  it('offers to try again when the agencies cannot be loaded', async () => {
    const user = userEvent.setup();
    api.get.mockRejectedValueOnce(new Error('boom'));
    renderWithProviders(<SalesTaxAgenciesPage />);

    expect(await screen.findByText(ta.loadError)).toBeInTheDocument();
    serve([texas]);
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('Texas')).toBeInTheDocument();
  });

  it('links to the engine settings', async () => {
    serve([]);
    renderWithProviders(<SalesTaxAgenciesPage />);
    expect(await screen.findByRole('link', { name: ta.engineSettings })).toHaveAttribute('href', '/weldbooks/sales-tax/settings');
  });

  it('is only for a US entity', () => {
    jurisdiction.salesTax = false;
    serve([texas]);
    renderWithProviders(<SalesTaxAgenciesPage />);
    expect(screen.getByText(en.weldbooksUs.salesTax.setup.common.usOnly)).toBeInTheDocument();
    expect(api.get).not.toHaveBeenCalled();
  });

  it('is closed to a member who cannot read taxes', () => {
    permissions.allowed = new Set();
    renderWithProviders(<SalesTaxAgenciesPage />);
    expect(screen.getByText(en.weldbooksUs.salesTax.setup.common.noAccess)).toBeInTheDocument();
    expect(api.get).not.toHaveBeenCalled();
  });
});
