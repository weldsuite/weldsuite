import type { Meta, StoryObj } from '@storybook/react';
import { useState } from 'react';

import { TimePicker } from '@weldsuite/ui/components/time-picker';

const meta = {
  title: 'Form/TimePicker',
  component: TimePicker,
} satisfies Meta<typeof TimePicker>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  render: () => {
    const [value, setValue] = useState<string>();
    return (
      <div className="w-48">
        <TimePicker value={value} onChange={setValue} />
      </div>
    );
  },
};

export const Preselected: Story = {
  render: () => {
    const [value, setValue] = useState<string>('14:30');
    return (
      <div className="w-48">
        <TimePicker value={value} onChange={setValue} />
      </div>
    );
  },
};
