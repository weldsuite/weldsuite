import type { Meta, StoryObj } from '@storybook/react';

import { EntityFormSection } from '@weldsuite/ui/components/entity-form-section';
import { Input } from '@weldsuite/ui/components/input';
import { Label } from '@weldsuite/ui/components/label';

const meta = {
  title: 'Layout/EntityFormSection',
  component: EntityFormSection,
} satisfies Meta<typeof EntityFormSection>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  args: {
    title: 'General',
    description: 'Basic information about the company.',
  },
  render: (args) => (
    <div className="max-w-md">
      <EntityFormSection {...args}>
        <div className="grid gap-3">
          <div className="grid gap-1.5">
            <Label htmlFor="name">Name</Label>
            <Input id="name" placeholder="Acme Inc." />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="vat">VAT number</Label>
            <Input id="vat" placeholder="BE0123456789" />
          </div>
        </div>
      </EntityFormSection>
    </div>
  ),
};
