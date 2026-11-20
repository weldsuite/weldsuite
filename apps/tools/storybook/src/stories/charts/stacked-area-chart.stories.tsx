import type { Meta, StoryObj } from '@storybook/react';

import { StackedAreaChart } from '@weldsuite/ui/components/stacked-area-chart';

import { StackedAreaPlayground } from './shape-playgrounds';

const periods = Array.from({ length: 12 }, (_, i) => {
  const date = new Date(Date.UTC(2025, 11 + i, 1));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
});
const monthDate = (key: string) => new Date(Date.UTC(Number(key.slice(0, 4)), Number(key.slice(5, 7)) - 1, 1));
const short = new Intl.DateTimeFormat('en-GB', { month: 'short', year: 'numeric', timeZone: 'UTC' });
const long = new Intl.DateTimeFormat('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' });
const compact = new Intl.NumberFormat('en-GB', { notation: 'compact', maximumFractionDigits: 1 });
const count = new Intl.NumberFormat('en-GB');
const channel = (label: string, base: number, growth: number) => ({
  key: label,
  label,
  values: periods.map((_, i) => Math.round(base * growth ** i * (1 + 0.1 * Math.sin(i * 1.7 + base)))),
});

const meta = {
  title: 'Charts/StackedAreaChart',
  component: StackedAreaChart,
  parameters: {
    docs: {
      description: {
        component:
          'Parts of a total over time: flat tinted bands with a line on top, stacked. `normalize` shows shares of each period instead. Point at the chart for every series in that period and the total.',
      },
    },
  },
  args: {
    periods,
    series: [channel('Search', 9_000, 1.03), channel('Direct', 5_200, 1.02), channel('Social', 3_100, 1.05)],
    formatTick: (k: string) => short.format(monthDate(k)),
    formatPeriod: (k: string) => long.format(monthDate(k)),
    formatAxisValue: (v: number) => compact.format(v),
    formatValue: (v: number) => count.format(v),
    totalLabel: 'Total',
    caption: 'Visitors by channel',
  },
  decorators: [
    (Story, { parameters }) =>
      parameters.width === null ? (
        <Story />
      ) : (
        <div style={{ width: 640 }}>
          <Story />
        </div>
      ),
  ],
} satisfies Meta<typeof StackedAreaChart>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Shape the demo data from the settings row above it. */
export const Playground: Story = {
  render: () => <StackedAreaPlayground />,
  parameters: { layout: 'fullscreen', width: null, controls: { disable: true } },
};

export const VisitorsByChannel: Story = {
  name: 'Visitors by channel',
};

export const SharesOfTotal: Story = {
  name: 'Shares of total',
  args: { normalize: true, formatAxisValue: undefined, formatValue: undefined },
};
