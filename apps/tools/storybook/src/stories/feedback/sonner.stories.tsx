import type { Meta, StoryObj } from "@storybook/react";
import { toast } from "sonner";

import { Toaster } from "@weldsuite/ui/components/sonner";
import { Button } from "@weldsuite/ui/components/button";

const meta = {
  title: "Feedback/Sonner",
  component: Toaster,
  decorators: [
    (Story) => (
      <>
        <Story />
        <Toaster />
      </>
    ),
  ],
  parameters: { layout: "centered" },
} satisfies Meta<typeof Toaster>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  render: () => (
    <Button
      variant="outline"
      onClick={() => toast("Event has been created", {
        description: "Sunday, December 03, 2024 at 9:00 AM",
      })}
    >
      Show Toast
    </Button>
  ),
};

export const Success: Story = {
  render: () => (
    <Button
      variant="outline"
      onClick={() => toast.success("Successfully saved!")}
    >
      Success Toast
    </Button>
  ),
};

export const Error: Story = {
  render: () => (
    <Button
      variant="outline"
      onClick={() => toast.error("Something went wrong", {
        description: "Please try again later.",
      })}
    >
      Error Toast
    </Button>
  ),
};

export const WithAction: Story = {
  render: () => (
    <Button
      variant="outline"
      onClick={() =>
        toast("File deleted", {
          action: {
            label: "Undo",
            onClick: () => console.log("Undo"),
          },
        })
      }
    >
      Toast with Action
    </Button>
  ),
};
