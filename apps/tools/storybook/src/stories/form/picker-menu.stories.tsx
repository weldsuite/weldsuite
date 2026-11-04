import type { Meta, StoryObj } from '@storybook/react';
import { useState } from 'react';
import { ChevronDown } from 'lucide-react';

import {
  ClearPickerItem,
  PickerCheck,
  PickerFooter,
  PickerScrollArea,
  focusPickerList,
} from '@weldsuite/ui/components/picker-menu';
import { Button } from '@weldsuite/ui/components/button';
import { Command, CommandGroup, CommandItem, CommandList } from '@weldsuite/ui/components/command';
import { Popover, PopoverContent, PopoverTrigger } from '@weldsuite/ui/components/popover';

const STATUSES = ['Backlog', 'To do', 'In progress', 'In review', 'Done', 'Cancelled', 'Blocked', 'On hold'];

const meta = {
  title: 'Form/PickerMenu',
  component: PickerCheck,
  args: { selected: true },
} satisfies Meta<typeof PickerCheck>;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * A field picker built from the stock Command list: `PickerCheck` marks the
 * active row, the options scroll inside `PickerScrollArea`, and the "Clear"
 * row stays visible in `PickerFooter`.
 */
export const StatusPicker: Story = {
  render: () => {
    const [open, setOpen] = useState(false);
    const [value, setValue] = useState<string | null>('In progress');
    return (
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button variant="outline" size="sm" className="w-44 justify-between">
            {value ?? 'No status'}
            <ChevronDown className="h-4 w-4 opacity-50" />
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-56 p-0" align="start" onOpenAutoFocus={focusPickerList}>
          <Command>
            <CommandList className="max-h-none overflow-visible">
              <PickerScrollArea>
                <CommandGroup>
                  {STATUSES.map((status) => (
                    <CommandItem
                      key={status}
                      onSelect={() => {
                        setValue(status);
                        setOpen(false);
                      }}
                    >
                      {status}
                      <PickerCheck selected={value === status} />
                    </CommandItem>
                  ))}
                </CommandGroup>
              </PickerScrollArea>
              {value && (
                <PickerFooter>
                  <ClearPickerItem
                    label="Clear status"
                    onSelect={() => {
                      setValue(null);
                      setOpen(false);
                    }}
                  />
                </PickerFooter>
              )}
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
    );
  },
};
