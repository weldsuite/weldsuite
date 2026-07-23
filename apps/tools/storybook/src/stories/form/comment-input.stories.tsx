import type { Meta, StoryObj } from '@storybook/react';
import { useState } from 'react';

import { CommentInput } from '@weldsuite/ui/components/comment-input';

const meta = {
  title: 'Form/CommentInput',
  component: CommentInput,
} satisfies Meta<typeof CommentInput>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  render: () => {
    const [value, setValue] = useState('');
    return (
      <div className="max-w-md border rounded-xl">
        <CommentInput value={value} onChange={setValue} onSend={() => setValue('')} />
      </div>
    );
  },
};

export const MinimalActions: Story = {
  render: () => {
    const [value, setValue] = useState('');
    return (
      <div className="max-w-md border rounded-xl">
        <CommentInput
          value={value}
          onChange={setValue}
          onSend={() => setValue('')}
          placeholder="Reply…"
          showImage={false}
          showPaperclip={false}
          showSettings={false}
        />
      </div>
    );
  },
};
