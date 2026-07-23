import type { Meta, StoryObj } from "@storybook/react";
import { fn } from "@storybook/test";
import { Mail, Loader2, ChevronRight, Trash2, Plus } from "lucide-react";

import { Button } from "@weldsuite/ui/components/button";

const meta = {
  title: "Primitives/Button",
  component: Button,
  args: {
    onClick: fn(),
    children: "Button",
  },
  argTypes: {
    variant: {
      control: "select",
      options: [
        "default",
        "destructive",
        "outline",
        "secondary",
        "ghost",
        "link",
      ],
    },
    size: {
      control: "select",
      options: [
        "default",
        "xs",
        "sm",
        "lg",
        "icon",
        "icon-xs",
        "icon-sm",
        "icon-lg",
      ],
    },
    asChild: { control: "boolean" },
    disabled: { control: "boolean" },
  },
} satisfies Meta<typeof Button>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const Destructive: Story = {
  args: { variant: "destructive", children: "Delete" },
};

export const Outline: Story = {
  args: { variant: "outline" },
};

export const Secondary: Story = {
  args: { variant: "secondary" },
};

export const Ghost: Story = {
  args: { variant: "ghost" },
};

export const Link: Story = {
  args: { variant: "link" },
};

export const Small: Story = {
  args: { size: "sm", children: "Small" },
};

export const Large: Story = {
  args: { size: "lg", children: "Large" },
};

export const ExtraSmall: Story = {
  args: { size: "xs", children: "Tiny" },
};

export const WithIcon: Story = {
  args: {
    children: (
      <>
        <Mail /> Send Email
      </>
    ),
  },
};

export const IconOnly: Story = {
  args: {
    variant: "outline",
    size: "icon",
    children: <ChevronRight />,
    "aria-label": "Next",
  },
};

export const Loading: Story = {
  args: {
    disabled: true,
    children: (
      <>
        <Loader2 className="animate-spin" /> Please wait
      </>
    ),
  },
};

export const Disabled: Story = {
  args: { disabled: true },
};

export const AllVariants: Story = {
  render: () => (
    <div className="flex flex-col gap-6">
      <div>
        <p className="text-sm text-muted-foreground mb-2">Variants</p>
        <div className="flex flex-wrap gap-3">
          {(
            [
              "default",
              "destructive",
              "outline",
              "secondary",
              "ghost",
              "link",
            ] as const
          ).map((variant) => (
            <Button key={variant} variant={variant}>
              {variant}
            </Button>
          ))}
        </div>
      </div>
      <div>
        <p className="text-sm text-muted-foreground mb-2">Sizes</p>
        <div className="flex flex-wrap items-center gap-3">
          <Button size="xs">Extra Small</Button>
          <Button size="sm">Small</Button>
          <Button size="default">Default</Button>
          <Button size="lg">Large</Button>
        </div>
      </div>
      <div>
        <p className="text-sm text-muted-foreground mb-2">Icon sizes</p>
        <div className="flex flex-wrap items-center gap-3">
          <Button size="icon-xs" variant="outline">
            <Plus />
          </Button>
          <Button size="icon-sm" variant="outline">
            <Plus />
          </Button>
          <Button size="icon" variant="outline">
            <Plus />
          </Button>
          <Button size="icon-lg" variant="outline">
            <Plus />
          </Button>
        </div>
      </div>
      <div>
        <p className="text-sm text-muted-foreground mb-2">With icons</p>
        <div className="flex flex-wrap gap-3">
          <Button>
            <Mail /> Send
          </Button>
          <Button variant="destructive">
            <Trash2 /> Delete
          </Button>
          <Button variant="outline">
            <Plus /> Add
          </Button>
        </div>
      </div>
    </div>
  ),
};
