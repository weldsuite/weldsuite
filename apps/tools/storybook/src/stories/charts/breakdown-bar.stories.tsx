import type { Meta, StoryObj } from '@storybook/react';

import { BreakdownBar, type BreakdownBarItem } from '@weldsuite/ui/components/breakdown-bar';

import { formatMoney } from './chart.mocks';
import { BreakdownPlayground } from './playground';

const item = (key: string, label: string, amount: number, color: string): BreakdownBarItem => ({
  key,
  label,
  amount,
  display: formatMoney(amount),
  color,
});

/** Not due in the chart colour, then a warning-to-danger ramp as invoices age. */
const aging = (amounts: [number, number, number, number, number]) => [
  item('current', 'Not due', amounts[0], 'var(--chart-1)'),
  item('1-30', '1–30 days', amounts[1], '#f5b900'),
  item('31-60', '31–60 days', amounts[2], '#ed6704'),
  item('61-90', '61–90 days', amounts[3], '#df1b41'),
  item('90+', '90+ days', amounts[4], '#a3123a'),
];

const meta = {
  title: 'Charts/BreakdownBar',
  component: BreakdownBar,
  parameters: {
    docs: {
      description: {
        component:
          'One stacked bar with a segment per item, then a row per item with its colour, label and amount. Each item brings its own colour and formatted amount; for tones and shares use `SegmentedBar`.',
      },
    },
  },
  args: {
    items: aging([4_210.5, 1_150.6, 3_018.49, 879.52, 3_383.17]),
  },
  // A card's width; `parameters.width: null` fills the canvas.
  decorators: [
    (Story, { parameters }) =>
      parameters.width === null ? (
        <Story />
      ) : (
        <div className="w-[380px]">
          <Story />
        </div>
      ),
  ],
} satisfies Meta<typeof BreakdownBar>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Shape the demo data from the settings row above it. */
export const Playground: Story = {
  render: () => <BreakdownPlayground />,
  parameters: { layout: 'fullscreen', width: null, controls: { disable: true } },
};

export const ReceivablesByAge: Story = {
  name: 'Receivables by age',
};

export const Cash: Story = {
  args: {
    items: [
      item('ba_1', 'Business account', 30_482.52, 'var(--chart-1)'),
      item('ba_2', 'Savings', 12_000, 'var(--chart-2)'),
      item('ba_3', 'Credit card', -1_240.18, '#00a2b8'),
    ],
  },
};

export const NothingOutstanding: Story = {
  name: 'Nothing outstanding',
  args: { items: aging([0, 0, 0, 0, 0]) },
};
