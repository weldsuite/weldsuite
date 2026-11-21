import type { Meta, StoryObj } from "@storybook/react";
import { Globe, Lock, Users } from "lucide-react";

import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@weldsuite/ui/components/select";
import { Label } from "@weldsuite/ui/components/label";

const meta = {
  title: "Form/Select",
  component: Select,
  parameters: { layout: "centered" },
} satisfies Meta<typeof Select>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  render: () => (
    <Select>
      <SelectTrigger className="w-[200px]">
        <SelectValue placeholder="Select a fruit" />
      </SelectTrigger>
      <SelectContent>
        <SelectGroup>
          <SelectLabel>Fruits</SelectLabel>
          <SelectItem value="apple">Apple</SelectItem>
          <SelectItem value="banana">Banana</SelectItem>
          <SelectItem value="orange">Orange</SelectItem>
          <SelectItem value="grape">Grape</SelectItem>
          <SelectItem value="pear">Pear</SelectItem>
        </SelectGroup>
      </SelectContent>
    </Select>
  ),
};

export const WithLabel: Story = {
  render: () => (
    <div className="grid gap-1.5">
      <Label>Country</Label>
      <Select>
        <SelectTrigger className="w-[200px]">
          <SelectValue placeholder="Select country" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="us">United States</SelectItem>
          <SelectItem value="uk">United Kingdom</SelectItem>
          <SelectItem value="nl">Netherlands</SelectItem>
          <SelectItem value="de">Germany</SelectItem>
        </SelectContent>
      </Select>
    </div>
  ),
};

export const Small: Story = {
  render: () => (
    <Select>
      <SelectTrigger className="w-[160px]" size="sm">
        <SelectValue placeholder="Size" />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="sm">Small</SelectItem>
        <SelectItem value="md">Medium</SelectItem>
        <SelectItem value="lg">Large</SelectItem>
      </SelectContent>
    </Select>
  ),
};

/**
 * Options with an icon and a one-line description. The open list shows the
 * description under each label; the closed trigger shows only icon and label.
 */
export const WithDescriptions: Story = {
  render: () => (
    <div className="grid w-[320px] gap-1.5">
      <Label htmlFor="story-visibility">Who can find it</Label>
      <Select defaultValue="open">
        <SelectTrigger id="story-visibility" className="w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent className="w-[var(--radix-select-trigger-width)]">
          <SelectItem value="open" description="Everyone in the workspace can find it and read its pages.">
            <Globe />
            Open
          </SelectItem>
          <SelectItem value="closed" description="Everyone can see it exists. Only members can open it.">
            <Users />
            Closed
          </SelectItem>
          <SelectItem value="private" description="Only members know it exists.">
            <Lock />
            Private
          </SelectItem>
        </SelectContent>
      </Select>
    </div>
  ),
};
