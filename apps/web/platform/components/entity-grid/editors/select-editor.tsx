
import React from 'react';
import { Check } from 'lucide-react';
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
import { useTranslations } from '@weldsuite/i18n/client';
import { cn } from '@/lib/utils';
import { SelectEditorProps } from '../types';

export function SelectEditor({
  value,
  onChange,
  onCommit,
  options,
  optionConfig,
  onOpenChange,
}: SelectEditorProps & { onOpenChange?: (open: boolean) => void }) {
  const t = useTranslations();
  const [open, setOpen] = React.useState(false);

  const handleOpenChange = (next: boolean) => {
    setOpen(next);
    onOpenChange?.(next);
  };

  const handleSelect = (option: string) => {
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
        <Button variant="ghost" className="text-left w-full flex items-center hover:opacity-80 transition-opacity">
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
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
