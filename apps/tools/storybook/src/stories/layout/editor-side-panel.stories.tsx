import type { Meta, StoryObj } from '@storybook/react';
import { useState } from 'react';
import { Trash2 } from 'lucide-react';

import { Button } from '@weldsuite/ui/components/button';
import { Input } from '@weldsuite/ui/components/input';
import { Label } from '@weldsuite/ui/components/label';
import {
  EditorPanelBody,
  EditorPanelFooter,
  EditorPanelHeader,
  EditorPanelSection,
  EditorSidePanel,
} from '@weldsuite/ui/components/editor-side-panel';

const meta = {
  title: 'Layout/EditorSidePanel',
  component: EditorSidePanel,
  parameters: { layout: 'fullscreen' },
} satisfies Meta<typeof EditorSidePanel>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  render: () => {
    const [open, setOpen] = useState(true);
    return (
      <div className="relative flex h-[520px] overflow-hidden border">
        <div className="flex min-w-0 flex-1 items-center justify-center bg-muted/30 text-sm text-muted-foreground">
          <Button variant="outline" onClick={() => setOpen(true)}>
            Canvas: click to open the step
          </Button>
        </div>
        <EditorSidePanel open={open}>
          <EditorPanelHeader title="Edit step" onClose={() => setOpen(false)} />
          <EditorPanelBody>
            <div className="space-y-2">
              <Label htmlFor="step-name" className="text-xs">
                Action name
              </Label>
              <Input id="step-name" defaultValue="Send welcome email" />
            </div>
            <EditorPanelSection title="Settings">
              <p className="text-sm text-muted-foreground">The step's own fields go here.</p>
            </EditorPanelSection>
          </EditorPanelBody>
          <EditorPanelFooter>
            <Button variant="outline" className="w-full text-destructive hover:bg-destructive/10 hover:text-destructive">
              <Trash2 className="mr-0.5 h-4 w-4 text-red-600 dark:text-red-400" />
              Delete step
            </Button>
          </EditorPanelFooter>
        </EditorSidePanel>
      </div>
    );
  },
};
