import type { Meta, StoryObj } from '@storybook/react';

import { Gauge } from '@weldsuite/ui/components/gauge';

import { GaugePlayground } from './shape-playgrounds';

const meta = {
  title: 'Charts/Gauge',
  component: Gauge,
  parameters: {
    docs: {
      description: {
        component: 'One figure against its limit on a half circle, red once over it, with an optional mark at a target. It is an ARIA meter.',
      },
    },
  },
  args: {
    label: 'Budget used',
    value: 72_400,
    max: 100_000,
    target: 90_000,
    detail: '€72,400 of €100,000',
    minLabel: '€0',
    maxLabel: '€100,000',
  },
  decorators: [
    (Story, { parameters }) =>
      parameters.width === null ? (
        <Story />
      ) : (
        <div style={{ width: 320 }}>
          <Story />
        </div>
      ),
  ],
} satisfies Meta<typeof Gauge>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Shape the demo data from the settings row above it. */
export const Playground: Story = {
  render: () => <GaugePlayground />,
  parameters: { layout: 'fullscreen', width: null, controls: { disable: true } },
};

export const Budget: Story = {};

export const OverLimit: Story = {
  name: 'Over limit',
  args: { value: 112_300, detail: '€112,300 of €100,000' },
};

export const Plain: Story = {
  args: { label: 'Storage', value: 38, max: 50, target: undefined, detail: '38 GB of 50 GB', minLabel: undefined, maxLabel: undefined, color: 'var(--chart-4)' },
};
