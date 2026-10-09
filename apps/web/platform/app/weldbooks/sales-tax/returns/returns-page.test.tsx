import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() }));
vi.mock('@/lib/api/weldbooks-client', () => ({ weldbooksApi: api, setWeldbooksEntityId: vi.fn() }));
const navigate = vi.hoisted(() => vi.fn());
vi.mock('@tanstack/react-router', () => ({
  Link: ({ to, params, children }: { to: string; params?: Record<string, string>; children: React.ReactNode }) => (
    <a href={params ? to.replace('$id', params.id ?? '') : to}>{children}</a>
  ),
  useNavigate: () => navigate,
}));
const permissions = vi.hoisted(() => ({ allowed: new Set<string>() }));
vi.mock('@weldsuite/permissions/react', () => ({
  usePermissions: () => ({ can: (permission: string) => permissions.allowed.has(permission) }),
}));
const format = vi.hoisted(() => ({
  formatMoney: (value: number | string) => `$${Number(value).toFixed(2)}`,
  formatDate: (value: string | null) => value ?? '—',
}));
vi.mock('@/lib/weldbooks/use-weldbooks-format', () => ({ useWeldbooksFormat: () => format }));
vi.mock('../shared/sales-tax-frame', () => ({
  SalesTaxFrame: ({ title, children }: { title: string; children: React.ReactNode }) => (
    <div>
      <h1>{title}</h1>
      {children}
    </div>
  ),
}));

import SalesTaxReturnsPage from './page';
import { installPointerPolyfills, renderWithProviders } from '../shared/test-support';
import type { AgencyPeriods, PeriodRow, PeriodsResponse } from '@/lib/api/domains/weldbooks-sales-tax-center';

function period(overrides: Partial<PeriodRow> = {}): PeriodRow {
  return {
    key: 'sales_tax:sta_wa:2026-09-30',
    agencyId: 'sta_wa',
    agencyName: 'Washington Department of Revenue',
    stateCode: 'WA',
    periodStart: '2026-07-01',
    periodEnd: '2026-09-30',
    dueDate: '2026-10-25',
    nominalDueDate: '2026-10-25',
    return: null,
    amendments: [],
    state: 'due',
    unfiled: true,
    overdue: false,
    daysUntilDue: 17,
    ...overrides,
  };
}

function agency(overrides: Partial<AgencyPeriods> = {}): AgencyPeriods {
  return {
    agencyId: 'sta_wa',
    agencyName: 'Washington Department of Revenue',
    stateCode: 'WA',
    status: 'registered',
    filingFrequency: 'quarterly',
    dueDay: 25,
    reportingBasis: 'accrual',
    periods: [
      period({
        key: 'k-june',
        periodStart: '2026-04-01',
        periodEnd: '2026-06-30',
        dueDate: '2026-07-25',
        state: 'paid',
        unfiled: false,
        daysUntilDue: -75,
        return: {
          id: 'txr_q2',
          status: 'paid',
          totalDue: 701.5,
          filedAt: '2026-07-20T10:00:00.000Z',
          paidAt: '2026-07-21T10:00:00.000Z',
          confirmationNumber: 'WA-Q2',
        },
        amendments: [{ id: 'txr_q2a', status: 'calculated', totalDue: 20, filedAt: null, paidAt: null, confirmationNumber: null }],
      }),
      period(),
      period({ key: 'k-dec', periodStart: '2026-10-01', periodEnd: '2026-12-31', dueDate: '2027-01-25', state: 'in_progress', daysUntilDue: 109 }),
      period({ key: 'k-mar', periodStart: '2027-01-01', periodEnd: '2027-03-31', dueDate: '2027-04-25', state: 'upcoming', daysUntilDue: 199 }),
    ],
    ...overrides,
  };
}

const periods = (agencies: AgencyPeriods[]): PeriodsResponse => ({ today: '2026-10-08', from: '2025-10-08', to: '2027-01-08', agencies });

beforeAll(installPointerPolyfills);

beforeEach(() => {
  api.get.mockReset();
  api.post.mockReset();
  navigate.mockReset();
  permissions.allowed = new Set(['taxes:read', 'taxes:create']);
  api.get.mockResolvedValue({ data: periods([agency()]) });
  api.post.mockResolvedValue({ data: { id: 'txr_new' } });
});

