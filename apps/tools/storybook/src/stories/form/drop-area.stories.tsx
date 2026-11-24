import type { Meta, StoryObj } from '@storybook/react';
import { useState } from 'react';
import { Upload } from 'lucide-react';

import { DropArea, DropAreaOverlay } from '@weldsuite/ui/components/drop-area';

const meta = {
  title: 'Form/DropArea',
  component: DropArea,
} satisfies Meta<typeof DropArea>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Drag a file from your desktop over the panel: a dashed border with the text centred, as in WhatsApp. */
export const Conversation: Story = {
  args: { onDrop: () => {} },
  render: () => {
    const [files, setFiles] = useState<File[]>([]);
    return (
      <DropArea onDrop={setFiles} className="flex h-[420px] w-[560px] flex-col rounded-lg border">
        <div className="border-b px-4 py-3 text-sm font-medium">#general</div>
        <div className="flex-1 space-y-2 p-4 text-sm text-muted-foreground">
          <p>Messages would be here.</p>
          {files.length > 0 && (
            <p className="text-foreground">Dropped: {files.map((file) => file.name).join(', ')}</p>
          )}
        </div>
        <div className="border-t p-3 text-sm text-muted-foreground">Type a message…</div>
        <DropAreaOverlay title="Upload to #general" />
      </DropArea>
    );
  },
};

/** Images only (`options.accept`), with an icon and a second line. */
export const ImagesOnly: Story = {
  args: { onDrop: () => {} },
  render: () => {
    const [files, setFiles] = useState<File[]>([]);
    return (
      <DropArea
        onDrop={setFiles}
        options={{ accept: { 'image/*': [] } }}
        className="flex h-[320px] w-[480px] items-center justify-center rounded-lg border text-sm text-muted-foreground"
      >
        {files.length > 0 ? `${files.length} image(s) dropped` : 'Drag an image over this panel'}
        <DropAreaOverlay
          title="Drop images here"
          description="PNG, JPG or GIF"
          icon={
            <span className="flex h-14 w-14 items-center justify-center rounded-xl bg-primary text-primary-foreground">
              <Upload className="h-6 w-6" />
            </span>
          }
        />
      </DropArea>
    );
  },
};
