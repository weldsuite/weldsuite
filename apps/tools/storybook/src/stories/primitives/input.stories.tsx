import type { Meta, StoryObj } from "@storybook/react";

import { Input } from "@weldsuite/ui/components/input";
import { Label } from "@weldsuite/ui/components/label";

const meta = {
  title: "Primitives/Input",
  component: Input,
  argTypes: {
    type: {
      control: "select",
      options: ["text", "email", "password", "number", "search", "tel", "url"],
    },
    placeholder: { control: "text" },
    disabled: { control: "boolean" },
  },
} satisfies Meta<typeof Input>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  args: { placeholder: "Enter text..." },
};

export const WithLabel: Story = {
  render: () => (
    <div className="grid w-full max-w-sm gap-1.5">
      <Label htmlFor="email">Email</Label>
      <Input type="email" id="email" placeholder="you@example.com" />
    </div>
  ),
};

export const Disabled: Story = {
  args: { placeholder: "Disabled input", disabled: true },
};

export const WithFile: Story = {
  args: { type: "file" },
};

export const Invalid: Story = {
  render: () => (
    <div className="grid w-full max-w-sm gap-1.5">
      <Label htmlFor="invalid">Email</Label>
      <Input
        type="email"
        id="invalid"
        placeholder="Invalid input"
        aria-invalid="true"
      />
      <p className="text-sm text-destructive">Please enter a valid email</p>
    </div>
  ),
};
