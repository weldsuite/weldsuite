import type { Meta, StoryObj } from '@storybook/react';

import { Heatmap } from '@weldsuite/ui/components/heatmap';

import { HeatmapPlayground } from './analytics-playgrounds';

const days = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const hours = Array.from({ length: 24 }, (_, h) => `${String(h).padStart(2, '0')}:00`);
/** Office hours on weekdays, quiet nights and weekends, with a repeatable wobble. */
const tickets = days.map((_, d) =>
  hours.map((__, h) => {
    const base = (h >= 8 && h <= 18 ? 0.7 : 0.08) * (d < 5 ? 1 : 0.25) + 0.15 * Math.abs(Math.sin(d * 7 + h * 3.1));
    return Math.round(base * (h < 6 ? 0.3 : 1) * 42);
  }),
);

const meta = {
  title: 'Charts/Heatmap',
  component: Heatmap,
  parameters: {
    docs: {
      description: {
        component:
          'Counts by two dimensions, such as weekday by hour, as rounded cells in steps of one colour. A table underneath, so every count is read out; under the pointer a cell shows a card with its count.',
      },
    },
  },
  args: {
    rows: days,
    columns: hours,
    values: tickets,
    valueLabel: 'Tickets',
    legend: { less: 'Less', more: 'More' },
    caption: 'Tickets by weekday and hour',
  },
  decorators: [
    (Story, { parameters }) =>
      parameters.width === null ? (
        <Story />
      ) : (
        <div className="w-[720px]">
          <Story />
        </div>
      ),
  ],
} satisfies Meta<typeof Heatmap>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Shape the demo data from the settings row above it. */
export const Playground: Story = {
  render: () => <HeatmapPlayground />,
  parameters: { layout: 'fullscreen', width: null, controls: { disable: true } },
};

export const TicketsByHour: Story = {
  name: 'Tickets by hour',
};

export const WithoutKey: Story = {
  name: 'Without key',
  args: { legend: undefined, color: 'var(--chart-4)' },
};

export const NoData: Story = {
  name: 'No data',
  args: { values: days.map(() => hours.map(() => 0)) },
};
