import type { Meta, StoryObj } from '@storybook/react';

import { SegmentedBar } from '@weldsuite/ui/components/segmented-bar';

const meta = {
  title: 'Data Display/SegmentedBar',
  component: SegmentedBar,
  args: {
    label: 'Page views by rating',
    segments: [
      { key: 'good', label: 'Good', value: 0.72, tone: 'success' },
      { key: 'ni', label: 'Needs improvement', value: 0.19, tone: 'warning' },
      { key: 'poor', label: 'Poor', value: 0.09, tone: 'danger' },
    ],
  },
  decorators: [
    (Story) => (
      <div className="w-96">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof SegmentedBar>;

export default meta;
type Story = StoryObj<typeof meta>;

export const WebVitals: Story = {};

export const Counts: Story = {
  args: {
    label: 'Tickets by status',
    segments: [
      { key: 'open', label: 'Open', value: 42, tone: 'primary', valueLabel: '42' },
      { key: 'waiting', label: 'Waiting', value: 13, tone: 'neutral', valueLabel: '13' },
      { key: 'closed', label: 'Closed', value: 0, tone: 'success', valueLabel: '0' },
    ],
  },
};

export const WithoutLegend: Story = {
  args: { legend: false },
};
