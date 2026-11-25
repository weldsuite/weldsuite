import type { Meta, StoryObj } from "@storybook/react";
import { fn } from "@storybook/test";

import { CloseDoneButtons } from "@weldsuite/ui/components/close-done-buttons";

/**
 * Close (or back) and done, at the start of a record's header row: WeldMail's
 * message header and WeldDesk's conversation and ticket headers.
 */
const meta = {
  title: "Navigation/CloseDoneButtons",
  component: CloseDoneButtons,
  parameters: { layout: "centered" },
  args: {
    onClose: fn(),
    onDone: fn(),
    closeLabel: "Back to list",
    doneLabel: "Mark as done",
  },
} satisfies Meta<typeof CloseDoneButtons>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

/** Opened from somewhere to return to: a back arrow instead of the cross. */
export const Back: Story = {
  args: { back: true },
};

/** Nothing left to mark done, e.g. a conversation that is already closed. */
export const DoneDisabled: Story = {
  args: { doneDisabled: true, doneLabel: "Already closed" },
};

/** In a header row, before the record's title. */
export const InHeader: Story = {
  render: (args) => (
    <div className="flex w-[560px] items-center gap-2 border-b px-4 py-3">
      <CloseDoneButtons {...args} />
      <h1 className="ml-2 truncate text-lg font-semibold">Re: Q4 order: revised quote</h1>
    </div>
  ),
};
