import type { Meta, StoryObj } from '@storybook/react';
import { useState } from 'react';

import { Dropzone, DropzoneEmptyState, DropzoneContent } from '@weldsuite/ui/components/dropzone';

const meta = {
  title: 'Form/Dropzone',
  component: Dropzone,
} satisfies Meta<typeof Dropzone>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  render: () => {
    const [files, setFiles] = useState<File[]>([]);
    return (
      <div className="max-w-md">
        <Dropzone
          src={files}
          accept={{ 'image/*': [] }}
          maxSize={5 * 1024 * 1024}
          maxFiles={3}
          onDrop={(accepted) => setFiles(accepted)}
        >
          <DropzoneEmptyState />
          <DropzoneContent>
            <p className="text-sm font-medium">{files.length} file(s) selected</p>
          </DropzoneContent>
        </Dropzone>
      </div>
    );
  },
};
