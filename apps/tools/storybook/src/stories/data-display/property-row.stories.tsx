import type { Meta, StoryObj } from '@storybook/react';
import { Copy, Globe, KeyRound, Mail, User } from 'lucide-react';

import { Button } from '@weldsuite/ui/components/button';
import { PropertyRowLayout, PropertyValue } from '@weldsuite/ui/components/property-row';

const meta = {
  title: 'Data Display/PropertyRow',
  component: PropertyRowLayout,
} satisfies Meta<typeof PropertyRowLayout>;

export default meta;
type Story = StoryObj<typeof meta>;

const copy = (
  <Button variant="ghost" size="icon" className="size-7" aria-label="Copy">
    <Copy className="size-3.5" />
  </Button>
);

/** The details tab of an object panel (a WeldCRM company, a WeldPass login). */
export const DetailsTab: Story = {
  args: { icon: User, label: 'Username', children: null },
  render: () => (
    <div className="max-w-md space-y-1 p-4">
      <PropertyRowLayout icon={User} label="Username" accessory={copy}>
        <PropertyValue>alex@acme.example</PropertyValue>
      </PropertyRowLayout>
      <PropertyRowLayout icon={KeyRound} label="Password" accessory={copy}>
        <PropertyValue tabular>••••••••••••</PropertyValue>
      </PropertyRowLayout>
      <PropertyRowLayout icon={Globe} label="Website">
        <PropertyValue>
          <a className="text-primary hover:underline" href="https://github.com/login">
            https://github.com/login
          </a>
        </PropertyValue>
      </PropertyRowLayout>
      <PropertyRowLayout icon={Mail} label="A very long value">
        <PropertyValue>someone.with.a.really.long.address@a-company-with-a-long-name.example</PropertyValue>
      </PropertyRowLayout>
    </div>
  ),
};
