import type { Meta, StoryObj } from '@storybook/react';

import { ColumnBars, type ColumnBarsItem } from '@weldsuite/ui/components/column-bars';

/** 30 minutes, oldest first, with a label under every fifth bar as on a realtime overview. */
function minutes(values: readonly number[]): ColumnBarsItem[] {
  return values.map((value, i) => {
    const ago = values.length - i;
    return {
      key: String(ago),
      label: ago === 1 ? 'Last minute' : `${ago} minutes ago`,
      value,
      display: String(value),
      axisLabel: ago % 5 === 0 || ago === 1 ? `-${ago} min` : undefined,
    };
  });
}

const busy = [3, 4, 2, 5, 6, 4, 7, 8, 6, 5, 4, 6, 9, 11, 8, 7, 6, 8, 10, 12, 9, 8, 7, 9, 11, 13, 10, 9, 8, 6];

const meta = {
  title: 'Charts/ColumnBars',
  component: ColumnBars,
  parameters: {
    docs: {
      description: {
        component:
          'A small column chart, one bar per period, with gridlines and their values on the right. Hover a column for its card. An empty chart keeps its grid.',
      },
    },
  },
  args: { items: minutes(busy), valueLabel: 'Active visitors', periodLabel: 'Minute', label: 'Active visitors per minute' },
  decorators: [
    (Story) => (
      <div style={{ width: 340 }} className="rounded-lg border bg-background p-4">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof ColumnBars>;

export default meta;
type Story = StoryObj<typeof meta>;

export const PerMinute: Story = { name: 'Per minute' };

export const Quiet: Story = { args: { items: minutes([0, 0, 1, 0, 0, 0, 0, 1, 1, 0, 0, 0, 0, 0, 2, 1, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0]) } };

export const Empty: Story = { args: { items: minutes(Array.from({ length: 30 }, () => 0)) } };
