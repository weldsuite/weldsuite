import type { Meta, StoryObj } from "@storybook/react";
import { useState } from "react";
import { ChevronsUpDown } from "lucide-react";

import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@weldsuite/ui/components/collapsible";
import { Button } from "@weldsuite/ui/components/button";

const meta = {
  title: "Layout/Collapsible",
  component: Collapsible,
  parameters: { layout: "centered" },
} satisfies Meta<typeof Collapsible>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  render: () => {
    const [isOpen, setIsOpen] = useState(false);
    return (
      <Collapsible open={isOpen} onOpenChange={setIsOpen} className="w-[350px] space-y-2">
        <div className="flex items-center justify-between space-x-4 px-4">
          <h4 className="text-sm font-semibold">3 repositories</h4>
          <CollapsibleTrigger asChild>
            <Button variant="ghost" size="sm">
              <ChevronsUpDown className="h-4 w-4" />
              <span className="sr-only">Toggle</span>
            </Button>
          </CollapsibleTrigger>
        </div>
        <div className="rounded-md border px-4 py-2 text-sm">
          @weldsuite/ui
        </div>
        <CollapsibleContent className="space-y-2">
          <div className="rounded-md border px-4 py-2 text-sm">
            @weldsuite/db
          </div>
          <div className="rounded-md border px-4 py-2 text-sm">
            @weldsuite/core-api-client
          </div>
        </CollapsibleContent>
      </Collapsible>
    );
  },
};
