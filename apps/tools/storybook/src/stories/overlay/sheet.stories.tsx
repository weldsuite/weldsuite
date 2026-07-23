import type { Meta, StoryObj } from "@storybook/react";

import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@weldsuite/ui/components/sheet";
import { Button } from "@weldsuite/ui/components/button";
import { Input } from "@weldsuite/ui/components/input";
import { Label } from "@weldsuite/ui/components/label";

const meta = {
  title: "Overlay/Sheet",
  component: Sheet,
  parameters: { layout: "centered" },
} satisfies Meta<typeof Sheet>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Right: Story = {
  render: () => (
    <Sheet>
      <SheetTrigger asChild>
        <Button variant="outline">Open Sheet</Button>
      </SheetTrigger>
      <SheetContent>
        <SheetHeader>
          <SheetTitle>Edit Profile</SheetTitle>
          <SheetDescription>
            Make changes to your profile here. Click save when you're done.
          </SheetDescription>
        </SheetHeader>
        <div className="grid gap-4 py-4">
          <div className="grid grid-cols-4 items-center gap-4">
            <Label className="text-right">Name</Label>
            <Input className="col-span-3" defaultValue="John Doe" />
          </div>
          <div className="grid grid-cols-4 items-center gap-4">
            <Label className="text-right">Username</Label>
            <Input className="col-span-3" defaultValue="@johndoe" />
          </div>
        </div>
        <SheetFooter>
          <Button type="submit">Save changes</Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  ),
};

export const Left: Story = {
  render: () => (
    <Sheet>
      <SheetTrigger asChild>
        <Button variant="outline">Open Left</Button>
      </SheetTrigger>
      <SheetContent side="left">
        <SheetHeader>
          <SheetTitle>Navigation</SheetTitle>
          <SheetDescription>Browse the application.</SheetDescription>
        </SheetHeader>
        <div className="py-4 space-y-2">
          <Button variant="ghost" className="w-full justify-start">Dashboard</Button>
          <Button variant="ghost" className="w-full justify-start">Projects</Button>
          <Button variant="ghost" className="w-full justify-start">Settings</Button>
        </div>
      </SheetContent>
    </Sheet>
  ),
};
