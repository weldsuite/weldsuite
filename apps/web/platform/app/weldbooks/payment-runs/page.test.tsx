import type { ReactNode } from 'react';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), delete: vi.fn() }));
vi.mock('@/lib/api/weldbooks-client', () => ({ weldbooksApi: api, setWeldbooksEntityId: vi.fn() }));
const permissions = vi.hoisted(() => ({ allowed: new Set<string>() }));
vi.mock('@weldsuite/permissions/react', () => ({
  usePermissions: () => ({ can: (permission: string) => permissions.allowed.has(permission) }),
}));
const router = vi.hoisted(() => ({ navigate: vi.fn(), code: 'US' as string | null }));
vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => router.navigate,
  useRouterState: ({ select }: { select: (state: { location: { pathname: string } }) => unknown }) =>
    select({ location: { pathname: '/weldbooks/payment-runs' } }),
  Link: ({ children, to, ...rest }: { children: ReactNode; to: string; 'aria-current'?: 'page' }) => (
    <a href={to} aria-current={rest['aria-current']}>
      {children}
    </a>
  ),
}));
vi.mock('@/lib/weldbooks/use-jurisdiction', () => ({ useCurrentJurisdiction: () => ({ code: router.code, isError: false }) }));
vi.mock('@/lib/weldbooks/use-weldbooks-format', async () => {
  const { testFormat } = await import('./test-utils');
  return { useWeldbooksFormat: () => testFormat };
});

import PaymentRunsPage from './page';
import { installPointerPolyfills, renderWithProviders } from './test-utils';

const at = '2026-10-08T10:00:00.000Z';

function run(overrides: Record<string, unknown> = {}) {
  return {
    id: 'prn_1',
    bankAccountId: 'bnk_1',
    bankAccountName: 'Operating',
    method: 'ach',
    status: 'pending_approval',
    paymentDate: '2026-10-09',
    secCode: null,
    sameDay: true,
    totalAmount: '350.50',
    paymentCount: 2,
    requiredApprovals: 2,
    approvalCount: 1,
    billCount: 3,
    heldVendorCount: 1,
    fileName: null,
    fileGeneratedAt: null,
    createdBy: 'user_a',
    createdAt: at,
    updatedAt: at,
    notes: null,
    ...overrides,
  };
}

function routes(runs: unknown[]) {
  api.get.mockImplementation(async (path: string) => {
    if (path.startsWith('/payment-runs')) return { data: runs, pagination: { totalCount: runs.length, hasMore: false, cursor: null } };
    if (path.startsWith('/bank-accounts')) return { data: [{ id: 'bnk_1', name: 'Operating', isActive: true, accountType: 'checking' }] };
    return { data: [] };
  });
}

beforeAll(installPointerPolyfills);

beforeEach(() => {
  for (const fn of Object.values(api)) fn.mockReset();
  router.navigate.mockReset();
  router.code = 'US';
  permissions.allowed = new Set(['banking:read', 'banking:create', 'bills:read']);
});

describe('PaymentRunsPage', () => {
  it('lists the runs with their method, approvals, holds and totals', async () => {
    routes([run(), run({ id: 'prn_2', method: 'check', status: 'draft', sameDay: false, heldVendorCount: 0, totalAmount: '10.00' })]);
    renderWithProviders(<PaymentRunsPage />);

    const rows = await screen.findAllByRole('row');
    const first = within(rows[1]!);
    expect(first.getByText('ACH')).toBeInTheDocument();
    expect(first.getByText('Same Day ACH')).toBeInTheDocument();
    expect(first.getByText('1 of 2')).toBeInTheDocument();
    expect(first.getByText('Pending approval')).toBeInTheDocument();
    expect(first.getByText('1 on hold')).toBeInTheDocument();
    expect(first.getByText('$350.50')).toBeInTheDocument();
    const second = within(rows[2]!);
    expect(second.getByText('Draft')).toBeInTheDocument();
    expect(second.queryByText(/on hold/)).not.toBeInTheDocument();
    expect(screen.getByText('Runs: 2')).toBeInTheDocument();
  });

  it('opens a run when its row is clicked', async () => {
    routes([run()]);
    const user = userEvent.setup();
    renderWithProviders(<PaymentRunsPage />);

    await user.click((await screen.findAllByRole('row'))[1]!);
    expect(router.navigate).toHaveBeenCalledWith({ to: '/weldbooks/payment-runs/$id', params: { id: 'prn_1' } });
  });

  it('offers the first run when there is none, to people who can create one', async () => {
    routes([]);
    renderWithProviders(<PaymentRunsPage />);

    expect(await screen.findByText('No payment runs yet')).toBeInTheDocument();
    expect(screen.getAllByRole('link', { name: /New payment run/ }).length).toBeGreaterThan(0);
  });

  it('hides the new-run buttons without permission to create', async () => {
    permissions.allowed = new Set(['banking:read', 'bills:read']);
    routes([]);
    renderWithProviders(<PaymentRunsPage />);

    expect(await screen.findByText('No payment runs yet')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /New payment run/ })).not.toBeInTheDocument();
  });

  it('filters by status through the server', async () => {
    routes([run()]);
    const user = userEvent.setup();
    renderWithProviders(<PaymentRunsPage />);
    await screen.findAllByRole('row');

    await user.click(screen.getByRole('combobox', { name: 'Status' }));
    await user.click(await screen.findByRole('option', { name: 'Completed' }));
    await waitFor(() => expect(api.get).toHaveBeenCalledWith(expect.stringContaining('status=completed')));
  });

  it('shows the section tabs and marks the current one', async () => {
    routes([run()]);
    renderWithProviders(<PaymentRunsPage />);
    await screen.findAllByRole('row');
    const nav = screen.getByRole('navigation', { name: 'Vendor payments' });
    expect(within(nav).getByRole('link', { name: 'Payment runs' })).toHaveAttribute('aria-current', 'page');
    for (const name of ['Check register', 'Positive Pay', 'Payment settings']) {
      expect(within(nav).getByRole('link', { name })).not.toHaveAttribute('aria-current');
    }
  });

  it('says the screen is for US entities when the entity is not one', async () => {
    router.code = 'NL';
    routes([run()]);
    renderWithProviders(<PaymentRunsPage />);

    expect(await screen.findByText('Vendor payment runs are for US entities')).toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  it('says so when the runs cannot be loaded, and can try again', async () => {
    api.get.mockRejectedValue(new Error('boom'));
    renderWithProviders(<PaymentRunsPage />);
    expect(await screen.findByText('Could not load this. Try again in a moment.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });
});
