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
// The chart is Recharts; what matters here is the values it is given.
vi.mock('@weldsuite/ui/components/comparison-chart', () => ({
  ComparisonChart: ({ points }: { points: Array<{ value?: number; compareValue?: number }> }) => (
    <div data-testid="hero-chart" data-values={JSON.stringify(points.flatMap((p) => [p.value, p.compareValue]).filter((v) => v !== undefined))} />
  ),
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

  it('draws a workspace with nothing booked at zero: the figures and the lines', () => {
    render(<TodaySection dashboard={dashboard({ cashBalance: '1450.25' })} />);
    const values = JSON.parse(screen.getByTestId('hero-chart').dataset.values ?? '[]') as number[];
    expect(values.length).toBeGreaterThan(0);
    expect(values.every((v) => v === 0)).toBe(true);
    const thisYear = screen.getByRole('button', { name: 'Revenue' }).parentElement as HTMLElement;
    const lastYear = screen.getByText('Last year').parentElement as HTMLElement;
    expect(within(thisYear).getByText('€0.00')).toBeInTheDocument();
    expect(within(lastYear).getByText('€0.00')).toBeInTheDocument();
  });
});

describe('TodaySection tiles open filtered lists', () => {
  const tile = (name: RegExp) => screen.getByRole('link', { name });
  const withBalances = () =>
    dashboard({
      receivables: { outstanding: '900.00', outstandingCount: 3, overdue: '221.00', overdueCount: 2 },
      payables: { outstanding: '400.00', outstandingCount: 2, overdue: '0', overdueCount: 0 },
      pendingDocuments: 4,
    });

  it('opens the bank for the balance, the open invoices for To receive and the open bills for To pay', () => {
    render(<TodaySection dashboard={withBalances()} />);
    expect(tile(/^Cash balance$/i)).toHaveAttribute('href', '/weldbooks/banking');
    expect(tile(/^To receive$/i)).toHaveAttribute('href', '/weldbooks/invoices?show=open');
    expect(tile(/^To pay$/i)).toHaveAttribute('href', '/weldbooks/bills?show=open');
    expect(tile(/^Documents to process$/i)).toHaveAttribute('href', '/weldbooks/documents');
  });

  it('opens the overdue invoices from the overdue figure', () => {
    render(<TodaySection dashboard={withBalances()} />);
    expect(tile(/overdue/i)).toHaveAttribute('href', '/weldbooks/invoices?show=overdue');
  });

  it('is plain text, not a link, when nothing is overdue', () => {
    render(
      <TodaySection
        dashboard={dashboard({ receivables: { outstanding: '900.00', outstandingCount: 3, overdue: '0', overdueCount: 0 } })}
      />,
    );
    expect(screen.queryByRole('link', { name: /overdue/i })).not.toBeInTheDocument();
    expect(screen.getByText('3 open invoices')).toBeInTheDocument();
  });
});
