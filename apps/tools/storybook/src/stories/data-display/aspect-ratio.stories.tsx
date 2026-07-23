import type { Meta, StoryObj } from "@storybook/react";

import { AspectRatio } from "@weldsuite/ui/components/aspect-ratio";

const meta = {
  title: "Data Display/AspectRatio",
  component: AspectRatio,
  parameters: { layout: "centered" },
} satisfies Meta<typeof AspectRatio>;

export default meta;
type Story = StoryObj<typeof meta>;

export const SixteenByNine: Story = {
  render: () => (
    <div className="w-[400px]">
      <AspectRatio ratio={16 / 9} className="bg-muted rounded-md overflow-hidden">
        <div className="flex items-center justify-center h-full text-muted-foreground">
          16:9
        </div>
      </AspectRatio>
    </div>
  ),
};

export const Square: Story = {
  render: () => (
    <div className="w-[300px]">
      <AspectRatio ratio={1} className="bg-muted rounded-md overflow-hidden">
        <div className="flex items-center justify-center h-full text-muted-foreground">
          1:1
        </div>
      </AspectRatio>
    </div>
  ),
};
