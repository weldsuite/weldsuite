import type { Meta, StoryObj } from '@storybook/react';

import { RadialBars } from '@weldsuite/ui/components/radial-bars';

import { RadialPlayground } from './shape-playgrounds';

const meta = {
  title: 'Charts/RadialBars',
  component: RadialBars,
  parameters: {
    docs: {
      description: {
        component: 'Several goals as rings, outside in, each filled to its share of the target, with rows beside them. Point at a ring or row to see its share in the middle.',
      },
    },
  },
  args: {
    items: [
      { key: 'revenue', label: 'Revenue', value: 82_000, max: 100_000, display: '€82,000' },
      { key: 'deals', label: 'Deals won', value: 16, max: 25, display: '16' },
      { key: 'calls', label: 'Calls made', value: 180, max: 400, display: '180' },
    ],
  },
  decorators: [
    (Story, { parameters }) =>
      parameters.width === null ? (
        <Story />
      ) : (
        <div style={{ width: 480 }}>
          <Story />
        </div>
      ),
  ],
} satisfies Meta<typeof RadialBars>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Shape the demo data from the settings row above it. */
export const Playground: Story = {
  render: () => <RadialPlayground />,
  parameters: { layout: 'fullscreen', width: null, controls: { disable: true } },
};

export const Goals: Story = {};

export const OneRing: Story = {
  name: 'One ring',
  args: { items: [{ key: 'storage', label: 'Storage', value: 38, max: 50, display: '38 GB', color: 'var(--chart-4)' }], size: 120 },
};

export const OverTarget: Story = {
  name: 'Over target',
  args: {
    items: [
      { key: 'demos', label: 'Demos booked', value: 72, max: 60, display: '72' },
      { key: 'renewals', label: 'Renewals', value: 31, max: 40, display: '31' },
    ],
  },
};
