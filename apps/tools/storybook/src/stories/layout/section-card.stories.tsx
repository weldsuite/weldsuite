import type { Meta, StoryObj } from '@storybook/react';

import { SectionCard } from '@weldsuite/ui/components/section-card';
import { Button } from '@weldsuite/ui/components/button';
import { EmptyText } from '@weldsuite/ui/components/empty-state';

const meta = {
  title: 'Layout/SectionCard',
  component: SectionCard,
  args: {
    title: 'Recent activity',
    children: <p className="text-sm">Five invoices were sent this week.</p>,
  },
  render: (args) => (
    <div className="w-[420px]">
      <SectionCard {...args} />
    </div>
  ),
} satisfies Meta<typeof SectionCard>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const WithAction: Story = {
  args: {
    action: (
      <Button variant="outline" size="sm">
        View all
      </Button>
    ),
  },
};

export const WithDescription: Story = {
  args: {
    title: 'Sending limits',
    description: 'How many emails each mailbox may send per day while it warms up.',
    action: <Button size="sm">Edit</Button>,
  },
};

export const EmptyList: Story = {
  args: {
    title: 'Upcoming leave',
    children: <EmptyText>Nobody is on leave in the next two weeks.</EmptyText>,
  },
};
