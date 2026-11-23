import type { Meta, StoryObj } from "@storybook/react";
import { fn } from "@storybook/test";
import { Archive, Clock, MoreHorizontal, Star, Ticket, Trash2, UserPlus } from "lucide-react";

import { CloseDoneButtons } from "@weldsuite/ui/components/close-done-buttons";
import { HeaderIconButton } from "@weldsuite/ui/components/header-icon-button";

/**
 * The icon buttons of a record's header row: WeldMail's message actions and
 * WeldDesk's conversation actions share this one look.
 */
const meta = {
  title: "Navigation/HeaderIconButton",
  component: HeaderIconButton,
  parameters: { layout: "centered" },
  args: { label: "Archive", onClick: fn(), children: <Archive /> },
} satisfies Meta<typeof HeaderIconButton>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

/** Red on hover. */
export const Destructive: Story = {
  args: { label: "Delete", destructive: true, children: <Trash2 /> },
};

/** A switched-on action keeps its own colour, e.g. a starred message. */
export const Active: Story = {
  args: {
    label: "Unstar",
    "aria-pressed": true,
    className: "text-yellow-500 dark:text-yellow-500",
    children: <Star className="fill-current" />,
  },
};

/** A full header row: close/done and the title on the left, the actions on the right. */
export const InHeaderRow: Story = {
  render: () => (
    <div className="flex w-[640px] items-center justify-between gap-2 border-b px-4 py-3">
      <div className="flex min-w-0 items-center gap-2">
        <CloseDoneButtons onClose={fn()} closeLabel="Back to list" onDone={fn()} doneLabel="Close" />
        <h1 className="ml-2 truncate text-lg font-semibold">Password reset emails arrive late</h1>
      </div>
      <div className="flex items-center gap-1">
        <HeaderIconButton label="Create ticket">
          <Ticket />
        </HeaderIconButton>
        <HeaderIconButton label="Assign">
          <UserPlus />
        </HeaderIconButton>
        <HeaderIconButton label="Snooze">
          <Clock />
        </HeaderIconButton>
        <HeaderIconButton label="More actions">
          <MoreHorizontal />
        </HeaderIconButton>
      </div>
    </div>
  ),
};
