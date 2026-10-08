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
vi.mock('@tanstack/react-router', () => ({
  useRouterState: ({ select }: { select: (state: { location: { pathname: string } }) => unknown }) =>
    select({ location: { pathname: '/weldbooks/payment-runs/check-register' } }),
  Link: ({ children, to }: { children: ReactNode; to: string }) => <a href={to}>{children}</a>,
}));
vi.mock('@/lib/weldbooks/use-jurisdiction', () => ({ useCurrentJurisdiction: () => ({ code: 'US', isError: false }) }));
vi.mock('@/lib/weldbooks/use-weldbooks-format', async () => {
  const { testFormat } = await import('../test-utils');
  return { useWeldbooksFormat: () => testFormat };
});
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), info: vi.fn() }));
vi.mock('sonner', () => ({ toast }));

import CheckRegisterPage from './page';
import { installPointerPolyfills, renderWithProviders } from '../test-utils';

function row(number: string, status: string, overrides: Record<string, unknown> = {}) {
  return {
    paymentId: `pay_${number}`,
    checkNumber: number,
    date: '2026-10-09',
    payeeId: 'par_1',
    payeeName: `Payee ${number}`,
    amount: '100.00',
    status,
    bankAccountId: 'bnk_1',
    runId: 'prn_1',
    runStatus: 'approved',
    printedAt: null,
    voidedAt: null,
    reference: null,
    notes: null,
    ...overrides,
  };
}

function routes(rows: unknown[]) {
  api.get.mockImplementation(async (path: string) => {
    if (path.startsWith('/payment-runs/check-register')) {
      return {
        data: rows,
        summary: { printed: { count: 2, total: '200.00' }, voided: { count: 1, total: '100.00' } },
        pagination: { totalCount: rows.length, hasMore: false, cursor: null },
      };
    }
    if (path.startsWith('/bank-accounts')) return { data: [{ id: 'bnk_1', name: 'Operating', isActive: true, accountType: 'checking' }] };
    return { data: [] };
  });
}

beforeAll(installPointerPolyfills);

beforeEach(() => {
  for (const fn of Object.values(api)) fn.mockReset();
  toast.success.mockReset();
  permissions.allowed = new Set(['banking:read', 'banking:manage']);
});

describe('CheckRegisterPage', () => {
  it('lists every check by number with its status, voided ones included, and the totals per status', async () => {
    routes([
      row('001001', 'printed'),
      row('001002', 'voided', { voidedAt: '2026-10-10T09:00:00.000Z', notes: 'Voided 2026-10-10: Lost in the mail' }),
      row('001003', 'printed', { runId: null }),
    ]);
    renderWithProviders(<CheckRegisterPage />);

    const rows = await screen.findAllByRole('row');
    expect(within(rows[1]!).getByText('001001')).toBeInTheDocument();
    expect(within(rows[2]!).getByText('Voided')).toBeInTheDocument();
    expect(within(rows[2]!).getByText(/Voided at:/)).toBeInTheDocument();
    expect(within(rows[2]!).getByText('Voided 2026-10-10: Lost in the mail')).toBeInTheDocument();
    expect(within(rows[3]!).getAllByText('—').length).toBeGreaterThan(0);
    expect(screen.getByText('Printed:')).toBeInTheDocument();
    expect(screen.getByText(/200\.00/)).toBeInTheDocument();
    expect(screen.getByText('Checks: 3')).toBeInTheDocument();
  });

  it('shows the net a check is written for, with the gross and the withholding under it', async () => {
    routes([
      row('001001', 'printed', { amount: '2280.00', grossAmount: '3000.00', backupWithholdingAmount: '720.00' }),
      row('001002', 'printed', { grossAmount: '100.00' }),
    ]);
    renderWithProviders(<CheckRegisterPage />);

    const rows = await screen.findAllByRole('row');
    expect(within(rows[1]!).getByText('$2280.00')).toBeInTheDocument();
    expect(within(rows[1]!).getByText('Gross $3000.00, withheld $720.00')).toBeInTheDocument();
    expect(within(rows[2]!).queryByText(/withheld/)).not.toBeInTheDocument();
  });

  it('offers to void a check that is not voided or cleared yet, to people who manage banking', async () => {
    routes([row('001001', 'printed'), row('001002', 'voided'), row('001003', 'cleared')]);
    const user = userEvent.setup();
    renderWithProviders(<CheckRegisterPage />);

    await screen.findAllByRole('row');
    const voidButtons = screen.getAllByRole('button', { name: 'Void' });
    expect(voidButtons).toHaveLength(1);
    await user.click(voidButtons[0]!);
    expect(await screen.findByText('Void check 001001')).toBeInTheDocument();
  });

  it('has no void buttons without permission to manage banking', async () => {
    permissions.allowed = new Set(['banking:read']);
    routes([row('001001', 'printed')]);
    renderWithProviders(<CheckRegisterPage />);

    await screen.findAllByRole('row');
    expect(screen.queryByRole('button', { name: 'Void' })).not.toBeInTheDocument();
  });

  it('filters by status through the server', async () => {
    routes([row('001001', 'printed')]);
    const user = userEvent.setup();
    renderWithProviders(<CheckRegisterPage />);
    await screen.findAllByRole('row');

    await user.click(screen.getByRole('combobox', { name: 'Status' }));
    await user.click(await screen.findByRole('option', { name: 'Voided' }));
    await waitFor(() => expect(api.get).toHaveBeenCalledWith(expect.stringContaining('status=voided')));
  });

  it('explains an empty register', async () => {
    routes([]);
    renderWithProviders(<CheckRegisterPage />);
    expect(await screen.findByText('No checks yet')).toBeInTheDocument();
  });
});
