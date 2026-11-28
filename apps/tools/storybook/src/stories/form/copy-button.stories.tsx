import type { Meta, StoryObj } from '@storybook/react';

import { CopyButton } from '@weldsuite/ui/components/copy-button';

const meta = {
  title: 'Form/CopyButton',
  component: CopyButton,
  args: {
    value: 'forms.weldsuite.org',
    label: 'Copy CNAME value',
    copiedLabel: 'Copied',
    failedLabel: 'Copy failed',
  },
} satisfies Meta<typeof CopyButton>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const BesideValue: Story = {
  render: (args) => (
    <div className="flex items-center gap-1 font-mono text-sm">
      <span>{args.value}</span>
      <CopyButton {...args} />
    </div>
  ),
};

/** `showLabel` puts the label on the button as text (an outline button by default), as next to a document's public link. */
export const WithVisibleLabel: Story = {
  args: {
    value: 'https://pay.example.test/d/abc123',
    label: 'Copy link',
    showLabel: true,
  },
};
