import type { Meta, StoryObj } from '@storybook/react';
import { useState } from 'react';

import { ConfirmDialog } from '@weldsuite/ui/components/confirm-dialog';
import { Button } from '@weldsuite/ui/components/button';
import { DEFAULT_UI_LABELS, UiLabelsProvider } from '@weldsuite/ui/providers/ui-labels-provider';

const meta = {
  title: 'Feedback/ConfirmDialog',
  component: ConfirmDialog,
  args: {
    open: false,
    onOpenChange: () => undefined,
    title: 'Save changes?',
    description: 'Your edits will be applied immediately.',
    onConfirm: () => undefined,
  },
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

/**
 * Without `confirmLabel` / `cancelLabel` the buttons take the app's
 * translations from `UiLabelsProvider` (here Dutch).
 */
export const TranslatedLabels: Story = {
  render: () => {
    const [open, setOpen] = useState(false);
    return (
      <UiLabelsProvider labels={{ ...DEFAULT_UI_LABELS, confirm: 'Bevestigen', cancel: 'Annuleren' }}>
        <Button onClick={() => setOpen(true)}>Open confirm</Button>
        <ConfirmDialog
          open={open}
          onOpenChange={setOpen}
          title="Wijzigingen opslaan?"
          description="Je wijzigingen worden direct toegepast."
          onConfirm={() => setOpen(false)}
        />
      </UiLabelsProvider>
    );
  },
};
