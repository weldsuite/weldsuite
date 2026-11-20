import type { Meta, StoryObj } from '@storybook/react';

import { ComparisonChart } from '@weldsuite/ui/components/comparison-chart';

import { formatShortMonth, formatters, lastTwelveMonths, lossMaking, nothingBooked, yearToDate } from './chart.mocks';
import { ComparisonPlayground } from './playground';

const meta = {
  title: 'Charts/ComparisonChart',
  component: ComparisonChart,
  parameters: {
    docs: {
      description: {
        component:
          'A period against its comparison, as on the WeldBooks dashboard: the period solid, the comparison dashed grey. `card` has a grid with round y labels on the right; `hero` is bare, just the baseline. Hover for the tooltip that follows the pointer.',
      },
    },
  },
  args: {
    variant: 'card',
    label: 'Revenue',
    compareLabel: 'Previous period',
    points: lastTwelveMonths(14_000),
    className: 'aspect-auto h-[250px] w-full',
    ...formatters,
  },
  // A card's width; a story sets `parameters.width` for another, or `null` to fill the canvas.
  decorators: [
    (Story, { parameters }) =>
      parameters.width === null ? (
        <Story />
      ) : (
        <div style={{ width: (parameters.width as number | undefined) ?? 380 }}>
          <Story />
        </div>
      ),
  ],
} satisfies Meta<typeof ComparisonChart>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Shape the demo data and the chart from the settings rows above it. */
export const Playground: Story = {
  render: () => <ComparisonPlayground />,
  parameters: { layout: 'fullscreen', width: null, controls: { disable: true } },
};

export const Card: Story = {};

export const Area: Story = {
  args: { shape: 'area', color: 'var(--chart-2)', label: 'Expenses', points: lastTwelveMonths(9_000, 1.02) },
};

export const Bars: Story = {
  args: { shape: 'bar' },
};

export const BelowZero: Story = {
  name: 'Below zero',
  args: { label: 'Net profit', points: lossMaking() },
};

export const NothingBooked: Story = {
  name: 'Nothing booked',
  args: { points: nothingBooked() },
};

export const WithoutComparison: Story = {
  name: 'Without comparison',
  args: { points: lastTwelveMonths(14_000).map(({ month, value }) => ({ month, value })) },
};

/** The "Today" chart: this year's running total, stopping at the current month, against all of last year. */
export const Hero: Story = {
  args: {
    variant: 'hero',
    compareLabel: 'Last year',
    points: yearToDate(14_000),
    formatTick: formatShortMonth,
    className: 'aspect-auto h-[200px] w-full',
  },
  parameters: { width: 720 },
};
