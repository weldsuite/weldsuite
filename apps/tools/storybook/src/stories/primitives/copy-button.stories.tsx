import type { Meta, StoryObj } from '@storybook/react';

import { CopyButton } from '@weldsuite/ui/components/copy-button';

const meta = {
  title: 'Primitives/CopyButton',
  component: CopyButton,
  args: {
    value: 'https://pay.example.test/d/abc123',
    copiedLabel: 'Copied',
    failedLabel: 'Copy failed',
    label: 'Copy link',
  },
} satisfies Meta<typeof CopyButton>;

export default meta;
type Story = StoryObj<typeof meta>;

/** The confirmation is a status message next to the button, shown in words and with an icon. */
export const Default: Story = {};

/** Icon-only: `ariaLabel` names it. */
export const IconOnly: Story = {
  args: { label: undefined, ariaLabel: 'Copy the payment link', variant: 'ghost', size: 'icon-sm' },
};
