import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const permissions = vi.hoisted(() => ({ allowed: new Set<string>() }));
const navigate = vi.hoisted(() => vi.fn());
const overview = vi.hoisted(() => ({ data: undefined as unknown, isLoading: false, isError: false }));

vi.mock('@tanstack/react-router', () => ({
  Link: ({ to, params, search, children }: { to: string; params?: Record<string, string>; search?: Record<string, string>; children: React.ReactNode }) => {
    const path = params ? to.replace('$state', params.state ?? '') : to;
    const query = search ? `?${new URLSearchParams(search).toString()}` : '';
    return <a href={`${path}${query}`}>{children}</a>;
  },
  useNavigate: () => navigate,
}));
vi.mock('@weldsuite/permissions/react', () => ({
  usePermissions: () => ({ can: (permission: string) => permissions.allowed.has(permission) }),
}));
const format = vi.hoisted(() => ({
  formatMoney: (value: number | string) => `$${Number(value).toFixed(0)}`,
  formatDate: (value: string) => value,
}));
vi.mock('@/lib/weldbooks/use-weldbooks-format', () => ({ useWeldbooksFormat: () => format }));
vi.mock('@/hooks/queries/use-weldbooks-sales-tax-center-queries', () => ({
  useNexusOverview: () => ({ ...overview, refetch: vi.fn(), error: null }),
}));
vi.mock('../shared/sales-tax-frame', () => ({
  SalesTaxFrame: ({ title, children }: { title: string; children: React.ReactNode }) => (
    <div>
      <h1>{title}</h1>
      {children}
    </div>
  ),
}));

import NexusMonitorPage from './page';
import { installPointerPolyfills, makeNexusRow, renderWithProviders } from '../shared/test-support';
import type { NexusOverview } from '@/lib/api/domains/weldbooks-sales-tax-center';

const data: NexusOverview = {
  asOf: '2026-10-08',
  summary: { exceededUnregistered: 1, approaching: 1, exceededRegistered: 1, monitored: 4 },
  rows: [
    makeNexusRow({
      stateCode: 'WA',
      stateName: 'Washington',
      salesTotal: 140000,
      thresholdSales: 100000,
      percentOfThreshold: 140,
      status: 'exceeded',
      alert: 'registered',
      registered: true,
      agencyStatus: 'registered',
      exceededOn: '2026-03-02',
    }),
    makeNexusRow({
      stateCode: 'CA',
      stateName: 'California',
      salesTotal: 650000,
      thresholdSales: 500000,
      percentOfThreshold: 130,
      status: 'exceeded',
      alert: 'register',
      exceededOn: '2026-08-14',
      collectFrom: '2026-08-15',
      collectFromVerified: false,
      pending: { exceededOn: '2026-08-14', testDate: '2026-08-14', collectFrom: '2026-08-15' },
    }),
    makeNexusRow({
      stateCode: 'NY',
      stateName: 'New York',
      salesTotal: 450000,
      thresholdSales: 500000,
      thresholdTransactions: 100,
      transactionCount: 60,
      test: 'and',
      percentOfThreshold: 90,
      status: 'approaching',
      alert: 'watch',
    }),
    makeNexusRow({ stateCode: 'TX', stateName: 'Texas', salesTotal: 85000, percentOfThreshold: 17 }),
  ],
};

beforeAll(installPointerPolyfills);

/** The list row (a `group` div of the standard list) of a state, found by its code chip. */
function stateRow(code: string): HTMLElement {
  const row = screen.getByText(code).closest<HTMLElement>('div.group');
  if (!row) throw new Error(`No list row for ${code}`);
  return row;
}

beforeEach(() => {
  navigate.mockReset();
  overview.data = data;
  overview.isLoading = false;
  overview.isError = false;
  permissions.allowed = new Set(['taxes:read', 'taxes:create']);
});

