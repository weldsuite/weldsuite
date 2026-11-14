import type { ReactNode } from 'react';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { I18nProvider } from '@/lib/i18n/provider';

// Recharts draws nothing in jsdom: stand-ins that report the props the chart passes them.
vi.mock('recharts', () => {
  const Group = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
  const Marker =
    (name: string) =>
    function Stub(props: Record<string, unknown>) {
      return (
        <div
          data-testid={name}
          data-hide={String(props.hide ?? false)}
          data-active-dot={String(props.activeDot)}
          data-dash={String(props.strokeDasharray ?? '')}
          data-stroke={String(props.stroke ?? '')}
        />
      );
    };
  return {
    ComposedChart: Group,
    CartesianGrid: Marker('grid'),
    XAxis: Marker('x-axis'),
    YAxis: Marker('y-axis'),
    Line: Marker('line'),
    Area: Marker('area'),
    Bar: Marker('bar'),
  };
});

const format = vi.hoisted(() => ({
  compactMoney: (value: number) => String(value),
  formatMoney: (value: number) => String(value),
  monthLong: (month: string) => month,
}));
vi.mock('./use-chart-format', () => ({ useChartFormat: () => format }));

// The chart wrappers come from the UI library, which has its own Recharts: stand in for them too.
vi.mock('@weldsuite/ui/components/chart', () => ({
  ChartContainer: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  ChartTooltip: (props: Record<string, unknown>) => <div data-testid="tooltip" data-props={String(Object.keys(props).length)} />,
  ChartTooltipContent: () => null,
}));

import { ComparisonLineChart } from './comparison-line-chart';

const points = [
  { month: '2026-01', value: 100, compareMonth: '2025-01', compareValue: 80 },
  { month: '2026-02', value: 140, compareMonth: '2025-02', compareValue: 90 },
];

function renderChart(sample?: boolean) {
  render(
    <I18nProvider initialLanguage="en">
      <ComparisonLineChart
        variant="card"
        points={points}
        label="Revenue"
        compareLabel="Previous period"
        formatTick={(month) => month}
        sample={sample}
      />
    </I18nProvider>,
  );
}

describe('ComparisonLineChart sample data', () => {
  // The y gutter is measured on a canvas; jsdom has none, the chart falls back to an estimate.
  beforeAll(() => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
  });

  it('draws real figures with y labels, a tooltip and a hover dot, and no caption', () => {
    renderChart();

    expect(screen.getByTestId('y-axis')).toHaveAttribute('data-hide', 'false');
    expect(screen.getByTestId('tooltip')).toBeInTheDocument();
    expect(screen.getAllByTestId('line')[1]).not.toHaveAttribute('data-active-dot', 'false');
    expect(screen.getAllByTestId('line')[1]).toHaveAttribute('data-dash', '');
    expect(screen.queryByTestId('sample-caption')).not.toBeInTheDocument();
  });

  it('draws sample data muted and dashed: no y labels, no tooltip, no hover dot, and says so', () => {
    renderChart(true);

    expect(screen.getByTestId('y-axis')).toHaveAttribute('data-hide', 'true');
    // The grid stays: it is what makes the sample read as a chart.
    expect(screen.getByTestId('grid')).toBeInTheDocument();
    expect(screen.queryByTestId('tooltip')).not.toBeInTheDocument();

    const lines = screen.getAllByTestId('line');
    for (const line of lines) {
      expect(line).toHaveAttribute('data-active-dot', 'false');
      expect(line).toHaveAttribute('data-dash', '4 4');
    }
    expect(lines[1]).toHaveAttribute('data-stroke', 'var(--color-value)');
    expect(screen.getByTestId('sample-caption')).toHaveTextContent('Sample data');
  });
});
