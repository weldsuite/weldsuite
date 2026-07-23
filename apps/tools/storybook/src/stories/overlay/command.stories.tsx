import type { Meta, StoryObj } from "@storybook/react";
import { Calculator, Calendar, CreditCard, Settings, Smile, User } from "lucide-react";

import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
  CommandShortcut,
} from "@weldsuite/ui/components/command";

const meta = {
  title: "Overlay/Command",
  component: Command,
  parameters: { layout: "centered" },
} satisfies Meta<typeof Command>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  render: () => (
    <Command className="rounded-lg border shadow-md w-[400px]">
      <CommandInput placeholder="Type a command or search..." />
      <CommandList>
        <CommandEmpty>No results found.</CommandEmpty>
        <CommandGroup heading="Suggestions">
          <CommandItem>
            <Calendar className="mr-2 h-4 w-4" />
            Calendar
          </CommandItem>
          <CommandItem>
            <Smile className="mr-2 h-4 w-4" />
            Search Emoji
          </CommandItem>
          <CommandItem>
            <Calculator className="mr-2 h-4 w-4" />
            Calculator
          </CommandItem>
        </CommandGroup>
        <CommandSeparator />
        <CommandGroup heading="Settings">
          <CommandItem>
            <User className="mr-2 h-4 w-4" />
            Profile
            <CommandShortcut>Ctrl+P</CommandShortcut>
          </CommandItem>
          <CommandItem>
            <CreditCard className="mr-2 h-4 w-4" />
            Billing
            <CommandShortcut>Ctrl+B</CommandShortcut>
          </CommandItem>
          <CommandItem>
            <Settings className="mr-2 h-4 w-4" />
            Settings
            <CommandShortcut>Ctrl+S</CommandShortcut>
          </CommandItem>
        </CommandGroup>
      </CommandList>
    </Command>
  ),
};
