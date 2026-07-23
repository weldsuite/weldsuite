import type { Meta, StoryObj } from '@storybook/react';

import { InfoBanner } from '@weldsuite/ui/components/info-banner';

const meta = {
  title: 'Feedback/InfoBanner',
  component: InfoBanner,
  argTypes: {
    variant: {
      control: 'select',
      options: ['info', 'warning', 'success', 'tip'],
    },
    dismissible: { control: 'boolean' },
  },
} satisfies Meta<typeof InfoBanner>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  args: {
    variant: 'info',
    title: 'Heads up',
    children: 'Set up your chart of accounts to get started.',
  },
};

export const Warning: Story = {
  args: {
    variant: 'warning',
    title: 'Action Required',
    dismissible: true,
    children: 'Please complete your tax settings before creating invoices.',
  },
};

export const AllVariants: Story = {
  render: () => (
    <div className="flex flex-col gap-3">
      <InfoBanner variant="info" title="Info">Informational message.</InfoBanner>
      <InfoBanner variant="success" title="Success">Your account is configured.</InfoBanner>
      <InfoBanner variant="warning" title="Warning">Something needs attention.</InfoBanner>
      <InfoBanner variant="tip" title="Tip">A helpful suggestion.</InfoBanner>
    </div>
  ),
};
