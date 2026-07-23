import type { Meta, StoryObj } from '@storybook/react';

import { LucideDynamicIcon } from '@weldsuite/ui/components/lucide-dynamic-icon';

const meta = {
  title: 'Data Display/LucideDynamicIcon',
  component: LucideDynamicIcon,
  argTypes: {
    name: { control: 'text' },
    size: { control: 'number' },
  },
} satisfies Meta<typeof LucideDynamicIcon>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  args: { name: 'shopping-cart', size: 24 },
};

export const PascalCaseName: Story = {
  args: { name: 'ShoppingCart', size: 24 },
};

export const Gallery: Story = {
  render: () => (
    <div className="flex gap-4">
      {['home', 'settings', 'user', 'bell', 'calendar', 'unknown-icon'].map((name) => (
        <div key={name} className="flex flex-col items-center gap-1 text-xs">
          <LucideDynamicIcon name={name} size={24} />
          {name}
        </div>
      ))}
    </div>
  ),
};
