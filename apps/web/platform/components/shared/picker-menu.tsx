import * as React from 'react';
import { Check, Trash2 } from 'lucide-react';
import { CommandGroup, CommandItem, CommandSeparator } from '@weldsuite/ui/components/command';
import { cn } from '@/lib/utils';

/**
 * Building blocks for field pickers (status, assignees, labels, owner, …) so
 * every picker in the platform's panels is the stock shadcn Command list with
 * the same check mark, the same "Clear" row and the same scrolling behaviour.
 */

/** Trailing check on the active row of a picker — shadcn's combobox pattern. */
export function PickerCheck({ selected }: Readonly<{ selected: boolean }>) {
  return <Check className={cn('ml-auto', selected ? 'opacity-100' : 'opacity-0')} />;
}

/** "Clear" row of a picker, styled like shadcn's destructive menu item. */
export function ClearPickerItem({ label, onSelect }: Readonly<{ label: string; onSelect: () => void }>) {
  return (
    <CommandItem
      onSelect={onSelect}
      className="text-destructive data-[selected=true]:bg-destructive/10 data-[selected=true]:text-destructive [&_svg]:!text-destructive"
    >
      <Trash2 />
      {label}
    </CommandItem>
  );
}

/**
 * A picker list is split in two so the "Clear" row is always visible and the
 * scrollbar stops above it: the options scroll inside `PickerScrollArea`, and
 * `PickerFooter` sits below it. Both stay inside `CommandList` (which must
 * then not scroll itself: `max-h-none overflow-visible`), so arrow-key
 * navigation still reaches the footer row.
 */
export function PickerScrollArea({ children }: Readonly<{ children: React.ReactNode }>) {
  // Same scroll behaviour the stock CommandList has.
  return <div className="max-h-[300px] scroll-py-1 overflow-x-hidden overflow-y-auto">{children}</div>;
}

export function PickerFooter({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <>
      <CommandSeparator />
      <CommandGroup>{children}</CommandGroup>
    </>
  );
}

/**
 * For pickers without a search input: move focus to the Command list when the
 * popover opens, so the arrow keys and Enter work as they do in a menu.
 */
export function focusPickerList(event: Event) {
  event.preventDefault();
  (event.currentTarget as HTMLElement | null)?.querySelector<HTMLElement>('[cmdk-root]')?.focus();
}
