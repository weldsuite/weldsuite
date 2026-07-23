import type { Meta, StoryObj } from "@storybook/react";

import { ScrollArea, ScrollBar } from "@weldsuite/ui/components/scroll-area";
import { Separator } from "@weldsuite/ui/components/separator";

const meta = {
  title: "Layout/ScrollArea",
  component: ScrollArea,
  parameters: { layout: "centered" },
} satisfies Meta<typeof ScrollArea>;

export default meta;
type Story = StoryObj<typeof meta>;

const tags = Array.from({ length: 50 }, (_, i) => `Tag ${i + 1}`);

export const Vertical: Story = {
  render: () => (
    <ScrollArea className="h-72 w-48 rounded-md border">
      <div className="p-4">
        <h4 className="mb-4 text-sm font-medium leading-none">Tags</h4>
        {tags.map((tag) => (
          <div key={tag}>
            <div className="text-sm">{tag}</div>
            <Separator className="my-2" />
          </div>
        ))}
      </div>
    </ScrollArea>
  ),
};

export const Horizontal: Story = {
  render: () => (
    <ScrollArea className="w-96 whitespace-nowrap rounded-md border">
      <div className="flex w-max space-x-4 p-4">
        {Array.from({ length: 20 }, (_, i) => (
          <div
            key={i}
            className="shrink-0 rounded-md border bg-card p-4 w-32 text-center text-sm"
          >
            Item {i + 1}
          </div>
        ))}
      </div>
      <ScrollBar orientation="horizontal" />
    </ScrollArea>
  ),
};
