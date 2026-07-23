import type { Meta, StoryObj } from '@storybook/react';
import { useState } from 'react';

import { ReplyInput } from '@weldsuite/ui/components/reply-input';

const meta = {
  title: 'Form/ReplyInput',
  component: ReplyInput,
} satisfies Meta<typeof ReplyInput>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  render: () => {
    const [value, setValue] = useState('');
    return (
      <div className="max-w-lg">
        <ReplyInput value={value} onChange={setValue} onSend={() => setValue('')} />
      </div>
    );
  },
};

export const WithAiDraft: Story = {
  render: () => {
    const [value, setValue] = useState('');
    return (
      <div className="max-w-lg">
        <ReplyInput
          value={value}
          onChange={setValue}
          onSend={() => setValue('')}
          showAiButton
          onAiDraft={(prompt) => setValue(`Draft based on: ${prompt}`)}
        />
      </div>
    );
  },
};
