import type { Meta, StoryObj } from "@storybook/react";

import { Label } from "@weldsuite/ui/components/label";
import { Input } from "@weldsuite/ui/components/input";
import { Checkbox } from "@weldsuite/ui/components/checkbox";

const meta = {
  title: "Primitives/Label",
  component: Label,
} satisfies Meta<typeof Label>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  args: { children: "Label text" },
};

export const WithInput: Story = {
  render: () => (
    <div className="grid w-full max-w-sm gap-1.5">
      <Label htmlFor="email">Email address</Label>
      <Input type="email" id="email" placeholder="you@example.com" />
    </div>
  ),
};

export const WithCheckbox: Story = {
  render: () => (
    <div className="flex items-center gap-2">
      <Checkbox id="terms" />
      <Label htmlFor="terms">Accept terms and conditions</Label>
    </div>
  ),
};
