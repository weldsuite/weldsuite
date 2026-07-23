import type { Meta, StoryObj } from '@storybook/react';

import { WeldAgentIcon } from '@weldsuite/ui/components/weldagent-icon';

const meta = {
  title: 'Data Display/WeldAgentIcon',
  component: WeldAgentIcon,
} satisfies Meta<typeof WeldAgentIcon>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  render: () => <WeldAgentIcon className="h-10 w-auto text-foreground" />,
};

export const Sizes: Story = {
  render: () => (
    <div className="flex items-end gap-4 text-violet-600">
      <WeldAgentIcon className="h-4 w-auto" />
      <WeldAgentIcon className="h-8 w-auto" />
      <WeldAgentIcon className="h-12 w-auto" />
    </div>
  ),
};
