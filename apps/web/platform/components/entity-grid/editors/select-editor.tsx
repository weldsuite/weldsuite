
import React from 'react';
import { Check, X } from 'lucide-react';
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
import { useTranslations } from '@weldsuite/i18n/client';
import { cn } from '@/lib/utils';
import { SelectEditorProps } from '../types';

export function SelectEditor({
  value,
  onChange,
  onCommit,
  options,
  optionConfig,
  allowClear,
  onOpenChange,
}: SelectEditorProps & { onOpenChange?: (open: boolean) => void }) {
  const t = useTranslations();
  const [open, setOpen] = React.useState(false);

  const handleOpenChange = (next: boolean) => {
    setOpen(next);
    onOpenChange?.(next);
  };

  const handleSelect = (option: string | null) => {
    onChange?.(option);
    handleOpenChange(false);
    onCommit();
  };

  const renderValue = () => {
    if (!value) {
      return <span className="text-[14px] text-muted-foreground">&nbsp;</span>;
    }

    const config = optionConfig?.[value];
    if (config) {
      return (
        <span
          className={cn(
            'inline-flex items-center h-[22px] px-2 rounded text-[12px] font-medium leading-none',
            config.bg,
            config.color
          )}
        >
          {config.label}
        </span>
      );
    }

    return (
      <span className="inline-flex items-center h-[22px] px-2 rounded text-[12px] font-medium leading-none bg-secondary text-secondary-foreground">
        {value}
      </span>
    );
  };

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>
        {/* Spans the whole cell: the cell is rendered flush and hands its
            padding down as `--grid-cell-padding`. */}
        <Button
          variant="ghost"
          className="text-left w-full h-full flex items-center justify-start rounded-none p-[var(--grid-cell-padding,0)] hover:opacity-80 transition-opacity focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring"
        >
          {renderValue()}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-48 p-0" align="start" sideOffset={7} collisionPadding={12}>
        <Command>
          <CommandInput placeholder={t('sweep.entities.searchEllipsisPlaceholder')} />
          <CommandList>
            <CommandEmpty>{t('sweep.entities.noOptionFound')}</CommandEmpty>
            <CommandGroup className="px-1 py-1">
              {options.map((option) => {
                const config = optionConfig?.[option];
                return (
                  <CommandItem
                    key={option}
                    onSelect={() => handleSelect(option)}
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
                    {value === option && (
                      <Check className="ml-auto text-primary" />
                    )}
                  </CommandItem>
                );
              })}
              {allowClear && value && (
                <CommandItem
                  value="__clear__"
                  onSelect={() => handleSelect(null)}
                  className="text-destructive data-[selected=true]:text-destructive"
                >
                  <X className="text-destructive" />
                  <span>{t('sweep.entities.clear')}</span>
                </CommandItem>
              )}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
