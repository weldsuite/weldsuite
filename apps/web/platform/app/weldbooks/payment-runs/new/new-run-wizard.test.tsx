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
const router = vi.hoisted(() => ({ navigate: vi.fn() }));
vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => router.navigate,
  Link: ({ children, to }: { children: ReactNode; to: string }) => <a href={to}>{children}</a>,
}));
vi.mock('@/lib/weldbooks/use-weldbooks-format', async () => {
  const { testFormat } = await import('../test-utils');
  return { useWeldbooksFormat: () => testFormat };
});
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), info: vi.fn() }));
vi.mock('sonner', () => ({ toast }));

import { NewRunWizard } from './new-run-wizard';
import { makeVendors } from './new-run-fixtures';
import { installPointerPolyfills, renderWithProviders } from '../test-utils';

const bankAccount = {
  id: 'bnk_1',
  name: 'Operating',
  iban: null,
  bankName: 'First Bank',
  currentBalance: '1000.00',
  currency: 'USD',
  isActive: true,
  accountType: 'checking',
  accountNumberLast4: '1234',
};

function settings(overrides: { checks?: { ready: boolean; missing: string[] }; ach?: { ready: boolean; missing: string[] }; requirePrenotes?: boolean } = {}) {
  return {
    bankAccountId: 'bnk_1',
    bankAccountName: 'Operating',
    bankName: 'First Bank',
    routingNumber: '021000021',
    accountNumberLast4: '1234',
    hasAccountNumber: true,
    nextCheckNumber: 1001,
    highestCheckNumberUsed: null,
    checkSettings: {},
    achSettings: { sameDayAllowed: true, requirePrenotes: overrides.requirePrenotes ?? false },
    effectiveAch: {},
    positivePayFormat: 'generic_csv',
    readiness: {
      checks: overrides.checks ?? { ready: true, missing: [] },
      ach: overrides.ach ?? { ready: true, missing: [] },
      positivePay: { ready: true, missing: [] },
    },
    layouts: [],
    positivePayFormats: [],
  };
}

const run = { id: 'prn_1', status: 'draft' };

function routes(options: Parameters<typeof settings>[0] = {}) {
  api.get.mockImplementation(async (path: string) => {
    if (path.startsWith('/bank-accounts')) return { data: [bankAccount] };
    if (path.startsWith('/payment-runs/settings/')) return { data: settings(options) };
    if (path.startsWith('/payment-runs/payable-bills')) {
      return { data: makeVendors(), pagination: { totalCount: 4, hasMore: false, cursor: null } };
    }
    return { data: [] };
  });
  api.post.mockResolvedValue({ data: run });
}

async function chooseBankAccount(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole('combobox', { name: 'Bank account' }));
  await user.click(await screen.findByRole('option', { name: /Operating/ }));
}

async function toBills(user: ReturnType<typeof userEvent.setup>, method: 'check' | 'ach') {
  await chooseBankAccount(user);
  if (method === 'ach') await user.click(screen.getByRole('radio', { name: /ACH/ }));
  const next = screen.getByRole('button', { name: 'Choose bills' });
  await waitFor(() => expect(next).toBeEnabled());
  await user.click(next);
  await screen.findByText('Acme Supplies');
}

beforeAll(installPointerPolyfills);

beforeEach(() => {
  for (const fn of Object.values(api)) fn.mockReset();
  router.navigate.mockReset();
  router.navigate.mockResolvedValue(undefined);
  toast.success.mockReset();
  toast.error.mockReset();
  permissions.allowed = new Set(['banking:read', 'banking:create', 'banking:manage', 'bills:read']);
  routes();
});

