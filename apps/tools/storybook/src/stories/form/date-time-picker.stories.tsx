import type { Meta, StoryObj } from "@storybook/react";
import { useState } from "react";

import { DateTimePicker } from "@weldsuite/ui/components/date-time-picker";

const meta = {
  title: "Form/DateTimePicker",
  component: DateTimePicker,
  parameters: { layout: "centered" },
  args: { onChange: () => {} },
} satisfies Meta<typeof DateTimePicker>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  render: () => {
    const [value, setValue] = useState<Date | undefined>();
    return (
      <div className="w-96">
        <DateTimePicker value={value} onChange={setValue} placeholder="No date" timeLabel="Time" />
      </div>
    );
  },
};

export const WithValue: Story = {
  render: () => {
    const [value, setValue] = useState<Date | undefined>(new Date(2026, 10, 20, 9, 30));
    return (
      <div className="w-96">
        <DateTimePicker value={value} onChange={setValue} timeLabel="Time" />
      </div>
    );
  },
};

export const EndOfDayDefault: Story = {
  render: () => {
    const [value, setValue] = useState<Date | undefined>();
    return (
      <div className="w-96">
        <DateTimePicker value={value} onChange={setValue} placeholder="No date" timeLabel="Time" defaultTime="23:59" />
      </div>
    );
  },
};
