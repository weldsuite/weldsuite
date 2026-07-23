import type { Meta, StoryObj } from "@storybook/react";
import { useState } from "react";

import { Calendar } from "@weldsuite/ui/components/calendar";

const meta = {
  title: "Data Display/Calendar",
  component: Calendar,
  parameters: { layout: "centered" },
} satisfies Meta<typeof Calendar>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  render: () => {
    const [date, setDate] = useState<Date | undefined>(new Date());
    return (
      <Calendar
        mode="single"
        selected={date}
        onSelect={setDate}
        className="rounded-md border"
      />
    );
  },
};

export const Range: Story = {
  render: () => {
    const [range, setRange] = useState<{ from: Date; to?: Date } | undefined>({
      from: new Date(2024, 0, 20),
      to: new Date(2024, 0, 25),
    });
    return (
      <Calendar
        mode="range"
        selected={range}
        onSelect={setRange as any}
        numberOfMonths={2}
        className="rounded-md border"
      />
    );
  },
};
