/**
 * `SelectPropertyRow` — a Details-tab row whose value is picked from a fixed
 * list (Lifecycle stage, Language, …). Same icon + label + value geometry as
 * `PropertyRow`, with a searchable popover instead of a free-text editor.
 *
 * A stored value that isn't in `options` (e.g. legacy free text saved before
 * the field became a picker) still renders as plain text, and can be replaced
 * or cleared from the list.
 */

import { useState, type ComponentType } from 'react';
import { useTranslations } from '@weldsuite/i18n/client';
import { Popover, PopoverContent, PopoverTrigger } from '@weldsuite/ui/components/popover';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@weldsuite/ui/components/command';
import { ClearPickerItem, PickerCheck, PickerFooter, PickerScrollArea } from '@/components/shared/picker-menu';

export interface SelectPropertyOption {
  value: string;
  label: string;
}

export interface SelectPropertyRowProps {
  icon: ComponentType<{ className?: string }>;
  label: string;
  value: string | null | undefined;
  options: SelectPropertyOption[];
  /** Called with the picked value, or `null` when the user clears the field. */
  onChange: (next: string | null) => void;
  /** Placeholder when empty. Falls back to `Set {label}…`. */
  placeholder?: string;
}

export function SelectPropertyRow({
  icon: Icon,
  label,
  value,
  options,
  onChange,
  placeholder,
}: Readonly<SelectPropertyRowProps>) {
  const st = useTranslations();
  const [open, setOpen] = useState(false);
  const selected = value ? options.find((o) => o.value === value) : undefined;
  const display = selected?.label ?? value ?? '';

  return (
    <div className="grid grid-cols-[120px_minmax(0,1fr)_auto] gap-2 items-center group/row min-h-[32px]">
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Icon className="h-4 w-4" />
        <span>{label}</span>
      </div>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          {/* No hover box: the value (or placeholder) underlines on hover,
              like the task panel's due date and repeat values. */}
          <button
            type="button"
            aria-label={label}
            className="group/field text-sm min-w-0 justify-self-start min-h-[32px] py-1 text-left cursor-pointer rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {display ? (
              <span className="text-foreground break-words [overflow-wrap:anywhere] group-hover/field:underline">{display}</span>
            ) : (
              <span className="text-muted-foreground group-hover/field:underline">
                {placeholder ?? st('sweep.entities.setFieldPlaceholder', { label })}
              </span>
            )}
          </button>
        </PopoverTrigger>
        <PopoverContent className="w-56 p-0" align="start">
          <Command>
            <CommandInput placeholder={st('sweep.entities.searchEllipsisPlaceholder')} />
            <CommandList className="max-h-none overflow-visible">
              <PickerScrollArea>
                <CommandEmpty>{st('sweep.entities.noResults')}</CommandEmpty>
                <CommandGroup>
                  {options.map((opt) => (
                    <CommandItem
                      key={opt.value}
                      value={opt.label}
                      onSelect={() => {
                        if (opt.value !== value) onChange(opt.value);
                        setOpen(false);
                      }}
                    >
                      <span className="truncate">{opt.label}</span>
                      <PickerCheck selected={opt.value === value} />
                    </CommandItem>
                  ))}
                </CommandGroup>
              </PickerScrollArea>
              {value ? (
                <PickerFooter>
                  <ClearPickerItem
                    label={st('sweep.entities.clear')}
                    onSelect={() => {
                      onChange(null);
                      setOpen(false);
                    }}
                  />
                </PickerFooter>
              ) : null}
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
      <div />
    </div>
  );
}
