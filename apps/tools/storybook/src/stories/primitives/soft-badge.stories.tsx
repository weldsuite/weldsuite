import type { Meta, StoryObj } from '@storybook/react';

import { SoftBadge } from '@weldsuite/ui/components/soft-badge';

const meta = {
  title: 'Primitives/SoftBadge',
  component: SoftBadge,
  argTypes: {
    tone: { control: 'select', options: ['neutral', 'success', 'warning', 'danger'] },
  },
  args: { tone: 'success', children: 'Paid' },
} satisfies Meta<typeof SoftBadge>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const AllTones: Story = {
  render: () => (
    <div className="flex gap-2">
      <SoftBadge tone="neutral">Draft</SoftBadge>
      <SoftBadge tone="success">Paid</SoftBadge>
      <SoftBadge tone="warning">Due soon</SoftBadge>
      <SoftBadge tone="danger">Overdue</SoftBadge>
    </div>
  ),
};
