import type { Meta, StoryObj } from '@storybook/react';
import { fn } from '@storybook/test';

import { FigureRow } from '@weldsuite/ui/components/figure-row';

const meta = {
  title: 'Data Display/FigureRow',
  component: FigureRow,
  parameters: {
    docs: {
      description: {
        component:
          'A row of figures without boxes, as under the WeldBooks dashboard chart: a title, the figure and one muted line. Four across on wide screens, or two for a narrow column.',
      },
    },
  },
  args: {
    items: [
      { key: 'cash', label: 'Cash balance', value: '€ 12.480,00', note: '2 bank accounts' },
      { key: 'receive', label: 'To receive', value: '€ 3.150,00', note: '€ 900,00 overdue', warn: true },
      { key: 'pay', label: 'To pay', value: '€ 1.240,00', note: '4 open bills' },
      { key: 'documents', label: 'Documents to process', value: '3', note: 'Waiting to be booked' },
    ],
  },
  decorators: [
    (Story) => (
      <div style={{ width: 1000 }} className="bg-background p-6">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof FigureRow>;

export default meta;
type Story = StoryObj<typeof meta>;

export const FourAcross: Story = { name: 'Four across' };

export const TwoInANarrowColumn: Story = {
  name: 'Two in a narrow column',
  args: {
    columns: 2,
    items: [
      { key: '30m', label: 'Active visitors', value: '47', note: 'In the last 30 minutes' },
      { key: '5m', label: 'Right now', value: '18', note: 'Active in the last 5 minutes' },
    ],
  },
  decorators: [
    (Story) => (
      <div style={{ width: 340 }}>
        <Story />
      </div>
    ),
  ],
};

export const Loading: Story = { args: { loading: true } };

/** Figures that pick a signal: the picked one is underlined on the line under the row. */
export const Picking: Story = {
  args: {
    columns: 5,
    selected: 'dead',
    onSelect: fn(),
    label: 'Signals',
    items: [
      { key: 'rage', label: 'Rage clicks', value: '1,049', note: '+12% vs the period before', warn: true },
      { key: 'dead', label: 'Dead clicks', value: '2,562', note: '−4% vs the period before' },
      { key: 'quickback', label: 'Quick backs', value: '1,442', note: '+3% vs the period before', warn: true },
      { key: 'scroll', label: 'Excessive scrolling', value: '670', note: 'None the period before' },
      { key: 'errors', label: 'Errors', value: '860', note: '−18% vs the period before' },
    ],
  },
  decorators: [
    (Story) => (
      <div className="border-b px-4 pt-4">
        <Story />
      </div>
    ),
  ],
};
