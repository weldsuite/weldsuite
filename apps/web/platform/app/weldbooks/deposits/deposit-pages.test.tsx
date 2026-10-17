import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';
import type { UndepositedPayment } from '@/lib/api/domains/weldbooks-banking';

const permissions = new Set(['banking:create']);
const jurisdiction = { code: 'US' as string | null };
const undeposited: { rows: UndepositedPayment[] | undefined } = { rows: [] };

vi.mock('@tanstack/react-router', () => ({
  Link: ({ to, children }: { to: string; children: React.ReactNode }) => <a href={to}>{children}</a>,
  useNavigate: () => vi.fn(),
}));
vi.mock('@weldsuite/permissions/react', () => ({
  usePermissions: () => ({ can: (permission: string) => permissions.has(permission) }),
}));
vi.mock('@/lib/weldbooks/use-jurisdiction', () => ({ useCurrentJurisdiction: () => ({ code: jurisdiction.code }) }));
vi.mock('@/lib/weldbooks/use-weldbooks-format', () => ({
  useWeldbooksFormat: () => ({
    formatMoney: (value: number | string) => `$${Number(value).toFixed(2)}`,
  }),
}));
vi.mock('@/hooks/queries/use-weldbooks-banking-queries', () => ({
  useUndepositedPayments: (options: { enabled?: boolean } = {}) => ({ data: options.enabled === false ? undefined : undeposited.rows }),
}));

import { UndepositedFundsCallout } from '../banking/components/undeposited-funds-callout';
import { renderWithProviders } from '../banking/components/test-utils';

const payment = (id: string, amount: number): UndepositedPayment => ({
  paymentId: id,
  date: '2026-01-05',
  paymentMethod: 'check',
  checkNumber: null,
  reference: null,
  currency: 'USD',
  paymentAmount: amount.toFixed(2),
  amount,
  contactId: 'c1',
  contactName: 'Acme',
  journalEntryId: 'je1',
});

describe('UndepositedFundsCallout', () => {
  beforeEach(() => {
    permissions.clear();
    permissions.add('banking:create');
    jurisdiction.code = 'US';
  });

  it('shows how many payments wait in Undeposited Funds and their total, with a link to deposit them', () => {
    undeposited.rows = [payment('a', 1200), payment('b', 350.5)];
    renderWithProviders(<UndepositedFundsCallout />);

    expect(screen.getByTestId('undeposited-funds-callout')).toHaveTextContent('2 payments ($1550.50) are waiting in Undeposited Funds.');
    expect(screen.getByRole('link', { name: 'Make a deposit' })).toHaveAttribute('href', '/weldbooks/deposits/new');
  });

  it('uses the singular for one payment', () => {
    undeposited.rows = [payment('a', 20)];
    renderWithProviders(<UndepositedFundsCallout />);
    expect(screen.getByTestId('undeposited-funds-callout')).toHaveTextContent('1 payment ($20.00) is waiting in Undeposited Funds.');
  });

  it('renders nothing when there is nothing to deposit, or for an entity without Undeposited Funds', () => {
    undeposited.rows = [];
    const { unmount } = renderWithProviders(<UndepositedFundsCallout />);
    expect(screen.queryByTestId('undeposited-funds-callout')).not.toBeInTheDocument();
    unmount();

    undeposited.rows = [payment('a', 20)];
    jurisdiction.code = 'NL';
    renderWithProviders(<UndepositedFundsCallout />);
    expect(screen.queryByTestId('undeposited-funds-callout')).not.toBeInTheDocument();
  });

  it('leaves out the deposit button for someone who cannot create deposits', () => {
    permissions.clear();
    undeposited.rows = [payment('a', 20)];
    renderWithProviders(<UndepositedFundsCallout />);
    expect(screen.queryByRole('link', { name: 'Make a deposit' })).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'View deposits' })).toBeInTheDocument();
  });
});
