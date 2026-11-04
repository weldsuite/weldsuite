import type { Meta, StoryObj } from '@storybook/react';

import { InlineSpinner, PageLoader } from '@weldsuite/ui/components/page-loader';
import { Card, CardContent, CardHeader, CardTitle } from '@weldsuite/ui/components/card';

const meta = {
  title: 'Feedback/PageLoader',
  component: PageLoader,
  argTypes: {
    label: { control: 'text' },
    fullScreen: { control: 'boolean' },
    appearDelayMs: { control: { type: 'number', min: 0, step: 50 } },
  },
} satisfies Meta<typeof PageLoader>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Stays invisible for 250ms, so a load that finishes fast never flashes a spinner. */
export const Default: Story = {
  args: { fullScreen: false },
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

export const NoDelay: Story = {
  args: { fullScreen: false, appearDelayMs: 0 },
  render: (args) => (
    <div className="h-64 w-full">
      <PageLoader {...args} />
    </div>
  ),
};

/** `InlineSpinner`: a card or section that is still loading. */
export const Inline: Story = {
  render: () => (
    <Card className="w-[360px]">
      <CardHeader>
        <CardTitle className="text-base">Recent syncs</CardTitle>
      </CardHeader>
      <CardContent>
        <InlineSpinner />
      </CardContent>
    </Card>
  ),
};
