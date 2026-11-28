import type { Meta, StoryObj } from '@storybook/react';

import { LockedButton } from '@weldsuite/ui/components/locked-button';

const meta = {
  title: 'Primitives/LockedButton',
  component: LockedButton,
  args: { children: 'Edit', variant: 'outline', size: 'sm' },
} satisfies Meta<typeof LockedButton>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Without a reason it is an ordinary button. */
export const Default: Story = {};

/** Locked: it keeps keyboard focus, does nothing, and says why on hover, on focus and to a screen reader. */
export const Locked: Story = {
  args: { lockedReason: 'These hours are on an invoice. Change them on the invoice.' },
};

/** A reason that needs no words (a request is running) is a native `disabled`. */
export const Busy: Story = { args: { disabled: true } };
