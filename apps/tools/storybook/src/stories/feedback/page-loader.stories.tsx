import type { Meta, StoryObj } from '@storybook/react';

import { PageLoader } from '@weldsuite/ui/components/page-loader';

const meta = {
  title: 'Feedback/PageLoader',
  component: PageLoader,
  argTypes: {
    label: { control: 'text' },
    fullScreen: { control: 'boolean' },
  },
} satisfies Meta<typeof PageLoader>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  args: { label: 'Loading...', fullScreen: false },
  render: (args) => (
    <div className="h-64 w-full">
      <PageLoader {...args} />
    </div>
  ),
};

export const CustomLabel: Story = {
  args: { label: 'Fetching your invoices…', fullScreen: false },
  render: (args) => (
    <div className="h-64 w-full">
      <PageLoader {...args} />
    </div>
  ),
};
