import { useEffect, useMemo, useRef } from 'react';
import { useDictionary, type DefaultReactSuggestionItem, type SuggestionMenuProps } from '@blocknote/react';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandItem,
  CommandList,
  CommandShortcut,
} from '@weldsuite/ui/components/command';

type Group<T> = { heading?: string; entries: { item: T; index: number }[] };

/** Consecutive items sharing a `group`, in menu order. */
function groupItems<T extends DefaultReactSuggestionItem>(items: T[]): Group<T>[] {
  const groups: Group<T>[] = [];
  items.forEach((item, index) => {
    const last = groups[groups.length - 1];
    if (last && last.heading === item.group) last.entries.push({ item, index });
    else groups.push({ heading: item.group, entries: [{ item, index }] });
  });
  return groups;
}

/**
 * The `/` and `@` menus, rendered with the stock shadcn `Command` component
 * instead of BlockNote's own menu markup — so rows, headings and shortcuts
 * look like every other command list in the app.
 *
 * BlockNote keeps owning the behaviour: it filters the items, tracks the
 * keyboard selection (`selectedIndex`) and runs the chosen item. `Command` is
 * therefore used display-only — no filtering, and its highlight mirrors
 * BlockNote's selection rather than following the pointer.
 */
export function SuggestionMenu<T extends DefaultReactSuggestionItem>({
  items,
  selectedIndex,
  onItemClick,
}: Readonly<SuggestionMenuProps<T>>) {
  const dictionary = useDictionary();
  const listRef = useRef<HTMLDivElement>(null);
  const groups = useMemo(() => groupItems(items), [items]);

  // Keep the keyboard selection in view while arrowing through the list. Looked
  // up by value: `data-selected` only moves once Command has re-rendered. The
  // first row of a group brings its heading along, as Command itself does.
  useEffect(() => {
    if (selectedIndex === undefined) return;
    const row = listRef.current?.querySelector(`[data-value="${selectedIndex}"]`);
    if (!row) return;
    if (!row.previousElementSibling) {
      row.closest('[cmdk-group]')?.querySelector('[cmdk-group-heading]')?.scrollIntoView({ block: 'nearest' });
    }
    row.scrollIntoView({ block: 'nearest' });
  }, [selectedIndex]);

  return (
    <Command
      shouldFilter={false}
      disablePointerSelection
      value={selectedIndex === undefined ? '' : String(selectedIndex)}
      // The caret must stay in the document: typing continues to filter the menu.
      onMouseDown={(event) => event.preventDefault()}
      className="bn-suggestion-list h-auto w-[324px] max-w-[calc(100vw-16px)] border shadow-md"
    >
      <CommandList ref={listRef} className="max-h-[446px]">
        <CommandEmpty>{dictionary.suggestion_menu.no_items_title}</CommandEmpty>
        {groups.map((group) => (
          <CommandGroup key={group.entries[0]!.index} heading={group.heading}>
            {group.entries.map(({ item, index }) => (
              <CommandItem
                key={index}
                value={String(index)}
                onSelect={() => onItemClick?.(item)}
                className="cursor-pointer hover:bg-accent hover:text-accent-foreground"
              >
                {item.icon}
                <span className="truncate">{item.title}</span>
                {item.badge ? <CommandShortcut>{item.badge}</CommandShortcut> : null}
              </CommandItem>
            ))}
          </CommandGroup>
        ))}
      </CommandList>
    </Command>
  );
}
