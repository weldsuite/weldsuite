import type { Meta, StoryObj } from '@storybook/react';
import { Mail, Phone, Globe, Building2 } from 'lucide-react';

import { EntityInfoCard } from '@weldsuite/ui/components/entity-info-card';

const meta = {
  title: 'Data Display/EntityInfoCard',
  component: EntityInfoCard,
} satisfies Meta<typeof EntityInfoCard>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  args: {
    title: 'Contact Details',
    items: [
      { icon: Mail, label: 'Email', value: 'jane@acme.com', href: 'mailto:jane@acme.com' },
      { icon: Phone, label: 'Phone', value: '+1 555 0100' },
      { icon: Globe, label: 'Website', value: 'acme.com', href: 'https://acme.com' },
      { icon: Building2, label: 'Company', value: 'Acme Inc.' },
    ],
  },
  render: (args) => (
    <div className="max-w-sm">
      <EntityInfoCard {...args} />
    </div>
  ),
};
