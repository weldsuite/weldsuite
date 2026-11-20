import type { ReactNode } from 'react';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

/*
 * The dashboard's chart is `ComparisonChart` from the UI library, which has no
 * test runner of its own, so it is tested here. The library has its own
 * Recharts (2.x, the platform has 3.x): the mock names that copy by path.
 * Recharts draws nothing in jsdom: stand-ins that report the props the chart passes them.
 */
vi.mock('../../../../../../../packages/design/ui/node_modules/recharts', () => {
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
          data-ticks={JSON.stringify(props.ticks ?? null)}
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

// The chart wrappers draw through Recharts too: stand in for them.
vi.mock('@weldsuite/ui/components/chart', () => ({
  ChartContainer: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  ChartTooltip: (props: Record<string, unknown>) => <div data-testid="tooltip" data-props={String(Object.keys(props).length)} />,
  ChartTooltipContent: () => null,
}));

import { ComparisonChart } from '@weldsuite/ui/components/comparison-chart';

const points = [
  { month: '2026-01', value: 100, compareMonth: '2025-01', compareValue: 80 },
  { month: '2026-02', value: 140, compareMonth: '2025-02', compareValue: 90 },
];

function renderChart(data = points) {
  render(
    <ComparisonChart
      variant="card"
      points={data}
      label="Revenue"
      compareLabel="Previous period"
      formatTick={(month) => month}
      formatAxisValue={(value) => `€${value}`}
      formatValue={(value) => `€${value.toFixed(2)}`}
      formatPeriod={(month) => month}
    />,
  );
}

describe('ComparisonChart', () => {
  // The y gutter is measured on a canvas; jsdom has none, the chart falls back to an estimate.
  beforeAll(() => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
  });

  it('draws the figures with y labels, a tooltip and a hover dot: the period solid, the comparison dashed', () => {
    renderChart();

    expect(screen.getByTestId('y-axis')).toHaveAttribute('data-hide', 'false');
    expect(screen.getByTestId('tooltip')).toBeInTheDocument();
    const [comparison, period] = screen.getAllByTestId('line');
    expect(comparison).toHaveAttribute('data-dash', '4 4');
    expect(period).toHaveAttribute('data-dash', '');
    expect(period).not.toHaveAttribute('data-active-dot', 'false');
    expect(period).toHaveAttribute('data-stroke', 'var(--color-value)');
  });

  it('draws books with nothing booked as flat lines on the zero line, not as sample data', () => {
    renderChart(points.map((p) => ({ ...p, value: 0, compareValue: 0 })));

    expect(screen.getByTestId('y-axis')).toHaveAttribute('data-hide', 'false');
    expect(screen.getByTestId('y-axis')).toHaveAttribute('data-ticks', '[0]');
    expect(screen.getAllByTestId('line')).toHaveLength(2);
    expect(screen.getByTestId('tooltip')).toBeInTheDocument();
    expect(screen.queryByText('Sample data')).not.toBeInTheDocument();
  });
});
