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

/** An optional time (`clearable`): while a time is set, Clear under the columns empties the field. */
export const Clearable: Story = {
  render: () => {
    const [value, setValue] = useState<string>('12:30');
    return (
      <div className="w-48">
        <TimePicker value={value || undefined} onChange={setValue} clearable placeholder="No break" />
      </div>
    );
  },
};

/** 24-hour clock (`hourCycle={24}`) with translated column headings, as a Dutch user would see it. */
export const TwentyFourHour: Story = {
  render: () => {
    const [value, setValue] = useState<string>('09:30');
    return (
      <div className="w-48">
        <TimePicker value={value} onChange={setValue} hourCycle={24} hourLabel="Uur" minuteLabel="Min" placeholder="Kies een tijd" />
      </div>
    );
  },
};