describe('Nexus monitor page', () => {
  it('counts the states that need action in the summary', () => {
    renderWithProviders(<NexusMonitorPage />);

    expect(screen.getByTestId('nexus-summary-register')).toHaveTextContent('1');
    expect(screen.getByTestId('nexus-summary-watch')).toHaveTextContent('1');
    expect(screen.getByTestId('nexus-summary-registered')).toHaveTextContent('1');
    expect(screen.getByTestId('nexus-summary-monitored')).toHaveTextContent('4');
  });

  it('keeps the states in the order the server sent: nearest to its threshold first', () => {
    renderWithProviders(<NexusMonitorPage />);

    const rows = Array.from(document.querySelectorAll<HTMLElement>('div.group'));
    expect(rows).toHaveLength(4);
    expect(rows.map((row) => row.querySelector('[data-row-overlay]')?.getAttribute('aria-label'))).toEqual([
      'Washington: Details',
      'California: Details',
      'New York: Details',
      'Texas: Details',
    ]);
  });

  it('draws each bar in the tone of its progress', () => {
    renderWithProviders(<NexusMonitorPage />);

    const tone = (state: string) => within(stateRow(state)).getByRole('progressbar').getAttribute('data-tone');
    expect(tone('WA')).toBe('registered');
    expect(tone('CA')).toBe('exceeded');
    expect(tone('NY')).toBe('watch');
    expect(tone('TX')).toBe('neutral');

    expect(within(stateRow('NY')).getByRole('progressbar')).toHaveAttribute('aria-valuenow', '90');
    expect(within(stateRow('CA')).getByRole('progressbar')).toHaveAttribute('aria-valuenow', '100');
  });

  it('shows the alert of each state', () => {
    renderWithProviders(<NexusMonitorPage />);

    expect(within(stateRow('CA')).getByText('Register now')).toBeInTheDocument();
    expect(within(stateRow('NY')).getByText('Watch')).toBeInTheDocument();
    // A registered state shows it twice: as its alert and in the registered column.
    expect(within(stateRow('WA')).getAllByText('Registered')).toHaveLength(2);
    expect(within(stateRow('TX')).getByText('OK')).toBeInTheDocument();
  });

  it('shows sales against the threshold, and transactions where the state tests them', () => {
    renderWithProviders(<NexusMonitorPage />);

    const ny = stateRow('NY');
    expect(ny).toHaveTextContent('$450000 of $500000');
    expect(ny).toHaveTextContent('60 of 100');
    expect(stateRow('TX')).not.toHaveTextContent(' of 100');
  });

  it('offers Register only for an exceeded state without a registration', () => {
    renderWithProviders(<NexusMonitorPage />);

    const register = within(stateRow('CA')).getByRole('link', { name: 'Register' });
    expect(register).toHaveAttribute('href', '/weldbooks/sales-tax/agencies/new?state=CA');
    for (const state of ['WA', 'NY', 'TX']) {
      expect(within(stateRow(state)).queryByRole('link', { name: 'Register' })).not.toBeInTheDocument();
    }
  });

  it('hides Register from someone who cannot create agencies', () => {
    permissions.allowed = new Set(['taxes:read']);
    renderWithProviders(<NexusMonitorPage />);
    expect(screen.queryByRole('link', { name: 'Register' })).not.toBeInTheDocument();
  });

  it('opens the detail of a state from its row', async () => {
    const user = userEvent.setup();
    renderWithProviders(<NexusMonitorPage />);
    await user.click(within(stateRow('NY')).getByRole('button', { name: 'New York: Details' }));
    expect(navigate).toHaveBeenCalledWith({ to: '/weldbooks/sales-tax/nexus/$state', params: { state: 'NY' } });
  });

  it('says when the collection start of a state is not confirmed and when to collect from', () => {
    renderWithProviders(<NexusMonitorPage />);
    const ca = stateRow('CA');
    expect(ca).toHaveTextContent('2026-08-15');
    expect(ca.querySelector('[title^="Collect from 2026-08-15"]')).not.toBeNull();
    expect(within(ca).getByTitle('Check with the state')).toBeInTheDocument();
  });

  it('shows an empty state when no state matches', () => {
    overview.data = { ...data, rows: [] };
    renderWithProviders(<NexusMonitorPage />);
    expect(screen.getByText('No states match')).toBeInTheDocument();
  });
});
