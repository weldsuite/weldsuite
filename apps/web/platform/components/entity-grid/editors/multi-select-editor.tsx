
import React from 'react';
import { Button } from '@weldsuite/ui/components/button';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@weldsuite/ui/components/popover';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@weldsuite/ui/components/command';
import { Checkbox } from '@weldsuite/ui/components/checkbox';
import { useTranslations } from '@weldsuite/i18n/client';
import { cn } from '@/lib/utils';
import { MultiSelectEditorProps } from '../types';

export function MultiSelectEditor({
  value = [],
  onChange,
  options,
  optionConfig,
  allowCreate,
  onOpenChange,
}: MultiSelectEditorProps & { onOpenChange?: (open: boolean) => void }) {
  const t = useTranslations();
  const [open, setOpen] = React.useState(false);
  const [search, setSearch] = React.useState('');
  const handleOpenChange = (next: boolean) => {
    setOpen(next);
    if (!next) setSearch('');
    onOpenChange?.(next);
  };
  const selectedValues = value || [];

  // Values already on the record stay listed (so they can be toggled off)
  // even when they are not in the suggested options.
  const allOptions = allowCreate
    ? [...options, ...selectedValues.filter((v) => !options.includes(v))]
    : options;
  const trimmedSearch = search.trim();
  const canCreate =
    !!allowCreate &&
    trimmedSearch.length > 0 &&
    !allOptions.some((o) => o.toLowerCase() === trimmedSearch.toLowerCase());

  const handleCreate = () => {
    if (!canCreate) return;
    onChange?.([...selectedValues, trimmedSearch]);
    setSearch('');
  };

  const handleToggle = (option: string) => {
    const newValues = selectedValues.includes(option)
      ? selectedValues.filter((v) => v !== option)
      : [...selectedValues, option];
    onChange?.(newValues);
  };

  const renderValue = () => {
    if (selectedValues.length === 0) {
      return <span className="text-[14px] text-muted-foreground">&nbsp;</span>;
    }

    return (
      <div className="flex items-center gap-1 flex-wrap">
        {selectedValues.slice(0, 2).map((v) => {
          const config = optionConfig?.[v];
          return (
            <span
              key={v}
              className={cn(
                'inline-flex items-center h-[22px] px-2 rounded text-[12px] font-medium leading-none',
                config?.bg ?? 'bg-secondary',
                config?.color ?? 'text-secondary-foreground'
              )}
            >
              {config?.label || v}
            </span>
          );
        })}
        {selectedValues.length > 2 && (
          <span className="text-[12px] text-muted-foreground">
            +{selectedValues.length - 2}
          </span>
        )}
      </div>
    );
  };

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>
        <Button variant="ghost" className="text-left w-full flex items-center justify-start px-0 gap-1 flex-wrap">
          {renderValue()}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-48 p-0" align="start" sideOffset={9} alignOffset={-12} collisionPadding={12}>
        <Command>
          <CommandInput
            placeholder={t('sweep.entities.searchEllipsisPlaceholder')}
            value={search}
            onValueChange={setSearch}
          />
          <CommandList>
            {!canCreate && <CommandEmpty>{t('sweep.entities.noOptionFound')}</CommandEmpty>}
            <CommandGroup className="px-1 py-1">
              {/* First, so Enter on a typed value creates it. */}
              {canCreate && (
                <CommandItem
                  key="__create__"
                  value={`__create__${trimmedSearch}`}
                  forceMount
                  onSelect={handleCreate}
                >
                  <span>{t('sweep.entities.createOptionFromSearch', { value: trimmedSearch })}</span>
                </CommandItem>
              )}
              {allOptions.map((option) => {
                const config = optionConfig?.[option];
                const isSelected = selectedValues.includes(option);
                return (
                  <CommandItem
                    key={option}
                    onSelect={() => handleToggle(option)}
                  >
                    {config ? (
                      <span
                        className={cn(
                          'inline-flex items-center h-[22px] px-2 rounded text-[12px] font-medium leading-none',
                          config.bg,
                          config.color
                        )}
                      >
                        {config.label}
                      </span>
                    ) : (
                      <span>{option}</span>
                    )}
                    <Checkbox checked={isSelected} className="ml-auto" />
                  </CommandItem>
                );
              })}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
