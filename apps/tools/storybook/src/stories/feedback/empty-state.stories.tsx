import type { Meta, StoryObj } from '@storybook/react';
import { Inbox, Plus } from 'lucide-react';

import { EmptyState, EmptyText } from '@weldsuite/ui/components/empty-state';
import { Button } from '@weldsuite/ui/components/button';

const meta = {
  title: 'Feedback/EmptyState',
  component: EmptyState,
  args: {
    icon: Inbox,
    title: 'No campaigns yet',
    description: 'Create a campaign to start reaching out to your prospects.',
  },
  render: (args) => (
    <div className="w-[520px]">
      <EmptyState {...args} />
    </div>
  ),
} satisfies Meta<typeof EmptyState>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const WithAction: Story = {
  args: {
    action: (
      <Button size="sm">
        <Plus className="mr-2 h-4 w-4" />
        New campaign
      </Button>
    ),
  },
};

export const TitleOnly: Story = {
  args: { icon: undefined, description: undefined, title: 'No secrets in this environment' },
};

/** `EmptyText`: the quiet one-liner for an empty list inside a card. */
export const InlineText: Story = {
  render: () => (
    <div className="w-[420px] rounded-xl border">
      <EmptyText>Nobody is on leave in the next two weeks.</EmptyText>
    </div>
  ),
};
