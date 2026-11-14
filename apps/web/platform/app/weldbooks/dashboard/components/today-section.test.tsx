import { describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import type { Dashboard } from '@/lib/api/domains/weldbooks';

vi.mock('@/lib/i18n/provider', async () => {
  const { en: english } = await import('@weldsuite/i18n/locales/en');
  return { useI18n: () => ({ t: english, language: 'en' }) };
});
vi.mock('@tanstack/react-router', async () => {
  const { RouteLink } = await import('@/app/weldbooks/invoices/components/test-utils');
  return { Link: RouteLink };
});
vi.mock('./use-chart-format', () => {
  const format = {
    formatMoney: (value: number) => `€${value.toFixed(2)}`,
    compactMoney: (value: number) => String(value),
    monthShort: (month: string) => month,
    monthYear: (month: string) => month,
  };
  return { useChartFormat: () => format };
});
// The chart is Recharts; what matters here is whether it is told it draws sample data.
vi.mock('./comparison-line-chart', () => ({
  ComparisonLineChart: ({ sample }: { sample?: boolean }) => <div data-testid="hero-chart" data-sample={String(sample)} />,
}));

import { TodaySection } from './today-section';

function dashboard(extra: Partial<Dashboard> = {}): Dashboard {
  return {
    currency: 'EUR',
    bankAccounts: [
      { id: 'ba_1', name: 'Operating', iban: null, currentBalance: '700.00', currency: 'EUR' },
      { id: 'ba_2', name: 'Savings', iban: null, currentBalance: '300.00', currency: 'EUR' },
    ],
    ...extra,
  } as Dashboard;
}

const cashCard = () => screen.getByRole('link', { name: /Cash balance/i }).parentElement as HTMLElement;

describe('TodaySection cash balance', () => {
  it('shows the ledger balance of the money accounts when the API has one', () => {
    render(<TodaySection dashboard={dashboard({ cashBalance: '1450.25' })} />);
    expect(within(cashCard()).getByText('€1450.25')).toBeInTheDocument();
  });

  it('shows a ledger balance of zero rather than falling back to the bank accounts', () => {
    render(<TodaySection dashboard={dashboard({ cashBalance: '0' })} />);
    expect(within(cashCard()).getByText('€0.00')).toBeInTheDocument();
  });

  it('adds up the bank accounts on an older API without a cash balance', () => {
    render(<TodaySection dashboard={dashboard()} />);
    expect(within(cashCard()).getByText('€1000.00')).toBeInTheDocument();
  });

  it('tells the chart when it draws the sample trend of a workspace with nothing booked', () => {
    render(<TodaySection dashboard={dashboard()} />);
    expect(screen.getByTestId('hero-chart')).toHaveAttribute('data-sample', 'true');
  });
});
