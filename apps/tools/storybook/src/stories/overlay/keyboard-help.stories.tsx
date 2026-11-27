import type { Meta, StoryObj } from '@storybook/react';
import { useState } from 'react';

import { KeyboardHelp, type KeyboardHelpGroup } from '@weldsuite/ui/components/keyboard-help';
import { Button } from '@weldsuite/ui/components/button';

const GROUPS: KeyboardHelpGroup[] = [
  {
    title: 'Move',
    shortcuts: [
      { keys: ['J'], label: 'Next line' },
      { keys: ['K'], label: 'Previous line' },
    ],
  },
  {
    title: 'Process',
    shortcuts: [
      { keys: ['Enter'], label: 'Accept the suggestion' },
      { keys: ['C'], label: 'Book to a category' },
      { keys: ['U'], label: 'Undo' },
    ],
  },
];

const meta = {
  title: 'Overlay/KeyboardHelp',
  component: KeyboardHelp,
  args: {
    open: false,
    onOpenChange: () => undefined,
    title: 'Keyboard shortcuts',
    groups: GROUPS,
  },
} satisfies Meta<typeof KeyboardHelp>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  render: () => {
    const [open, setOpen] = useState(false);
    return (
      <>
        <Button onClick={() => setOpen(true)}>Show shortcuts</Button>
        <KeyboardHelp
          open={open}
          onOpenChange={setOpen}
          title="Keyboard shortcuts"
          description="They work while no field has focus."
          groups={GROUPS}
        />
      </>
    );
  },
};

export const Open: Story = {
  args: { open: true },
};
