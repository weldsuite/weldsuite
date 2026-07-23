import type { Meta, StoryObj } from "@storybook/react";

import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@weldsuite/ui/components/tabs";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@weldsuite/ui/components/card";

const meta = {
  title: "Layout/Tabs",
  component: Tabs,
  parameters: { layout: "centered" },
} satisfies Meta<typeof Tabs>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  render: () => (
    <Tabs defaultValue="account" className="w-[400px]">
      <TabsList>
        <TabsTrigger value="account">Account</TabsTrigger>
        <TabsTrigger value="password">Password</TabsTrigger>
      </TabsList>
      <TabsContent value="account">
        <Card>
          <CardHeader>
            <CardTitle>Account</CardTitle>
            <CardDescription>
              Make changes to your account here.
            </CardDescription>
          </CardHeader>
          <CardContent className="text-sm text-muted-foreground">
            Account settings content goes here.
          </CardContent>
        </Card>
      </TabsContent>
      <TabsContent value="password">
        <Card>
          <CardHeader>
            <CardTitle>Password</CardTitle>
            <CardDescription>Change your password here.</CardDescription>
          </CardHeader>
          <CardContent className="text-sm text-muted-foreground">
            Password settings content goes here.
          </CardContent>
        </Card>
      </TabsContent>
    </Tabs>
  ),
};
