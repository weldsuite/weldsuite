import type { Meta, StoryObj } from '@storybook/react';

import { Treemap, type TreemapItem } from '@weldsuite/ui/components/treemap';

import { TreemapPlayground } from './shape-playgrounds';

const money = new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 });
const item = (label: string, value: number): TreemapItem => ({ key: label, label, value, display: money.format(value) });

const meta = {
  title: 'Charts/Treemap',
  component: Treemap,
  parameters: {
    docs: {
      description: {
        component: 'Many parts of a whole as tinted blocks sized by share, close to square, named where they fit. Point at a block for its share and amount.',
      },
    },
  },
  args: {
    items: [
      item('Office Rent BV', 18_200),
      item('Cloudly', 9_800),
      item('AdNet', 6_100),
      item('Printwerk', 4_300),
      item('Telecom NL', 3_400),
      item('Koffie & Co', 2_100),
      item('Courier', 1_900),
      item('Other', 3_120),
    ],
    label: 'Expenses by supplier',
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
} satisfies Meta<typeof Treemap>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Shape the demo data from the settings row above it. */
export const Playground: Story = {
  render: () => <TreemapPlayground />,
  parameters: { layout: 'fullscreen', width: null, controls: { disable: true } },
};

export const Suppliers: Story = {};

export const FewParts: Story = {
  name: 'Few parts',
  args: { items: [item('Payroll', 9_200), item('Rent', 3_400), item('Software', 2_600)] },
};
