
import React from 'react';
import { Calendar as CalendarPicker } from '@weldsuite/ui/components/calendar';
import { Button } from '@weldsuite/ui/components/button';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@weldsuite/ui/components/popover';
import { cn } from '@/lib/utils';
import { DateEditorProps } from '../types';
import { formatDate } from '../utils/calculations';

export function DateEditor({
  value,
  onChange,
  onCommit,
  placeholder = 'Select date',
}: DateEditorProps) {
  const dateValue = value ? (value instanceof Date ? value : new Date(value)) : undefined;
  const isValidDate = dateValue && !isNaN(dateValue.getTime());

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="ghost" className="w-full h-full flex items-center cursor-pointer text-left">
          <span
            className={cn(
              'text-[14px]',
              isValidDate
                ? 'text-foreground/80'
                : 'text-muted-foreground'
            )}
          >
            {isValidDate ? formatDate(dateValue) : null}
          </span>
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-auto overflow-hidden p-0" align="start" sideOffset={9} alignOffset={-12} collisionPadding={12}>
        <CalendarPicker
          mode="single"
          selected={isValidDate ? dateValue : undefined}
          captionLayout="dropdown"
          onSelect={(date) => {
            onChange?.(date || null);
            onCommit();
          }}
        />
      </PopoverContent>
    </Popover>
  );
}
