import type { Meta, StoryObj } from '@storybook/react';

import { StatusDot, PRESENCE_STATUSES, STATUS_LABELS } from '@weldsuite/ui/components/status-dot';

const meta = {
  title: 'Data Display/StatusDot',
  component: StatusDot,
  argTypes: {
    status: { control: 'select', options: PRESENCE_STATUSES },
    size: { control: 'select', options: ['sm', 'md', 'lg'] },
    showTooltip: { control: 'boolean' },
  },
} satisfies Meta<typeof StatusDot>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  args: { status: 'online', size: 'md', showTooltip: true },
};

export const AllStatuses: Story = {
  render: () => (
    <div className="flex flex-col gap-3">
      {PRESENCE_STATUSES.map((status) => (
        <div key={status} className="flex items-center gap-2">
          <StatusDot status={status} size="lg" />
          <span className="text-sm">{STATUS_LABELS[status]}</span>
        </div>
      ))}
    </div>
  ),
};