describe('NewRunWizard', () => {
  it('builds the items of a check run from the picked bills and their amounts', async () => {
    const user = userEvent.setup();
    renderWithProviders(<NewRunWizard />);
    await toBills(user, 'check');

    await user.click(screen.getByRole('checkbox', { name: 'Select all bills of Acme Supplies' }));
    const amount = screen.getByRole('textbox', { name: 'Amount to pay on bill INV-b1' });
    await user.clear(amount);
    await user.type(amount, '60');
    // A held vendor is fine on a check run: the bank details do not matter.
    await user.click(screen.getByRole('checkbox', { name: 'Select bill INV-b3' }));

    expect(screen.getByText(/Bills selected: 3. Vendors: 2./)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Review' }));
    await user.click(await screen.findByRole('button', { name: 'Create draft' }));

    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/payment-runs', expect.anything()));
    expect(api.post).toHaveBeenCalledWith('/payment-runs', {
      bankAccountId: 'bnk_1',
      method: 'check',
      paymentDate: '2026-10-08',
      requiredApprovals: 1,
      items: [
        { billId: 'b1', amount: 60 },
        { billId: 'b2', amount: 250.5 },
        { billId: 'b3', amount: 80 },
      ],
    });
    await waitFor(() => expect(router.navigate).toHaveBeenCalledWith({ to: '/weldbooks/payment-runs/$id', params: { id: 'prn_1' } }));
  });

  it('blocks vendors with bank detail holds and bills already in a run on an ACH run', async () => {
    const user = userEvent.setup();
    renderWithProviders(<NewRunWizard />);
    await toBills(user, 'ach');

    expect(screen.getByRole('checkbox', { name: 'Select all bills of Brightline LLC' })).toBeDisabled();
    expect(screen.getByRole('checkbox', { name: 'Select bill INV-b3' })).toBeDisabled();
    expect(screen.getByRole('checkbox', { name: 'Select all bills of Cobalt Co' })).toBeDisabled();
    expect(screen.getByText('Bank details changed')).toBeInTheDocument();
    expect(screen.getByText('No bank details')).toBeInTheDocument();
    // The bill in another run is blocked, its sibling is not.
    expect(screen.getByRole('checkbox', { name: 'Select bill INV-b5' })).toBeDisabled();
    expect(screen.getByRole('checkbox', { name: 'Select bill INV-b6' })).toBeEnabled();
    expect(screen.getByText('In another run')).toBeInTheDocument();

    await user.click(screen.getByRole('checkbox', { name: 'Select all bills of Delta Freight' }));
    expect(screen.getByRole('checkbox', { name: 'Select bill INV-b5' })).not.toBeChecked();
    expect(screen.getByText(/Bills selected: 1. Vendors: 1./)).toBeInTheDocument();
  });

  it('creates an ACH run with two approvals, leaves the SEC code to the server and submits it when asked', async () => {
    const user = userEvent.setup();
    renderWithProviders(<NewRunWizard />);
    await toBills(user, 'ach');

    await user.click(screen.getByRole('checkbox', { name: 'Select all bills of Acme Supplies' }));
    await user.click(screen.getByRole('button', { name: 'Review' }));
    await user.click(await screen.findByRole('button', { name: 'Create and submit for approval' }));

    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/payment-runs/prn_1/submit'));
    expect(api.post).toHaveBeenCalledWith('/payment-runs', {
      bankAccountId: 'bnk_1',
      method: 'ach',
      paymentDate: '2026-10-08',
      requiredApprovals: 2,
      items: [
        { billId: 'b1', amount: 100 },
        { billId: 'b2', amount: 250.5 },
      ],
      secCode: null,
      sameDay: false,
    });
  });

  it('shows backup withholding as figures worked out from what is picked, and still sends the gross', async () => {
    api.get.mockImplementation(async (path: string) => {
      if (path.startsWith('/bank-accounts')) return { data: [bankAccount] };
      if (path.startsWith('/payment-runs/settings/')) return { data: settings() };
      const vendors = makeVendors();
      vendors[0]!.backupWithholding = { applies: true, reason: 'no_tin', rate: 0.24, amount: '84.12', net: '266.38' };
      return { data: vendors, pagination: { totalCount: 4, hasMore: false, cursor: null } };
    });
    const user = userEvent.setup();
    renderWithProviders(<NewRunWizard />);
    await toBills(user, 'check');

    expect(screen.getByText('Backup withholding 24%')).toBeInTheDocument();
    expect(screen.getByText(/24% of what you pay is kept back and booked to Backup Withholding Payable/)).toBeInTheDocument();
    // It is a note, not a hold: the vendor can be picked and nothing says it is blocked.
    const vendorBox = screen.getByRole('checkbox', { name: 'Select all bills of Acme Supplies' });
    expect(vendorBox).toBeEnabled();

    await user.click(screen.getByRole('checkbox', { name: 'Select bill INV-b1' }));
    // 24% of $100.00.
    expect(screen.getByText('Picked: $100.00. Withheld: $24.00. The vendor is paid $76.00.')).toBeInTheDocument();
    expect(screen.getByText('Backup withholding $24.00. Vendors are paid $76.00.')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Review' }));
    expect(await screen.findByText('Backup withholding is taken out of some payments')).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'Gross' })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'Withheld' })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'Net paid' })).toBeInTheDocument();
    // The vendor's row and the total.
    expect(screen.getAllByText('-$24.00', { selector: 'td' })).toHaveLength(2);

    await user.click(screen.getByRole('button', { name: 'Create draft' }));
    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith('/payment-runs', {
        bankAccountId: 'bnk_1',
        method: 'check',
        paymentDate: '2026-10-08',
        requiredApprovals: 1,
        items: [{ billId: 'b1', amount: 100 }],
      }),
    );
  });

  it('keeps Review off until a bill is picked and while an amount is wrong', async () => {
    const user = userEvent.setup();
    renderWithProviders(<NewRunWizard />);
    await toBills(user, 'check');

    const review = screen.getByRole('button', { name: 'Review' });
    expect(review).toBeDisabled();
    await user.click(screen.getByRole('checkbox', { name: 'Select bill INV-b1' }));
    expect(review).toBeEnabled();

    const amount = screen.getByRole('textbox', { name: 'Amount to pay on bill INV-b1' });
    await user.clear(amount);
    await user.type(amount, '500');
    expect(screen.getByText('More than the open balance.')).toBeInTheDocument();
    expect(review).toBeDisabled();
  });

  it('does not let a check run start before the next check number is set', async () => {
    routes({ checks: { ready: false, missing: ['nextCheckNumber'] } });
    const user = userEvent.setup();
    renderWithProviders(<NewRunWizard />);
    await chooseBankAccount(user);

    expect(await screen.findByText('The next check number')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Choose bills' })).toBeDisabled();
  });

  it('warns about a prenote when the bank account asks for them', async () => {
    routes({ requirePrenotes: true });
    api.get.mockImplementation(async (path: string) => {
      if (path.startsWith('/bank-accounts')) return { data: [bankAccount] };
      if (path.startsWith('/payment-runs/settings/')) return { data: settings({ requirePrenotes: true }) };
      const vendors = makeVendors();
      vendors[0]!.ach = { ...vendors[0]!.ach!, prenote: 'needed' };
      return { data: vendors, pagination: { totalCount: 4, hasMore: false, cursor: null } };
    });
    const user = userEvent.setup();
    renderWithProviders(<NewRunWizard />);
    await toBills(user, 'ach');

    expect(screen.getByText('Prenote needed')).toBeInTheDocument();
  });
});
