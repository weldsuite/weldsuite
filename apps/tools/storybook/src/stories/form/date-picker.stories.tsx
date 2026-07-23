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
