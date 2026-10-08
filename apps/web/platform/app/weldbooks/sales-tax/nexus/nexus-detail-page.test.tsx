import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, within } from '@testing-library/react';

const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() }));
vi.mock('@/lib/api/weldbooks-client', () => ({ weldbooksApi: api, setWeldbooksEntityId: vi.fn() }));
vi.mock('@tanstack/react-router', () => ({
  Link: ({ to, search, children }: { to: string; search?: Record<string, string>; children: React.ReactNode }) => (
    <a href={search ? `${to}?${new URLSearchParams(search).toString()}` : to}>{children}</a>
  ),
  useParams: () => ({ state: 'ca' }),
}));
const permissions = vi.hoisted(() => ({ allowed: new Set<string>() }));
vi.mock('@weldsuite/permissions/react', () => ({
  usePermissions: () => ({ can: (permission: string) => permissions.allowed.has(permission) }),
}));
const format = vi.hoisted(() => ({
  formatMoney: (value: number | string) => `$${Number(value).toFixed(0)}`,
  formatDate: (value: string | null) => value ?? '—',
  formatMonth: (value: string) => value.slice(0, 7),
  dateLocale: 'en-US',
}));
vi.mock('@/lib/weldbooks/use-weldbooks-format', () => ({ useWeldbooksFormat: () => format }));
vi.mock('../shared/sales-tax-frame', () => ({
  SalesTaxGate: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

import NexusStatePage from './[state]/page';
import { makeNexusRow, renderWithProviders } from '../shared/test-support';
import type { NexusDetail } from '@/lib/api/domains/weldbooks-sales-tax-center';

function detail(overrides: Partial<NexusDetail> = {}): NexusDetail {
  return {
    ...makeNexusRow({
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
      unverified: ['collection_start', 'marketplace'],
      ruleNotes: 'Counts sales into the state.',
      periods: [
        { role: 'binding', label: '2025', from: '2025-01-01', to: '2025-12-31', salesTotal: 420000, transactionCount: 90, percentOfThreshold: 84, exceeded: false },
        { role: 'look_ahead', label: '2026 so far', from: '2026-01-01', to: '2026-10-08', salesTotal: 650000, transactionCount: 140, percentOfThreshold: 130, exceeded: true, exceededOn: '2026-08-14' },
      ],
    }),
    rule: {
      effectiveFrom: '2019-04-01',
      salesThreshold: 500000,
      transactionThreshold: null,
      test: 'none',
      comparison: 'gt',
      base: 'retail',
      window: 'previous_or_current_calendar_year',
      marketplaceSalesCount: true,
    },
    monthly: [
      { month: '2026-07', sales: 50000, gross: 52000, taxable: 50000, transactions: 12, marketplaceSales: 0 },
      { month: '2026-08', sales: 90000, gross: 91000, taxable: 90000, transactions: 20, marketplaceSales: 1000 },
    ],
    ...overrides,
  };
}

beforeEach(() => {
  api.get.mockReset();
  permissions.allowed = new Set(['taxes:read', 'taxes:create']);
  api.get.mockResolvedValue({ data: detail() });
});

describe('Nexus state page', () => {
  it('asks for the state in upper case and shows the measurement against the threshold', async () => {
    renderWithProviders(<NexusStatePage />);

    expect(await screen.findByRole('heading', { name: 'California nexus' })).toBeInTheDocument();
    expect(api.get).toHaveBeenCalledWith('/sales-tax/nexus/CA');
    expect(screen.getByTestId('nexus-sales')).toHaveTextContent('$650000 of $500000');
    expect(screen.getByTestId('nexus-transactions')).toHaveTextContent('No transaction test');
    // The first bar is the measurement; the periods below have bars of their own.
    expect(screen.getAllByRole('progressbar')[0]).toHaveAttribute('data-tone', 'exceeded');
  });

  it('says what the state rule is', async () => {
    renderWithProviders(<NexusStatePage />);

    await screen.findByText('State rule');
    expect(screen.getByText('The threshold must be exceeded')).toBeInTheDocument();
    expect(screen.getByText('Retail sales (not for resale)')).toBeInTheDocument();
    expect(screen.getByText('Previous or current calendar year')).toBeInTheDocument();
    expect(screen.getByText('Sales only')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Open the state guide/ })).toHaveAttribute('href', 'https://example.test/texas');
    expect(screen.getByText('Counts sales into the state.')).toBeInTheDocument();
  });

  it('lists the points the research could not confirm', async () => {
    renderWithProviders(<NexusStatePage />);

    const flags = await screen.findByTestId('nexus-unverified');
    expect(flags).toHaveTextContent('When collection must start');
    expect(flags).toHaveTextContent('Whether marketplace sales count');
  });

  it('shows each measurement period with its role', async () => {
    renderWithProviders(<NexusStatePage />);

    const [binding, lookAhead] = await screen.findAllByTestId('nexus-period');
    expect(binding).toHaveTextContent('Counts');
    expect(binding).toHaveTextContent('$420000');
    expect(within(binding!).getByRole('progressbar')).toHaveAttribute('data-tone', 'watch');
    expect(lookAhead).toHaveTextContent('In progress, warns only');
    expect(lookAhead).toHaveTextContent('2026-08-14');
    expect(within(lookAhead!).getByRole('progressbar')).toHaveAttribute('data-tone', 'exceeded');
  });

  it('shows the months of sales as a chart and a table', async () => {
    renderWithProviders(<NexusStatePage />);

    expect(await screen.findByTestId('monthly-chart')).toBeInTheDocument();
    const months = screen.getAllByTestId('nexus-month');
    expect(months).toHaveLength(2);
    expect(months[1]).toHaveTextContent('2026-08');
    expect(months[1]).toHaveTextContent('$90000');
    expect(months[1]).toHaveTextContent('$1000');
  });

  it('offers to register a state that has no registration and is over the threshold', async () => {
    renderWithProviders(<NexusStatePage />);
    expect(await screen.findByRole('link', { name: 'Register' })).toHaveAttribute('href', '/weldbooks/sales-tax/agencies/new?state=CA');
  });

  it('does not offer to register a state where the business is already registered', async () => {
    api.get.mockResolvedValue({ data: detail({ alert: 'registered', registered: true }) });
    renderWithProviders(<NexusStatePage />);

    await screen.findByRole('heading', { name: 'California nexus' });
    expect(screen.queryByRole('link', { name: 'Register' })).not.toBeInTheDocument();
  });

  it('says when the threshold was crossed in the look-ahead period', async () => {
    api.get.mockResolvedValue({
      data: detail({ pending: { exceededOn: '2026-10-01', testDate: '2026-10-01', collectFrom: '2027-01-01' } }),
    });
    renderWithProviders(<NexusStatePage />);

    expect(await screen.findByTestId('nexus-pending')).toHaveTextContent('Collect from 2027-01-01. The threshold was crossed on 2026-10-01.');
  });

  it('says a state without sales tax has nothing to monitor (404)', async () => {
    api.get.mockRejectedValue(Object.assign(new Error('Not found'), { status: 404, code: 'NOT_FOUND', body: {} }));
    renderWithProviders(<NexusStatePage />);

    expect(await screen.findByText('Nothing to monitor here')).toBeInTheDocument();
    expect(screen.getAllByRole('link', { name: 'All states' }).length).toBeGreaterThan(0);
  });
});
