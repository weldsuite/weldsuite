import { beforeEach, describe, expect, it, vi } from 'vitest';
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
  useRouterState: () => '/weldbooks/sales-tax',
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
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock('sonner', () => ({ toast }));
vi.mock('./shared/sales-tax-frame', () => ({
  SalesTaxFrame: ({ title, actions, children }: { title: string; actions?: React.ReactNode; children: React.ReactNode }) => (
    <div>
      <h1>{title}</h1>
      {actions}
      {children}
    </div>
  ),
}));

import SalesTaxOverviewPage from './page';
import { nextPeriodAction } from './overview/agency-overview-card';
import { makeAgencyOverview, renderWithProviders } from './shared/test-support';
import type { SalesTaxOverview } from '@/lib/api/domains/weldbooks-sales-tax-center';

function overview(overrides: Partial<SalesTaxOverview> = {}): SalesTaxOverview {
  return {
    today: '2026-10-08',
    agencies: [makeAgencyOverview()],
    totals: { estimatedTaxDue: 824.38, overduePeriods: 0, dueWithin14Days: 0 },
    ...overrides,
  };
}

beforeEach(() => {
  api.get.mockReset();
  api.post.mockReset();
  navigate.mockReset();
  toast.error.mockReset();
  permissions.allowed = new Set(['taxes:read', 'taxes:create']);
  api.get.mockResolvedValue({ data: overview() });
  api.post.mockResolvedValue({ data: { id: 'txr_new' } });
});

describe('nextPeriodAction', () => {
  const next = makeAgencyOverview().nextPeriod!;

  it('continues a period that has a return', () => {
    expect(nextPeriodAction({ ...next, returnId: 'txr_1', returnStatus: 'calculated' })).toBe('continue');
  });

  it('opens a return for a period that has started and has none', () => {
    expect(nextPeriodAction(next)).toBe('open');
    expect(nextPeriodAction({ ...next, state: 'overdue' })).toBe('open');
  });

  it('waits for a period that has not started', () => {
    expect(nextPeriodAction({ ...next, state: 'upcoming' })).toBe('upcoming');
  });

  it('has nothing to do for an agency without a period', () => {
    expect(nextPeriodAction(null)).toBe('none');
  });
});

