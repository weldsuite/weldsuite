import type { Meta, StoryObj } from "@storybook/react";

import { Progress } from "@weldsuite/ui/components/progress";

const meta = {
  title: "Primitives/Progress",
  component: Progress,
  argTypes: {
    value: { control: { type: "range", min: 0, max: 100, step: 1 } },
  },
} satisfies Meta<typeof Progress>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  args: { value: 60, className: "w-[300px]" },
};

export const Empty: Story = {
  args: { value: 0, className: "w-[300px]" },
};

export const Full: Story = {
  args: { value: 100, className: "w-[300px]" },
};

export const AllStates: Story = {
  render: () => (
    <div className="flex flex-col gap-4 w-[300px]">
      <div>
        <p className="text-sm text-muted-foreground mb-1">0%</p>
        <Progress value={0} />
      </div>
      <div>
        <p className="text-sm text-muted-foreground mb-1">25%</p>
        <Progress value={25} />
      </div>
      <div>
        <p className="text-sm text-muted-foreground mb-1">50%</p>
        <Progress value={50} />
      </div>
      <div>
        <p className="text-sm text-muted-foreground mb-1">75%</p>
        <Progress value={75} />
      </div>
      <div>
        <p className="text-sm text-muted-foreground mb-1">100%</p>
        <Progress value={100} />
      </div>
    </div>
  ),
};
