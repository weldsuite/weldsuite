import type { Meta, StoryObj } from '@storybook/react';
import { useState } from 'react';

import { ConfirmDialog } from '@weldsuite/ui/components/confirm-dialog';
import { Button } from '@weldsuite/ui/components/button';

const meta = {
  title: 'Feedback/ConfirmDialog',
  component: ConfirmDialog,
} satisfies Meta<typeof ConfirmDialog>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  render: () => {
    const [open, setOpen] = useState(false);
    return (
      <>
        <Button onClick={() => setOpen(true)}>Open confirm</Button>
        <ConfirmDialog
          open={open}
          onOpenChange={setOpen}
          title="Save changes?"
          description="Your edits will be applied immediately."
          confirmLabel="Save"
          onConfirm={() => setOpen(false)}
        />
      </>
    );
  },
};

export const Destructive: Story = {
  render: () => {
    const [open, setOpen] = useState(false);
    return (
      <>
        <Button variant="destructive" onClick={() => setOpen(true)}>
          Delete item
        </Button>
        <ConfirmDialog
          open={open}
          onOpenChange={setOpen}
          variant="destructive"
          title="Delete this customer?"
          description="This action cannot be undone."
          confirmLabel="Delete"
          onConfirm={() => setOpen(false)}
        />
      </>
    );
  },
};
