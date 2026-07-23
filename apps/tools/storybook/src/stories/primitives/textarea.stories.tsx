import type { Meta, StoryObj } from "@storybook/react";

import { Textarea } from "@weldsuite/ui/components/textarea";
import { Label } from "@weldsuite/ui/components/label";

const meta = {
  title: "Primitives/Textarea",
  component: Textarea,
  argTypes: {
    placeholder: { control: "text" },
    disabled: { control: "boolean" },
  },
} satisfies Meta<typeof Textarea>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  args: { placeholder: "Type your message..." },
};

export const WithLabel: Story = {
  render: () => (
    <div className="grid w-full max-w-sm gap-1.5">
      <Label htmlFor="message">Message</Label>
      <Textarea id="message" placeholder="Type your message here" />
    </div>
  ),
};

export const Disabled: Story = {
  args: { placeholder: "Disabled", disabled: true },
};
