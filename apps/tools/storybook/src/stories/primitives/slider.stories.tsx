import type { Meta, StoryObj } from "@storybook/react";

import { Slider } from "@weldsuite/ui/components/slider";
import { Label } from "@weldsuite/ui/components/label";

const meta = {
  title: "Primitives/Slider",
  component: Slider,
  argTypes: {
    defaultValue: { control: false },
    min: { control: "number" },
    max: { control: "number" },
    step: { control: "number" },
    disabled: { control: "boolean" },
  },
} satisfies Meta<typeof Slider>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  args: { defaultValue: [50], max: 100, step: 1, className: "w-[300px]" },
};

export const WithLabel: Story = {
  render: () => (
    <div className="grid w-[300px] gap-2">
      <Label>Volume</Label>
      <Slider defaultValue={[75]} max={100} step={1} />
    </div>
  ),
};

export const Disabled: Story = {
  args: {
    defaultValue: [50],
    max: 100,
    step: 1,
    disabled: true,
    className: "w-[300px]",
  },
};
