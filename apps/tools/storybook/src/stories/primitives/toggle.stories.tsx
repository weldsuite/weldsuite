import type { Meta, StoryObj } from "@storybook/react";
import { Bold, Italic, Underline } from "lucide-react";

import { Toggle } from "@weldsuite/ui/components/toggle";

const meta = {
  title: "Primitives/Toggle",
  component: Toggle,
  argTypes: {
    variant: { control: "select", options: ["default", "outline"] },
    size: { control: "select", options: ["default", "sm", "lg"] },
    disabled: { control: "boolean" },
  },
} satisfies Meta<typeof Toggle>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  args: { children: <Bold className="h-4 w-4" />, "aria-label": "Toggle bold" },
};

export const Outline: Story = {
  args: {
    variant: "outline",
    children: <Italic className="h-4 w-4" />,
    "aria-label": "Toggle italic",
  },
};

export const WithText: Story = {
  args: { children: <><Bold className="h-4 w-4" /> Bold</> },
};

export const Disabled: Story = {
  args: {
    disabled: true,
    children: <Underline className="h-4 w-4" />,
    "aria-label": "Toggle underline",
  },
};
