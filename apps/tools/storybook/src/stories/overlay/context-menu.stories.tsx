import type { Meta, StoryObj } from "@storybook/react";

import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from "@weldsuite/ui/components/context-menu";

const meta = {
  title: "Overlay/ContextMenu",
  component: ContextMenu,
  parameters: { layout: "centered" },
} satisfies Meta<typeof ContextMenu>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  render: () => (
    <ContextMenu>
      <ContextMenuTrigger className="flex h-[150px] w-[300px] items-center justify-center rounded-md border border-dashed text-sm">
        Right click here
      </ContextMenuTrigger>
      <ContextMenuContent className="w-64">
        <ContextMenuItem>
          Back <ContextMenuShortcut>Alt+Left</ContextMenuShortcut>
        </ContextMenuItem>
        <ContextMenuItem>
          Forward <ContextMenuShortcut>Alt+Right</ContextMenuShortcut>
        </ContextMenuItem>
        <ContextMenuItem>
          Reload <ContextMenuShortcut>Ctrl+R</ContextMenuShortcut>
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuSub>
          <ContextMenuSubTrigger>More Tools</ContextMenuSubTrigger>
          <ContextMenuSubContent className="w-48">
            <ContextMenuItem>Save Page As...</ContextMenuItem>
            <ContextMenuItem>Create Shortcut...</ContextMenuItem>
            <ContextMenuItem>Developer Tools</ContextMenuItem>
          </ContextMenuSubContent>
        </ContextMenuSub>
        <ContextMenuSeparator />
        <ContextMenuItem>View Source</ContextMenuItem>
        <ContextMenuItem>Inspect</ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  ),
};
