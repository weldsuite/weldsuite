import type { ReactNode } from 'react';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), delete: vi.fn() }));
vi.mock('@/lib/api/weldbooks-client', () => ({ weldbooksApi: api, setWeldbooksEntityId: vi.fn() }));
const permissions = vi.hoisted(() => ({ allowed: new Set<string>() }));
vi.mock('@weldsuite/permissions/react', () => ({
  usePermissions: () => ({ can: (permission: string) => permissions.allowed.has(permission) }),
}));
vi.mock('@tanstack/react-router', () => ({
  useRouterState: ({ select }: { select: (state: { location: { pathname: string } }) => unknown }) =>
    select({ location: { pathname: '/weldbooks/payment-runs/positive-pay' } }),
  Link: ({ children, to }: { children: ReactNode; to: string }) => <a href={to}>{children}</a>,
}));
vi.mock('@/lib/weldbooks/use-jurisdiction', () => ({ useCurrentJurisdiction: () => ({ code: 'US', isError: false }) }));
vi.mock('@/lib/weldbooks/use-weldbooks-format', async () => {
  const { testFormat } = await import('../test-utils');
  return { useWeldbooksFormat: () => testFormat };
});
const files = vi.hoisted(() => ({ download: vi.fn() }));
vi.mock('@/lib/weldbooks/download', () => ({ downloadBlob: files.download }));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), info: vi.fn() }));
vi.mock('sonner', () => ({ toast }));

import PositivePayPage from './page';
import { installPointerPolyfills, renderWithProviders } from '../test-utils';

const operating = { id: 'bnk_1', name: 'Operating', isActive: true, accountType: 'checking', accountNumberLast4: '6789' };

const formats = [
  { id: 'generic_csv', label: 'Generic CSV', kind: 'csv', documentation: 'generic', needsBankSpec: false, note: 'n' },
  { id: 'chase', label: 'Chase (ACCESS)', kind: 'csv', documentation: 'none', needsBankSpec: true, note: 'Template.' },
];

function settings(positivePayReady = true) {
  return {
    bankAccountId: 'bnk_1',
    positivePayFormat: 'generic_csv',
    readiness: {
      checks: { ready: true, missing: [] },
      ach: { ready: true, missing: [] },
      positivePay: positivePayReady ? { ready: true, missing: [] } : { ready: false, missing: ['accountNumber'] },
    },
  };
}

function routes(positivePayReady = true) {
  api.get.mockImplementation(async (path: string) => {
    if (path.startsWith('/bank-accounts')) return { data: [operating] };
    if (path === '/payment-runs/positive-pay/formats') return { data: formats, pagination: { totalCount: 2, hasMore: false, cursor: null } };
    if (path === '/payment-runs/settings/bnk_1') return { data: settings(positivePayReady) };
    if (path.startsWith('/payment-runs/positive-pay?')) {
      return {
        data: {
          fileName: 'positive-pay-2026-10-08.csv',
          content: 'Account Number,Check Number\n123456789,1001',
          format: 'generic_csv',
          counts: { records: 3, issued: 2, voided: 1, totalIssued: '350.50', totalVoided: '80.00' },
          warnings: [{ code: 'payee_trimmed', message: 'Payee of check 1002 was cut to 40 characters.', checkNumber: '1002' }],
        },
      };
    }
    return { data: [] };
  });
}

beforeAll(installPointerPolyfills);

beforeEach(() => {
  for (const fn of Object.values(api)) fn.mockReset();
  files.download.mockReset();
  toast.success.mockReset();
  permissions.allowed = new Set(['banking:read', 'banking:manage']);
  routes();
});

describe('PositivePayPage', () => {
  it('asks for the file of the only bank account, for today, in its default format', async () => {
    const user = userEvent.setup();
    renderWithProviders(<PositivePayPage />);

    const generate = await screen.findByRole('button', { name: 'Make and download file' });
    await waitFor(() => expect(generate).toBeEnabled());
    await user.click(generate);

    await waitFor(() => expect(files.download).toHaveBeenCalledTimes(1));
    expect(files.download.mock.calls[0]?.[1]).toBe('positive-pay-2026-10-08.csv');
    expect(api.get).toHaveBeenCalledWith('/payment-runs/positive-pay?bankAccountId=bnk_1&from=2026-10-08&to=2026-10-08');
  });

  it('shows the counts and warnings of the file, never the file itself', async () => {
    const user = userEvent.setup();
    renderWithProviders(<PositivePayPage />);
    const generate = await screen.findByRole('button', { name: 'Make and download file' });
    await waitFor(() => expect(generate).toBeEnabled());
    await user.click(generate);

    expect(await screen.findByText('positive-pay-2026-10-08.csv')).toBeInTheDocument();
    expect(screen.getByText('2 · $350.50')).toBeInTheDocument();
    expect(screen.getByText('1 · $80.00')).toBeInTheDocument();
    expect(screen.getByText('Payee of check 1002 was cut to 40 characters.')).toBeInTheDocument();
    expect(screen.queryByText(/123456789,1001/)).not.toBeInTheDocument();
  });

  it('lists what the bank account still needs instead of making the file', async () => {
    routes(false);
    renderWithProviders(<PositivePayPage />);

    expect(await screen.findByText("The bank account's account number")).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Make and download file' })).toBeDisabled();
  });

  it('shows the problems the server found in the file', async () => {
    api.get.mockImplementation(async (path: string) => {
      if (path.startsWith('/bank-accounts')) return { data: [operating] };
      if (path === '/payment-runs/positive-pay/formats') return { data: formats, pagination: { totalCount: 2, hasMore: false, cursor: null } };
      if (path === '/payment-runs/settings/bnk_1') return { data: settings() };
      throw Object.assign(new Error('invalid'), {
        status: 422,
        code: 'POSITIVE_PAY_INVALID',
        body: { error: { code: 'POSITIVE_PAY_INVALID', details: { errors: [{ code: 'no_checks', message: 'There are no checks in this range.' }], warnings: [] } } },
      });
    });
    const user = userEvent.setup();
    renderWithProviders(<PositivePayPage />);
    const generate = await screen.findByRole('button', { name: 'Make and download file' });
    await waitFor(() => expect(generate).toBeEnabled());
    await user.click(generate);

    expect(await screen.findByText('The Positive Pay file could not be made')).toBeInTheDocument();
    expect(screen.getByText('There are no checks in this range.')).toBeInTheDocument();
    expect(files.download).not.toHaveBeenCalled();
  });

  it('does not offer the file without permission to manage banking', async () => {
    permissions.allowed = new Set(['banking:read']);
    renderWithProviders(<PositivePayPage />);
    expect(await screen.findByText(/need permission to manage banking/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Make and download file' })).toBeDisabled();
  });

  it('blocks an end date before the start date', async () => {
    const user = userEvent.setup();
    renderWithProviders(<PositivePayPage />);
    const to = await screen.findByLabelText('To');
    await user.clear(to);
    await user.type(to, '2026-10-01');

    expect(screen.getByText('Enter two valid dates, the first not after the second.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Make and download file' })).toBeDisabled();
  });
});
