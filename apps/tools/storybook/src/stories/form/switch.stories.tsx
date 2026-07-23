import type { Meta, StoryObj } from "@storybook/react";

import { Switch } from "@weldsuite/ui/components/switch";
import { Label } from "@weldsuite/ui/components/label";

const meta = {
  title: "Form/Switch",
  component: Switch,
  argTypes: {
    disabled: { control: "boolean" },
    defaultChecked: { control: "boolean" },
  },
} satisfies Meta<typeof Switch>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const Checked: Story = {
  args: { defaultChecked: true },
};

export const WithLabel: Story = {
  render: () => (
    <div className="flex items-center space-x-2">
      <Switch id="airplane-mode" />
      <Label htmlFor="airplane-mode">Airplane Mode</Label>
    </div>
  ),
};

export const Disabled: Story = {
  args: { disabled: true },
};
