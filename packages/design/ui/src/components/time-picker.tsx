import * as React from 'react';
import { Clock } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { Popover, PopoverContent, PopoverTrigger } from '@weldsuite/ui/components/popover';
import { ScrollArea } from '@weldsuite/ui/components/scroll-area';
import { cn } from '@weldsuite/ui/lib/utils';

export interface TimePickerProps {
  value?: string;
  onChange?: (value: string) => void;
  placeholder?: string;
  className?: string;
  id?: string;
}

export function TimePicker({
  value,
  onChange,
  placeholder = 'Select time',
  className,
  id,
}: TimePickerProps) {
  const [open, setOpen] = React.useState(false);

  // Parse the current value (format: "HH:MM")
  const [hours, minutes] = React.useMemo(() => {
    if (!value) return ['', ''];
    const [h, m] = value.split(':');
    return [h, m];
  }, [value]);

  const handleTimeSelect = (type: 'hours' | 'minutes', val: string) => {
    const newHours = type === 'hours' ? val : hours || '00';
    const newMinutes = type === 'minutes' ? val : minutes || '00';
    onChange?.(`${newHours}:${newMinutes}`);
  };

  const formatDisplayTime = () => {
    if (!value) return placeholder;
    const [h, m] = value.split(':');
    const hour = parseInt(h ?? '0', 10);
    const ampm = hour >= 12 ? 'PM' : 'AM';
    const hour12 = hour % 12 || 12;
    return `${hour12}:${m} ${ampm}`;
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          id={id}
          variant="outline"
          className={cn(
            'w-full justify-start text-left font-normal h-9',
            !value && 'text-muted-foreground',
            className,
          )}
        >
          <Clock className="mr-1 h-3.5 w-3.5" />
          {formatDisplayTime()}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-auto p-0" align="start">
        <div className="flex">
          {/* Hours */}
          <ScrollArea className="h-60 w-20 border-r">
            <div className="p-2">
              <div className="text-xs font-medium text-muted-foreground mb-2 px-2">Hour</div>
              {Array.from({ length: 24 }, (_, i) => i.toString().padStart(2, '0')).map((hour) => (
                <Button
                  key={hour}
                  variant={hours === hour ? 'default' : 'ghost'}
                  className="w-full justify-center h-8 mb-1"
                  onClick={() => handleTimeSelect('hours', hour)}
                >
                  {hour}
                </Button>
              ))}
            </div>
          </ScrollArea>
          {/* Minutes */}
          <ScrollArea className="h-60 w-20">
            <div className="p-2">
              <div className="text-xs font-medium text-muted-foreground mb-2 px-2">Min</div>
              {Array.from({ length: 60 }, (_, i) => i.toString().padStart(2, '0')).map((minute) => (
                <Button
                  key={minute}
                  variant={minutes === minute ? 'default' : 'ghost'}
                  className="w-full justify-center h-8 mb-1"
                  onClick={() => handleTimeSelect('minutes', minute)}
                >
                  {minute}
                </Button>
              ))}
            </div>
          </ScrollArea>
        </div>
      </PopoverContent>
    </Popover>
  );
}
