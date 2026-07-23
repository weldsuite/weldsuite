
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
import { Badge } from '@weldsuite/ui/components/badge';
import { Checkbox } from '@weldsuite/ui/components/checkbox';
import { useTranslations } from '@weldsuite/i18n/client';
import { cn } from '@/lib/utils';
import { MultiSelectEditorProps } from '../types';

export function MultiSelectEditor({
  value = [],
  onChange,
  options,
  optionConfig,
  onOpenChange,
}: MultiSelectEditorProps & { onOpenChange?: (open: boolean) => void }) {
  const t = useTranslations();
  const [open, setOpen] = React.useState(false);
  const handleOpenChange = (next: boolean) => {
    setOpen(next);
    onOpenChange?.(next);
  };
  const selectedValues = value || [];

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
        <Button variant="ghost" className="text-left w-full flex items-center gap-1 flex-wrap">
          {renderValue()}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-48 p-0" align="start" sideOffset={9} alignOffset={-12} collisionPadding={12}>
        <Command>
          <CommandInput placeholder={t('sweep.entities.searchEllipsisPlaceholder')} />
          <CommandList>
            <CommandEmpty>{t('sweep.entities.noOptionFound')}</CommandEmpty>
            <CommandGroup className="px-1 py-1">
              {options.map((option) => {
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
