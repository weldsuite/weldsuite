import type { Meta, StoryObj } from "@storybook/react";

import { Avatar, AvatarFallback, AvatarImage } from "@weldsuite/ui/components/avatar";

const meta = {
  title: "Primitives/Avatar",
  component: Avatar,
  parameters: { layout: "centered" },
} satisfies Meta<typeof Avatar>;

export default meta;
type Story = StoryObj<typeof meta>;

export const WithImage: Story = {
  render: () => (
    <Avatar>
      <AvatarImage src="https://github.com/shadcn.png" alt="@shadcn" />
      <AvatarFallback>CN</AvatarFallback>
    </Avatar>
  ),
};

export const Fallback: Story = {
  render: () => (
    <Avatar>
      <AvatarFallback>JD</AvatarFallback>
    </Avatar>
  ),
};

// The corner radius scales with the size, so every avatar has the same shape.
// Set only the size; never a rounded-* class.
export const Sizes: Story = {
  render: () => (
    <div className="flex items-center gap-4">
      <Avatar className="size-4">
        <AvatarFallback className="text-[8px]">XS</AvatarFallback>
      </Avatar>
      <Avatar className="size-5">
        <AvatarFallback className="text-[9px]">S</AvatarFallback>
      </Avatar>
      <Avatar className="h-[26px] w-[26px]">
        <AvatarFallback className="text-[11px]">M</AvatarFallback>
      </Avatar>
      <Avatar>
        <AvatarFallback>MD</AvatarFallback>
      </Avatar>
      <Avatar className="h-14 w-14">
        <AvatarFallback className="text-lg">LG</AvatarFallback>
      </Avatar>
      <Avatar className="h-20 w-20">
        <AvatarFallback className="text-2xl">XL</AvatarFallback>
      </Avatar>
    </div>
  ),
};
