import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { en } from '@weldsuite/i18n/locales/en';

const m = vi.hoisted(() => ({
  query: { data: undefined as unknown, isLoading: false, isError: false, refetch: vi.fn() },
}));

vi.mock('@tanstack/react-router', () => ({
  Link: ({ to, params, children }: { to: string; params?: Record<string, string>; children: React.ReactNode }) => (
    <a href={params ? to.replace('$bankAccountId', params.bankAccountId ?? '') : to}>{children}</a>
  ),
}));
vi.mock('@/lib/i18n/provider', async () => {
  const { en: locale } = await import('@weldsuite/i18n/locales/en');
  return { useI18n: () => ({ t: locale }) };
});
vi.mock('@/hooks/queries/use-weldbooks-banking-queries', () => ({ useBankAccounts: () => m.query }));
vi.mock('@/app/weldbooks/payment-runs/components/payment-runs-frame', () => ({
  UsOnlyGate: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

import PaymentSettingsListPage from './page';

const tp = en.weldbooksUs.payments;
const tl = tp.settings.list;

describe('Payment run settings list', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    m.query = { data: undefined, isLoading: false, isError: false, refetch: vi.fn() };
  });

  it('shows the title and subtitle', () => {
    m.query = { ...m.query, data: { data: [] } };
    render(<PaymentSettingsListPage />);
    expect(screen.getByRole('heading', { name: tl.title })).toBeTruthy();
    expect(screen.getByText(tl.subtitle)).toBeTruthy();
  });

  it('shows a loader while the accounts load', () => {
    m.query = { ...m.query, isLoading: true };
    render(<PaymentSettingsListPage />);
    expect(screen.queryByText(tl.emptyTitle)).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('shows an error with a retry', async () => {
    m.query = { ...m.query, isError: true };
    render(<PaymentSettingsListPage />);
    expect(screen.getByRole('alert').textContent).toBe(tp.common.loadFailed);
    await userEvent.click(screen.getByRole('button', { name: tp.common.retry }));
    expect(m.query.refetch).toHaveBeenCalled();
  });

  it('shows the empty state with a link to banking when no account can pay', () => {
    m.query = {
      ...m.query,
      data: { data: [{ id: 'ba_card', name: 'Card', accountType: 'credit_card' }, { id: 'ba_off', name: 'Closed', isActive: false }] },
    };
    render(<PaymentSettingsListPage />);
    expect(screen.getByText(tl.emptyTitle)).toBeTruthy();
    expect(screen.getByText(tl.emptyDescription)).toBeTruthy();
    expect(screen.getByRole('link', { name: tl.openBanking }).getAttribute('href')).toBe('/weldbooks/banking');
  });

  it('lists payable bank accounts with their bank and last digits, linking to each one', () => {
    m.query = {
      ...m.query,
      data: {
        data: [
          { id: 'ba_1', name: 'Operating', bankName: 'First Bank', accountNumberLast4: '4321', accountType: 'checking' },
          { id: 'ba_2', name: 'Savings', accountType: 'savings' },
          { id: 'ba_card', name: 'Visa', accountType: 'credit_card' },
        ],
      },
    };
    render(<PaymentSettingsListPage />);
    expect(screen.getByText('Operating')).toBeTruthy();
    expect(screen.getByText('First Bank ····4321')).toBeTruthy();
    expect(screen.getByText('Savings')).toBeTruthy();
    expect(screen.queryByText('Visa')).toBeNull();
    const links = screen.getAllByRole('link', { name: tl.open });
    expect(links.map((l) => l.getAttribute('href'))).toEqual([
      '/settings/apps/weldbooks/payment-runs/ba_1',
      '/settings/apps/weldbooks/payment-runs/ba_2',
    ]);
  });
});
