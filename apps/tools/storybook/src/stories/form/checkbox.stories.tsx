import type { Meta, StoryObj } from "@storybook/react";

import { Checkbox } from "@weldsuite/ui/components/checkbox";
import { Label } from "@weldsuite/ui/components/label";

const meta = {
  title: "Form/Checkbox",
  component: Checkbox,
  argTypes: {
    disabled: { control: "boolean" },
    defaultChecked: { control: "boolean" },
  },
} satisfies Meta<typeof Checkbox>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const Checked: Story = {
  args: { defaultChecked: true },
};

export const WithLabel: Story = {
  render: () => (
    <div className="flex items-center space-x-2">
      <Checkbox id="terms" />
      <Label htmlFor="terms">Accept terms and conditions</Label>
    </div>
  ),
};

export const Disabled: Story = {
  args: { disabled: true },
};

export const DisabledChecked: Story = {
  args: { disabled: true, defaultChecked: true },
};
