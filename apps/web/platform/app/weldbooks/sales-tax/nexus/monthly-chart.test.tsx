import { describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';

const format = vi.hoisted(() => ({
  formatMoney: (value: number | string) => `$${Number(value).toFixed(0)}`,
  dateLocale: 'en-US',
}));
vi.mock('@/lib/weldbooks/use-weldbooks-format', () => ({ useWeldbooksFormat: () => format }));

import { MonthlyChart, barHeights } from './monthly-chart';
import { renderWithProviders } from '../shared/test-support';

const month = (value: string, sales: number) => ({
  month: value,
  sales,
  gross: sales,
  taxable: sales,
  transactions: 1,
  marketplaceSales: 0,
});

describe('barHeights', () => {
  it('scales each month to the largest one', () => {
    expect(barHeights([{ sales: 50 }, { sales: 100 }, { sales: 0 }])).toEqual([50, 100, 0]);
  });

  it('draws a month of credits as tall as the same amount of sales', () => {
    expect(barHeights([{ sales: -100 }, { sales: 50 }])).toEqual([100, 50]);
  });

  it('draws nothing when there were no sales at all', () => {
    expect(barHeights([{ sales: 0 }, { sales: 0 }])).toEqual([0, 0]);
    expect(barHeights([])).toEqual([]);
  });
});

describe('MonthlyChart', () => {
  it('draws a labelled bar per month, red for a month with more credits than sales', () => {
    const { container } = renderWithProviders(<MonthlyChart months={[month('2026-08', 100), month('2026-09', -40)]} />);

    expect(screen.getByRole('img', { name: /Sales by month/ })).toBeInTheDocument();
    expect(screen.getByTitle('2026-08: $100')).toHaveClass('bg-primary');
    expect(screen.getByTitle('2026-09: $-40')).toHaveClass('bg-destructive/70');
    expect(container).toHaveTextContent('Aug');
    expect(container).toHaveTextContent('Sep');
  });
});
