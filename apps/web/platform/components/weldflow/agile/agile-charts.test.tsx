import type { ReactNode } from 'react';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { I18nProvider } from '@weldsuite/i18n/provider';
import type { Sprint } from '@weldsuite/app-api-client/schemas/flow-agile';

// Recharts draws nothing in jsdom: stand-ins that keep the props the charts pass.
vi.mock('recharts', () => {
  const Group = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
  const Leaf = () => null;
  return {
    BarChart: Group,
    Bar: Leaf,
    CartesianGrid: Leaf,
    XAxis: Leaf,
    YAxis: Leaf,
    ReferenceLine: ({ y }: { y: number }) => <div data-testid="average-line">{y}</div>,
  };
});
vi.mock('@weldsuite/ui/components/chart', () => ({
  ChartContainer: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  ChartTooltip: ({ content }: { content: (props: Record<string, unknown>) => ReactNode }) => (
    <div data-testid="tooltip">{content({ active: true, payload: [], coordinate: { x: 1, y: 1 }, label: 'S1' })}</div>
  ),
  ChartTooltipContent: ({ formatter }: { formatter: (value: unknown, name: string) => ReactNode }) => (
    <div>
      {formatter(8, 'committed')}
      {formatter(5, 'completed')}
    </div>
  ),
}));
vi.mock('@weldsuite/ui/components/comparison-chart', () => ({
  ComparisonChart: (props: {
    points: { month: string; value?: number; compareValue: number }[];
    formatTick: (value: string) => string;
    formatAxisValue: (value: number) => string;
    formatValue: (value: number) => string;
    formatPeriod: (value: string) => string;
  }) => (
    <div data-testid="comparison">
      <span data-testid="tick">{props.formatTick(props.points[0]!.month)}</span>
      <span data-testid="axis">{props.formatAxisValue(5)}</span>
      <span data-testid="value">{props.formatValue(2.34)}</span>
      <span data-testid="period">{props.formatPeriod(props.points[0]!.month)}</span>
      <span data-testid="first-value">{String(props.points[0]!.value)}</span>
      <span data-testid="last-value">{String(props.points[props.points.length - 1]!.value)}</span>
    </div>
  ),
}));

import { BurndownChart } from './burndown-chart';
import { VelocityChart } from './velocity-chart';
import { SprintPicker } from './sprint-picker';

beforeAll(() => {
  const proto = window.HTMLElement.prototype as unknown as Record<string, unknown>;
  proto.hasPointerCapture ??= () => false;
  proto.setPointerCapture ??= () => undefined;
  proto.releasePointerCapture ??= () => undefined;
  proto.scrollIntoView ??= () => undefined;
});

const wrap = (node: ReactNode) => <I18nProvider initialLanguage="en">{node}</I18nProvider>;

function sprint(id: string, status: string, extra: Partial<Sprint> = {}): Sprint {
  return {
    id,
    projectId: 'p1',
    name: `Sprint ${id}`,
    goal: null,
    status,
    startDate: '2026-11-01',
    endDate: '2026-11-14',
    startedAt: null,
    completedAt: null,
    velocity: null,
    storyPointsCommitted: null,
    storyPointsCompleted: null,
    createdAt: '2026-10-01T00:00:00Z',
    updatedAt: '2026-10-01T00:00:00Z',
    ...extra,
  };
}

describe('BurndownChart', () => {
  it('formats the days and lists the figures for screen readers, leaving future days empty', () => {
    render(
      wrap(
        <BurndownChart
          label="Burndown of S1"
          points={[
            { date: '2026-11-02', remaining: 10, ideal: 10 },
            { date: '2026-11-03', remaining: null, ideal: 5 },
          ]}
        />,
      ),
    );
    expect(screen.getByTestId('tick')).toHaveTextContent('Nov 2');
    expect(screen.getByTestId('axis')).toHaveTextContent('5');
    expect(screen.getByTestId('value')).toHaveTextContent('2.3 points');
    expect(screen.getByTestId('period')).toHaveTextContent(/Mon.*2.*November|November.*2/);
    expect(screen.getByTestId('first-value')).toHaveTextContent('10');
    expect(screen.getByTestId('last-value')).toHaveTextContent('undefined');

    const table = screen.getByRole('table', { hidden: true });
    const rows = within(table).getAllByRole('row', { hidden: true });
    // Header plus one row per day.
    expect(rows).toHaveLength(3);
    const cells = within(rows[2]!).getAllByRole('cell', { hidden: true });
    expect(cells[0]).toHaveTextContent('');
    expect(cells[1]).toHaveTextContent('5');
  });
});

describe('VelocityChart', () => {
  const bars = [
    { id: 's1', name: 'Sprint 1', committed: 8, completed: 5 },
    { id: 's2', name: 'Sprint 2', committed: 10, completed: 10 },
  ];

  it('shows the legend with the average, the tooltip rows and the table', () => {
    render(wrap(<VelocityChart bars={bars} average={7.5} label="Velocity" />));
    expect(screen.getByText('Average 7.5')).toBeInTheDocument();
    expect(screen.getByTestId('average-line')).toHaveTextContent('7.5');
    expect(screen.getByText('8 points')).toBeInTheDocument();
    expect(screen.getByText('5 points')).toBeInTheDocument();
    const table = screen.getByRole('table', { hidden: true });
    expect(within(table).getByText('Sprint 2')).toBeInTheDocument();
  });

  it('leaves the average out when there is none', () => {
    render(wrap(<VelocityChart bars={bars} average={null} label="Velocity" />));
    expect(screen.queryByText(/Average/)).not.toBeInTheDocument();
    expect(screen.queryByTestId('average-line')).not.toBeInTheDocument();
  });
});

describe('SprintPicker', () => {
  const sprints = [
    sprint('A', 'active'),
    sprint('P', 'planned'),
    sprint('C', 'completed', { completedAt: '2026-10-14T00:00:00Z' }),
    sprint('X', 'weird'),
  ];

  it('shows the picked sprint with its status and offers all open work', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(wrap(<SprintPicker sprints={sprints} value="A" onChange={onChange} />));
    const trigger = screen.getByRole('combobox', { name: 'Show on the Pipeline' });
    expect(trigger).toHaveTextContent('Sprint A · Active');

    await user.click(trigger);
    expect(await screen.findByText('Active sprint')).toBeInTheDocument();
    expect(screen.getByText('Planned sprints')).toBeInTheDocument();
    expect(screen.getByText('Past sprints')).toBeInTheDocument();
    await user.click(screen.getByRole('option', { name: 'All open work' }));
    expect(onChange).toHaveBeenCalledWith(null);
  });

  it('passes the sprint id of a picked sprint, and reads null as all open work', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(wrap(<SprintPicker sprints={sprints} value={null} onChange={onChange} />));
    const trigger = screen.getByRole('combobox');
    expect(trigger).toHaveTextContent('All open work');
    await user.click(trigger);
    await user.click(await screen.findByRole('option', { name: 'Sprint P · Planned' }));
    expect(onChange).toHaveBeenCalledWith('P');
  });

  it('shows only all open work when there are no sprints', async () => {
    const user = userEvent.setup();
    render(wrap(<SprintPicker sprints={[]} value={null} onChange={vi.fn()} />));
    await user.click(screen.getByRole('combobox'));
    expect(await screen.findAllByRole('option')).toHaveLength(1);
    expect(screen.queryByText('Active sprint')).not.toBeInTheDocument();
  });
});
