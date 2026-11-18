import type { Meta, StoryObj } from '@storybook/react';
import { useState } from 'react';

import { PromptDialog } from '@weldsuite/ui/components/prompt-dialog';
import { Button } from '@weldsuite/ui/components/button';

const meta = {
  title: 'Feedback/PromptDialog',
  component: PromptDialog,
  args: {
    open: false,
    onOpenChange: () => undefined,
    title: 'Rename',
    label: 'Board name',
    onConfirm: () => undefined,
  },
} satisfies Meta<typeof PromptDialog>;

export default meta;
type Story = StoryObj<typeof meta>;

/** A rename: the current name starts selected, and Save needs some text. */
export const Rename: Story = {
  render: () => {
    const [open, setOpen] = useState(false);
    const [name, setName] = useState('Sprint retro');
    return (
      <>
        <Button onClick={() => setOpen(true)}>Rename “{name}”</Button>
        <PromptDialog open={open} onOpenChange={setOpen} title="Rename" label="Board name" defaultValue={name} onConfirm={setName} />
      </>
    );
  },
};

/** A value that may be cleared: saving an empty field is allowed. */
export const AllowEmpty: Story = {
  render: () => {
    const [open, setOpen] = useState(false);
    return (
      <>
        <Button onClick={() => setOpen(true)}>Add link</Button>
        <PromptDialog
          open={open}
          onOpenChange={setOpen}
          title="Link"
          label="Link address"
          type="url"
          placeholder="https://"
          allowEmpty
          onConfirm={() => undefined}
        />
      </>
    );
  },
};
