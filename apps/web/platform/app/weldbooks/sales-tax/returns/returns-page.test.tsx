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

/** The list row (a `group` div of the standard list) of the period that ends on `end`. */
async function periodRow(end: string): Promise<HTMLElement> {
  const row = (await screen.findByText(new RegExp(end))).closest<HTMLElement>('div.group');
  if (!row) throw new Error(`No list row for the period ending ${end}`);
  return row;
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

describe('Returns page', () => {
  it('lists the periods of each agency, newest first, with the window the server used', async () => {
    renderWithProviders(<SalesTaxReturnsPage />);

    await periodRow('2026-09-30');
    const labels = Array.from(document.querySelectorAll<HTMLElement>('div.group [data-row-overlay]')).map((button) =>
      button.getAttribute('aria-label'),
    );
    expect(labels).toEqual([
      'Washington Department of Revenue: 2027-03-31',
      'Washington Department of Revenue: 2026-12-31',
      'Washington Department of Revenue: 2026-09-30',
      'Washington Department of Revenue: 2026-06-30',
    ]);
    expect(screen.getByText('Showing 2025-10-08 to 2027-01-08')).toBeInTheDocument();
    expect(screen.getByText('Quarterly, due day 25, Accrual basis')).toBeInTheDocument();
  });

  it('shows the due date with its countdown, and the state and return of each period', async () => {
    renderWithProviders(<SalesTaxReturnsPage />);

    const due = await periodRow('2026-09-30');
    expect(due).toHaveTextContent('Due in 17 days');
    expect(due).toHaveTextContent('Due');
    expect(due).toHaveTextContent('No return yet');

    const paid = await periodRow('2026-06-30');
    expect(paid).toHaveTextContent('Paid');
    expect(paid).toHaveTextContent('$701.50');
    expect(paid.querySelector('[title="Confirmation WA-Q2"]')).not.toBeNull();
    // A filed period needs no countdown.
    expect(paid).not.toHaveTextContent('overdue');
    expect(within(paid).getByRole('link', { name: 'Amended' })).toHaveAttribute('href', '/weldbooks/sales-tax/returns/txr_q2a');
    expect(within(paid).getByRole('link', { name: 'Open' })).toHaveAttribute('href', '/weldbooks/sales-tax/returns/txr_q2');
  });

  it('opens a return for a period that has none', async () => {
    renderWithProviders(<SalesTaxReturnsPage />);
    const user = userEvent.setup();

    const row = await periodRow('2026-09-30');
    await user.click(within(row).getByRole('button', { name: 'Open return' }));

    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith('/tax-returns', { agencyId: 'sta_wa', periodStart: '2026-07-01', periodEnd: '2026-09-30' }),
    );
    await waitFor(() =>
      expect(navigate).toHaveBeenCalledWith({ to: '/weldbooks/sales-tax/returns/$id', params: { id: 'txr_new' } }),
    );
  });

  it('opens the return of a period from its row, and does nothing for a period without one', async () => {
    renderWithProviders(<SalesTaxReturnsPage />);
    const user = userEvent.setup();

    const paid = await periodRow('2026-06-30');
    await user.click(within(paid).getByRole('button', { name: 'Washington Department of Revenue: 2026-06-30' }));
    expect(navigate).toHaveBeenCalledWith({ to: '/weldbooks/sales-tax/returns/$id', params: { id: 'txr_q2' } });

    navigate.mockReset();
    const due = await periodRow('2026-09-30');
    await user.click(within(due).getByRole('button', { name: 'Washington Department of Revenue: 2026-09-30' }));
    expect(navigate).not.toHaveBeenCalled();
    expect(api.post).not.toHaveBeenCalled();
  });

  it('does not offer a return for a period that has not started', async () => {
    renderWithProviders(<SalesTaxReturnsPage />);

    const upcoming = await periodRow('2027-03-31');
    expect(within(upcoming).queryByRole('button', { name: 'Open return' })).not.toBeInTheDocument();
  });

  it('does not offer to open returns without the create permission', async () => {
    permissions.allowed = new Set(['taxes:read']);
    renderWithProviders(<SalesTaxReturnsPage />);

    await periodRow('2026-09-30');
    expect(screen.queryByRole('button', { name: 'Open return' })).not.toBeInTheDocument();
  });

  it('filters by status', async () => {
    renderWithProviders(<SalesTaxReturnsPage />);
    const user = userEvent.setup();

    await periodRow('2026-09-30');
    await addIsFilter(user, 'Status', 'Needs attention');

    expect(screen.getByText(/2026-09-30/)).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByText(/2026-06-30/)).not.toBeInTheDocument());
    expect(screen.queryByText(/2027-03-31/)).not.toBeInTheDocument();
  });

  it('asks the server for the dates the user picks', async () => {
    renderWithProviders(<SalesTaxReturnsPage />);
    const user = userEvent.setup();

    await periodRow('2026-09-30');
    await user.type(screen.getByLabelText('From'), '2026-01-01');

    await waitFor(() => expect(api.get).toHaveBeenCalledWith('/tax-returns/periods?from=2026-01-01'));
  });

  it('shows each agency as its own group and can narrow to one', async () => {
    api.get.mockResolvedValue({
      data: periods([
        agency(),
        agency({ agencyId: 'sta_tx', agencyName: 'Texas Comptroller', stateCode: 'TX', periods: [period({ agencyId: 'sta_tx', key: 'tx', periodEnd: '2026-09-30', stateCode: 'TX' })] }),
      ]),
    });
    renderWithProviders(<SalesTaxReturnsPage />);
    const user = userEvent.setup();

    expect(await screen.findByText('Texas Comptroller')).toBeInTheDocument();
    expect(screen.getByText('Washington Department of Revenue')).toBeInTheDocument();
    await addIsFilter(user, 'Agency', 'Texas Comptroller');

    await waitFor(() => expect(screen.queryByText('Washington Department of Revenue')).not.toBeInTheDocument());
    // The filter pill and the group header both name the agency; the one period left is Texas's.
    expect(screen.getByRole('button', { name: 'Texas Comptroller: 2026-09-30' })).toBeInTheDocument();
    expect(document.querySelectorAll('div.group [data-row-overlay]')).toHaveLength(1);
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
    expect(await periodRow('2026-09-30')).toBeInTheDocument();
  });
});
