import type { Meta, StoryObj } from "@storybook/react";

import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@weldsuite/ui/components/resizable";

const meta = {
  title: "Layout/Resizable",
  component: ResizablePanelGroup,
  parameters: { layout: "centered" },
} satisfies Meta<typeof ResizablePanelGroup>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Horizontal: Story = {
  render: () => (
    <ResizablePanelGroup
      direction="horizontal"
      className="max-w-md rounded-lg border"
    >
      <ResizablePanel defaultSize={50}>
        <div className="flex h-[200px] items-center justify-center p-6">
          <span className="font-semibold">Panel One</span>
        </div>
      </ResizablePanel>
      <ResizableHandle withHandle />
      <ResizablePanel defaultSize={50}>
        <div className="flex h-[200px] items-center justify-center p-6">
          <span className="font-semibold">Panel Two</span>
        </div>
      </ResizablePanel>
    </ResizablePanelGroup>
  ),
};

export const Vertical: Story = {
  render: () => (
    <ResizablePanelGroup
      direction="vertical"
      className="min-h-[300px] max-w-md rounded-lg border"
    >
      <ResizablePanel defaultSize={30}>
        <div className="flex h-full items-center justify-center p-6">
          <span className="font-semibold">Header</span>
        </div>
      </ResizablePanel>
      <ResizableHandle withHandle />
      <ResizablePanel defaultSize={70}>
        <div className="flex h-full items-center justify-center p-6">
          <span className="font-semibold">Content</span>
        </div>
      </ResizablePanel>
    </ResizablePanelGroup>
  ),
};

export const ThreePanel: Story = {
  render: () => (
    <ResizablePanelGroup
      direction="horizontal"
      className="max-w-lg rounded-lg border"
    >
      <ResizablePanel defaultSize={25}>
        <div className="flex h-[200px] items-center justify-center p-6">
          <span className="font-semibold">Sidebar</span>
        </div>
      </ResizablePanel>
      <ResizableHandle />
      <ResizablePanel defaultSize={50}>
        <div className="flex h-[200px] items-center justify-center p-6">
          <span className="font-semibold">Main</span>
        </div>
      </ResizablePanel>
      <ResizableHandle />
      <ResizablePanel defaultSize={25}>
        <div className="flex h-[200px] items-center justify-center p-6">
          <span className="font-semibold">Detail</span>
        </div>
      </ResizablePanel>
    </ResizablePanelGroup>
  ),
};