describe('Returns page', () => {
  it('lists the periods of each agency, newest first, with the window the server used', async () => {
    renderWithProviders(<SalesTaxReturnsPage />);

    const table = await screen.findByTestId('agency-periods-WA');
    const rows = within(table).getAllByTestId(/^period-/).map((row) => row.getAttribute('data-testid'));
    expect(rows).toEqual(['period-2027-03-31', 'period-2026-12-31', 'period-2026-09-30', 'period-2026-06-30']);
    expect(screen.getByText('Showing 2025-10-08 to 2027-01-08')).toBeInTheDocument();
    expect(table).toHaveTextContent('Quarterly, due day 25, Accrual basis');
  });

  it('shows the due date with its countdown, and the state and return of each period', async () => {
    renderWithProviders(<SalesTaxReturnsPage />);

    const due = await screen.findByTestId('period-2026-09-30');
    expect(due).toHaveTextContent('Due in 17 days');
    expect(due).toHaveTextContent('Due');
    expect(due).toHaveTextContent('No return yet');

    const paid = screen.getByTestId('period-2026-06-30');
    expect(paid).toHaveTextContent('Paid');
    expect(paid).toHaveTextContent('$701.50');
    expect(paid).toHaveTextContent('Confirmation WA-Q2');
    // A filed period needs no countdown.
    expect(paid).not.toHaveTextContent('overdue');
    expect(within(paid).getByRole('link', { name: 'Amended' })).toHaveAttribute('href', '/weldbooks/sales-tax/returns/txr_q2a');
    expect(within(paid).getByRole('link', { name: 'Open' })).toHaveAttribute('href', '/weldbooks/sales-tax/returns/txr_q2');
  });

  it('opens a return for a period that has none', async () => {
    renderWithProviders(<SalesTaxReturnsPage />);
    const user = userEvent.setup();

    const row = await screen.findByTestId('period-2026-09-30');
    await user.click(within(row).getByRole('button', { name: 'Open return' }));

    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith('/tax-returns', { agencyId: 'sta_wa', periodStart: '2026-07-01', periodEnd: '2026-09-30' }),
    );
    await waitFor(() =>
      expect(navigate).toHaveBeenCalledWith({ to: '/weldbooks/sales-tax/returns/$id', params: { id: 'txr_new' } }),
    );
  });

  it('does not offer a return for a period that has not started', async () => {
    renderWithProviders(<SalesTaxReturnsPage />);

    const upcoming = await screen.findByTestId('period-2027-03-31');
    expect(within(upcoming).queryByRole('button', { name: 'Open return' })).not.toBeInTheDocument();
  });

  it('does not offer to open returns without the create permission', async () => {
    permissions.allowed = new Set(['taxes:read']);
    renderWithProviders(<SalesTaxReturnsPage />);

    await screen.findByTestId('period-2026-09-30');
    expect(screen.queryByRole('button', { name: 'Open return' })).not.toBeInTheDocument();
  });

  it('filters by status', async () => {
    renderWithProviders(<SalesTaxReturnsPage />);
    const user = userEvent.setup();

    await screen.findByTestId('period-2026-09-30');
    await user.click(screen.getByLabelText('Status'));
    await user.click(await screen.findByRole('option', { name: 'Needs attention' }));

    expect(screen.getByTestId('period-2026-09-30')).toBeInTheDocument();
    expect(screen.queryByTestId('period-2026-06-30')).not.toBeInTheDocument();
    expect(screen.queryByTestId('period-2027-03-31')).not.toBeInTheDocument();
  });

  it('asks the server for the dates the user picks', async () => {
    renderWithProviders(<SalesTaxReturnsPage />);
    const user = userEvent.setup();

    await screen.findByTestId('period-2026-09-30');
    await user.type(screen.getByLabelText('From'), '2026-01-01');

    await waitFor(() => expect(api.get).toHaveBeenCalledWith('/tax-returns/periods?from=2026-01-01'));
  });

  it('shows each agency on its own and can narrow to one', async () => {
    api.get.mockResolvedValue({
      data: periods([
        agency(),
        agency({ agencyId: 'sta_tx', agencyName: 'Texas Comptroller', stateCode: 'TX', periods: [period({ agencyId: 'sta_tx', key: 'tx', periodEnd: '2026-09-30', stateCode: 'TX' })] }),
      ]),
    });
    renderWithProviders(<SalesTaxReturnsPage />);
    const user = userEvent.setup();

    await screen.findByTestId('agency-periods-TX');
    await user.click(screen.getByLabelText('Agency'));
    await user.click(await screen.findByRole('option', { name: 'Texas Comptroller' }));

    expect(screen.getByTestId('agency-periods-TX')).toBeInTheDocument();
    expect(screen.queryByTestId('agency-periods-WA')).not.toBeInTheDocument();
  });

  it('says so when there are no periods', async () => {
    api.get.mockResolvedValue({ data: periods([]) });
    renderWithProviders(<SalesTaxReturnsPage />);
    expect(await screen.findByText('No periods to show')).toBeInTheDocument();
  });

  it('offers a retry when the periods cannot be loaded', async () => {
    api.get.mockRejectedValueOnce(Object.assign(new Error('Boom'), { status: 500, code: null, body: {} }));
    renderWithProviders(<SalesTaxReturnsPage />);
    const user = userEvent.setup();

    expect(await screen.findByText('Could not load this page')).toBeInTheDocument();
    api.get.mockResolvedValue({ data: periods([agency()]) });
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByTestId('agency-periods-WA')).toBeInTheDocument();
  });
});
