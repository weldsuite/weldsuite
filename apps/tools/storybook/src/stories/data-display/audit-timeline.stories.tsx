import type { Meta, StoryObj } from '@storybook/react';

import {
  AuditTimeline,
  AuditTimelineSkeleton,
  type AuditLogEntry,
} from '@weldsuite/ui/components/audit-timeline';

const meta = {
  title: 'Data Display/AuditTimeline',
  component: AuditTimeline,
} satisfies Meta<typeof AuditTimeline>;

export default meta;
type Story = StoryObj<typeof meta>;

const logs: AuditLogEntry[] = [
  {
    id: '1',
    action: 'created',
    description: 'Created the customer record',
    createdAt: new Date(Date.now() - 1000 * 60 * 60 * 24 * 3).toISOString(),
  },
  {
    id: '2',
    action: 'status_changed',
    description: 'Changed status from Lead to Customer',
    changes: { status: { from: 'lead', to: 'customer' } },
    createdAt: new Date(Date.now() - 1000 * 60 * 60 * 5).toISOString(),
  },
  {
    id: '3',
    action: 'assigned',
    description: 'Assigned to Jane Doe',
    createdAt: new Date(Date.now() - 1000 * 60 * 30).toISOString(),
  },
];

export const Default: Story = {
  args: { logs },
  render: (args) => (
    <div className="max-w-md">
      <AuditTimeline {...args} />
    </div>
  ),
};

/** Several field changes on one entry, one line per field. */
export const MultipleChanges: Story = {
  args: {
    logs: [
      {
        id: 'a',
        action: 'updated',
        description: 'Updated the task',
        changes: {
          status: { from: 'todo', to: 'in_progress' },
          dueDate: { from: null, to: '2026-11-20T00:00:00.000Z' },
          assigneeName: { from: 'Sam Lee', to: 'Jane Doe' },
        },
        createdAt: new Date(Date.now() - 1000 * 60 * 12).toISOString(),
      },
      ...logs,
    ],
  },
  render: (args) => (
    <div className="max-w-md">
      <AuditTimeline {...args} />
    </div>
  ),
};

export const Empty: Story = {
  args: { logs: [] },
};

export const Loading: Story = {
  args: { logs: [] },
  render: () => (
    <div className="max-w-md">
      <AuditTimelineSkeleton count={4} />
    </div>
  ),
};
