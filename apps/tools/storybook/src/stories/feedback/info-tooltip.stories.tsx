import type { Meta, StoryObj } from '@storybook/react';

import { InfoTooltip } from '@weldsuite/ui/components/info-tooltip';

const meta = {
  title: 'Feedback/InfoTooltip',
  component: InfoTooltip,
  argTypes: {
    side: { control: 'select', options: ['top', 'right', 'bottom', 'left'] },
  },
} satisfies Meta<typeof InfoTooltip>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  render: () => (
    <div className="flex items-center gap-2">
      <span className="text-sm">Account number</span>
      <InfoTooltip content="Format: 1000-9999" />
    </div>
  ),
};

export const Positioned: Story = {
  render: () => (
    <div className="flex items-center gap-2">
      <span className="text-sm">Email address</span>
      <InfoTooltip content="We'll never share your email." side="right" align="start" />
    </div>
  ),
};
