import type { Meta, StoryObj } from '@storybook/react';

import { EntitySectionCard } from '@weldsuite/ui/components/entity-section-card';
import { Button } from '@weldsuite/ui/components/button';

const meta = {
  title: 'Layout/EntitySectionCard',
  component: EntitySectionCard,
} satisfies Meta<typeof EntitySectionCard>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  args: {
    title: 'Notes',
    description: 'Internal notes about this account.',
    children: <p className="text-sm text-muted-foreground">No notes yet.</p>,
  },
  render: (args) => (
    <div className="max-w-md">
      <EntitySectionCard {...args} />
    </div>
  ),
};

export const WithActions: Story = {
  args: {
    title: 'Contacts',
    actions: <Button size="sm">Add contact</Button>,
    children: <p className="text-sm text-muted-foreground">2 contacts linked.</p>,
  },
  render: (args) => (
    <div className="max-w-md">
      <EntitySectionCard {...args} />
    </div>
  ),
};