describe('Sales Tax Center overview', () => {
  it('shows each agency with its next period, due date countdown and estimate', async () => {
    renderWithProviders(<SalesTaxOverviewPage />);

    const card = await screen.findByTestId('agency-card-WA');
    expect(within(card).getByText('Washington Department of Revenue')).toBeInTheDocument();
    expect(card).toHaveTextContent('2026-07-01 to 2026-09-30');
    expect(card).toHaveTextContent('Due 2026-10-25');
    expect(card).toHaveTextContent('Due in 17 days');
    expect(within(card).getByText('$824.38')).toBeInTheDocument();
    expect(card).toHaveTextContent('Sales tax $804.38, use tax $20.00');
    expect(card).toHaveTextContent('Nothing filed yet');
    expect(screen.getByText('Estimated tax due')).toBeInTheDocument();
  });

  it('flags overdue periods on the page and on the agency', async () => {
    api.get.mockResolvedValue({
      data: overview({
        agencies: [
          makeAgencyOverview({
            overduePeriods: 2,
            nextPeriod: { ...makeAgencyOverview().nextPeriod!, state: 'overdue', overdue: true, daysUntilDue: -5 },
          }),
        ],
        totals: { estimatedTaxDue: 824.38, overduePeriods: 2, dueWithin14Days: 0 },
      }),
    });
    renderWithProviders(<SalesTaxOverviewPage />);

    expect(await screen.findByText(/2 periods are overdue/)).toBeInTheDocument();
    const card = screen.getByTestId('agency-card-WA');
    expect(within(card).getByText('2 overdue')).toBeInTheDocument();
    expect(card).toHaveTextContent('5 days overdue');
  });

  it('opens the return of the next period with its dates and goes to it', async () => {
    renderWithProviders(<SalesTaxOverviewPage />);
    const user = userEvent.setup();

    await user.click(await screen.findByRole('button', { name: 'Open return' }));

    await waitFor(() => expect(api.post).toHaveBeenCalledTimes(1));
    expect(api.post).toHaveBeenCalledWith('/tax-returns', {
      agencyId: 'sta_wa',
      periodStart: '2026-07-01',
      periodEnd: '2026-09-30',
    });
    await waitFor(() =>
      expect(navigate).toHaveBeenCalledWith({ to: '/weldbooks/sales-tax/returns/$id', params: { id: 'txr_new' } }),
    );
  });

  it('goes to the return that already exists when the period was opened elsewhere (409)', async () => {
    api.post.mockRejectedValue(
      Object.assign(new Error('This period already has a return'), {
        status: 409,
        code: 'CONFLICT',
        body: { error: { code: 'CONFLICT', message: 'x', details: { returnId: 'txr_existing' } } },
      }),
    );
    renderWithProviders(<SalesTaxOverviewPage />);
    const user = userEvent.setup();

    await user.click(await screen.findByRole('button', { name: 'Open return' }));

    await waitFor(() =>
      expect(navigate).toHaveBeenCalledWith({ to: '/weldbooks/sales-tax/returns/$id', params: { id: 'txr_existing' } }),
    );
    expect(toast.error).not.toHaveBeenCalled();
  });

  it('says so when a return could not be opened', async () => {
    api.post.mockRejectedValue(Object.assign(new Error('No first period start'), { status: 400, code: 'BAD_REQUEST', body: {} }));
    renderWithProviders(<SalesTaxOverviewPage />);
    const user = userEvent.setup();

    await user.click(await screen.findByRole('button', { name: 'Open return' }));

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Could not open the return', { description: 'No first period start' }));
    expect(navigate).not.toHaveBeenCalled();
  });

  it('continues an open return instead of opening a new one', async () => {
    api.get.mockResolvedValue({
      data: overview({
        agencies: [
          makeAgencyOverview({
            nextPeriod: { ...makeAgencyOverview().nextPeriod!, returnId: 'txr_1', returnStatus: 'calculated' },
          }),
        ],
      }),
    });
    renderWithProviders(<SalesTaxOverviewPage />);

    const link = await screen.findByRole('link', { name: 'Continue' });
    expect(link).toHaveAttribute('href', '/weldbooks/sales-tax/returns/txr_1');
    expect(screen.queryByRole('button', { name: 'Open return' })).not.toBeInTheDocument();
  });

  it('does not offer to open a return to someone who cannot create one', async () => {
    permissions.allowed = new Set(['taxes:read']);
    renderWithProviders(<SalesTaxOverviewPage />);

    await screen.findByTestId('agency-card-WA');
    expect(screen.queryByRole('button', { name: 'Open return' })).not.toBeInTheDocument();
  });

  it('shows when the next period starts instead of a button', async () => {
    api.get.mockResolvedValue({
      data: overview({
        agencies: [
          makeAgencyOverview({ nextPeriod: { ...makeAgencyOverview().nextPeriod!, state: 'upcoming', periodStart: '2026-10-01' } }),
        ],
      }),
    });
    renderWithProviders(<SalesTaxOverviewPage />);

    expect(await screen.findByText('Starts 2026-10-01')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Open return' })).not.toBeInTheDocument();
  });

  it('shows what was filed last', async () => {
    api.get.mockResolvedValue({
      data: overview({
        agencies: [
          makeAgencyOverview({
            lastFiled: { returnId: 'txr_0', periodEnd: '2026-06-30', filedAt: '2026-07-20T10:00:00.000Z', totalDue: 701.5, status: 'paid' },
          }),
        ],
      }),
    });
    renderWithProviders(<SalesTaxOverviewPage />);

    const card = await screen.findByTestId('agency-card-WA');
    expect(within(card).getByRole('link', { name: 'Period ending 2026-06-30' })).toHaveAttribute('href', '/weldbooks/sales-tax/returns/txr_0');
    expect(card).toHaveTextContent('$701.50');
  });

  it('invites the user to set up agencies when there are none', async () => {
    api.get.mockResolvedValue({ data: overview({ agencies: [], totals: { estimatedTaxDue: 0, overduePeriods: 0, dueWithin14Days: 0 } }) });
    renderWithProviders(<SalesTaxOverviewPage />);

    expect(await screen.findByText('No registered agencies yet')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Set up agencies' })).toHaveAttribute('href', '/weldbooks/sales-tax/agencies');
  });

  it('offers a retry when the overview cannot be loaded', async () => {
    api.get.mockRejectedValueOnce(Object.assign(new Error('Boom'), { status: 500, code: null, body: {} }));
    renderWithProviders(<SalesTaxOverviewPage />);
    const user = userEvent.setup();

    expect(await screen.findByText('Could not load this page')).toBeInTheDocument();
    api.get.mockResolvedValue({ data: overview() });
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByTestId('agency-card-WA')).toBeInTheDocument();
  });
});
