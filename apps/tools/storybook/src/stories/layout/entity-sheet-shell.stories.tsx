import type { Meta, StoryObj } from '@storybook/react';
import { useState } from 'react';

import { EntitySheetShell, type EntitySheetView } from '@weldsuite/ui/components/entity-sheet-shell';
import { Button } from '@weldsuite/ui/components/button';

const meta = {
  title: 'Layout/EntitySheetShell',
  component: EntitySheetShell,
  parameters: { layout: 'fullscreen' },
} satisfies Meta<typeof EntitySheetShell>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  render: () => {
    const [open, setOpen] = useState(true);
    const [view, setView] = useState<EntitySheetView>('default');
    return (
      <div className="relative h-[500px] w-full bg-muted/30">
        <div className="p-6">
          <Button onClick={() => setOpen(true)}>Open sheet</Button>
        </div>
        {open && (
          <EntitySheetShell
            title="Acme Inc."
            subtitle="Customer"
            view={view}
            topOffset={0}
            onClose={() => setOpen(false)}
            onToggleView={() => setView((v) => (v === 'full' ? 'default' : 'full'))}
          >
            <div className="p-4 text-sm text-muted-foreground">
              Entity detail content goes here.
            </div>
          </EntitySheetShell>
        )}
      </div>
    );
  },
};
