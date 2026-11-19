import type { ReactElement, ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { PlanDemand } from '@weldsuite/app-api-client/schemas/replenishment';

// jsdom has no layout, so recharts would draw nothing. These stand-ins render
// the formatters the chart passes, which is the logic this file adds.
vi.mock('recharts', () => ({
  ComposedChart: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  CartesianGrid: () => null,
  Bar: () => null,
  Line: () => null,
  YAxis: () => null,
  XAxis: ({ tickFormatter }: { tickFormatter: (value: string) => string }) => (
    <span data-testid="tick">{tickFormatter('2026-03-02')}</span>
  ),
}));
vi.mock('@weldsuite/ui/components/chart', () => ({
  ChartContainer: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  ChartTooltip: ({ content }: { content: ReactElement }) => content,
  ChartTooltipContent: ({
    labelFormatter,
  }: {
    labelFormatter: (label: unknown, payload: { payload?: { weekStart?: string } }[]) => string;
  }) => (
    <>
      <span data-testid="tooltip">{labelFormatter(null, [{ payload: { weekStart: '2026-03-02' } }])}</span>
      <span data-testid="tooltip-empty">{labelFormatter(null, [])}</span>
    </>
  ),
}));

import { DemandChart, demandChartData } from './demand-chart';

const demand: PlanDemand = {
  history: [
    { weekStart: '2026-02-16', quantity: 4 },
    { weekStart: '2026-02-23', quantity: 6 },
  ],
  forecast: [
    { weekStart: '2026-03-02', quantity: 5.26 },
    { weekStart: '2026-03-09', quantity: 5 },
  ],
} as PlanDemand;

describe('demandChartData', () => {
  it('lists history then forecast and joins the dashed line to the last bar', () => {
    expect(demandChartData(demand)).toEqual([
      { weekStart: '2026-02-16', history: 4, forecast: null },
      { weekStart: '2026-02-23', history: 6, forecast: 6 },
      { weekStart: '2026-03-02', history: null, forecast: 5.3 },
      { weekStart: '2026-03-09', history: null, forecast: 5 },
    ]);
  });

  it('keeps the last bar plain when there is no forecast', () => {
    expect(demandChartData({ history: demand.history, forecast: [] } as PlanDemand)).toEqual([
      { weekStart: '2026-02-16', history: 4, forecast: null },
      { weekStart: '2026-02-23', history: 6, forecast: null },
    ]);
  });
});

describe('DemandChart', () => {
  it('names the two series and formats the week labels', () => {
    render(<DemandChart demand={demand} />);
    expect(screen.getByText('Sold')).toBeInTheDocument();
    expect(screen.getByText('Forecast')).toBeInTheDocument();
    expect(screen.getByTestId('tick')).toHaveTextContent(/Mar.*26/);
    expect(screen.getByTestId('tooltip')).toHaveTextContent(/^Week of .*Mar.*2026/);
    expect(screen.getByTestId('tooltip-empty')).toBeEmptyDOMElement();
  });
});
