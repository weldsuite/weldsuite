import type { Meta, StoryObj } from '@storybook/react';

import { InfoHelpText } from '@weldsuite/ui/components/info-help-text';

const meta = {
  title: 'Feedback/InfoHelpText',
  component: InfoHelpText,
  argTypes: {
    variant: { control: 'select', options: ['info', 'warning', 'tip'] },
  },
} satisfies Meta<typeof InfoHelpText>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  args: {
    variant: 'info',
    children: 'This account will be used for tracking sales revenue.',
  },
};

export const WithTitle: Story = {
  args: {
    variant: 'warning',
    title: 'Important',
    children: 'Changing this setting will affect all existing entries.',
  },
};
