import type { Meta, StoryObj } from '@storybook/react';
import { Inbox, MessageCircle } from 'lucide-react';

import { CountBadge } from '@weldsuite/ui/components/count-badge';

const meta = {
  title: 'Primitives/CountBadge',
  component: CountBadge,
  argTypes: {
    count: { control: 'number' },
    max: { control: 'number' },
  },
  args: { count: 3, label: '3 unread' },
} satisfies Meta<typeof CountBadge>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const Sizes: Story = {
  render: () => (
    <div className="flex items-center gap-2">
      <CountBadge count={7} />
      <CountBadge count={42} />
      <CountBadge count={150} />
    </div>
  ),
};

/** On a rail icon: pinned to the corner, with a ring in the rail's colour so it reads as cut out. */
export const OnIcon: Story = {
  render: () => (
    <div className="flex gap-4 bg-background p-4">
      <div className="relative flex h-9 w-9 items-center justify-center rounded-[10px] bg-muted">
        <MessageCircle className="h-5 w-5" />
        <CountBadge count={4} className="absolute -top-[3px] -right-[3px] ring-2 ring-background" />
      </div>
      <div className="relative flex h-9 w-9 items-center justify-center rounded-[10px] bg-muted">
        <MessageCircle className="h-5 w-5" />
        <CountBadge count={128} className="absolute -top-[3px] -right-[3px] ring-2 ring-background" />
      </div>
    </div>
  ),
};

/** At the end of a sidebar row. */
export const InRow: Story = {
  render: () => (
    <div className="flex w-56 items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-accent">
      <Inbox className="h-4 w-4" />
      <span className="truncate text-muted-foreground">My reviews</span>
      <CountBadge count={12} label="12 reviews waiting for you" className="ml-auto" />
    </div>
  ),
};
