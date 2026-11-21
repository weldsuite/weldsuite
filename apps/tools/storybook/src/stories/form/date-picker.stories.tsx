import type { Meta, StoryObj } from "@storybook/react";
import { useState } from "react";

import { DatePicker } from "@weldsuite/ui/components/date-picker";

const meta = {
  title: "Form/DatePicker",
  component: DatePicker,
  parameters: { layout: "centered" },
} satisfies Meta<typeof DatePicker>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  render: () => {
    const [date, setDate] = useState<Date | undefined>();
    return (
      <DatePicker
        date={date}
        onDateChange={setDate}
        placeholder="Pick a date"
      />
    );
  },
};

export const WithPreselectedDate: Story = {
  render: () => {
    const [date, setDate] = useState<Date | undefined>(new Date());
    return <DatePicker date={date} onDateChange={setDate} />;
  },
};

/** Only days from tomorrow on can be picked (`disabledDays`), e.g. when something should end. */
export const FutureDaysOnly: Story = {
  render: () => {
    const [date, setDate] = useState<Date | undefined>();
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    tomorrow.setHours(0, 0, 0, 0);
    return (
      <div className="w-[280px]">
        <DatePicker date={date} onDateChange={setDate} placeholder="Unpin on" disabledDays={{ before: tomorrow }} />
      </div>
    );
  },
};
