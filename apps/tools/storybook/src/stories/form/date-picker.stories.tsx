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

/** A custom label for the picked date (`formatDate`), e.g. to match the dates in a list ("22 Nov 2026"). */
export const CustomFormat: Story = {
  render: () => {
    const [date, setDate] = useState<Date | undefined>(new Date());
    return (
      <div className="w-[280px]">
        <DatePicker
          date={date}
          onDateChange={setDate}
          formatDate={(d) => d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })}
        />
      </div>
    );
  },
};

/** Month and year menus in the caption (`captionLayout="dropdown"`), for a date far from today such as a date of birth. */
export const YearDropdown: Story = {
  render: () => {
    const [date, setDate] = useState<Date | undefined>(new Date(1990, 4, 17));
    return (
      <div className="w-[280px]">
        <DatePicker
          date={date}
          onDateChange={setDate}
          captionLayout="dropdown"
          startMonth={new Date(1920, 0)}
          endMonth={new Date()}
        />
      </div>
    );
  },
};
