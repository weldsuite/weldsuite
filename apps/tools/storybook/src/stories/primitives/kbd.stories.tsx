import type { Meta, StoryObj } from "@storybook/react";

import { Kbd, KbdGroup } from "@weldsuite/ui/components/kbd";

const meta = {
  title: "Primitives/Kbd",
  component: Kbd,
} satisfies Meta<typeof Kbd>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  args: { children: "K" },
};

export const Shortcut: Story = {
  render: () => (
    <KbdGroup>
      <Kbd>Ctrl</Kbd>
      <Kbd>K</Kbd>
    </KbdGroup>
  ),
};

export const Multiple: Story = {
  render: () => (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between w-48">
        <span className="text-sm">Save</span>
        <KbdGroup><Kbd>Ctrl</Kbd><Kbd>S</Kbd></KbdGroup>
      </div>
      <div className="flex items-center justify-between w-48">
        <span className="text-sm">Copy</span>
        <KbdGroup><Kbd>Ctrl</Kbd><Kbd>C</Kbd></KbdGroup>
      </div>
      <div className="flex items-center justify-between w-48">
        <span className="text-sm">Paste</span>
        <KbdGroup><Kbd>Ctrl</Kbd><Kbd>V</Kbd></KbdGroup>
      </div>
    </div>
  ),
};
