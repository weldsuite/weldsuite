import type { Meta, StoryObj } from "@storybook/react";

import { Separator } from "@weldsuite/ui/components/separator";

const meta = {
  title: "Primitives/Separator",
  component: Separator,
  argTypes: {
    orientation: {
      control: "radio",
      options: ["horizontal", "vertical"],
    },
  },
} satisfies Meta<typeof Separator>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Horizontal: Story = {
  render: () => (
    <div className="w-64">
      <p className="text-sm">Above</p>
      <Separator className="my-4" />
      <p className="text-sm">Below</p>
    </div>
  ),
};

export const Vertical: Story = {
  render: () => (
    <div className="flex h-5 items-center space-x-4 text-sm">
      <span>Blog</span>
      <Separator orientation="vertical" />
      <span>Docs</span>
      <Separator orientation="vertical" />
      <span>Source</span>
    </div>
  ),
};
