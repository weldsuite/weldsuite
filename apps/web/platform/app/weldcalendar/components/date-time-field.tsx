import { useMemo, useState } from 'react';
import { format } from 'date-fns';
import { Button } from '@weldsuite/ui/components/button';
import { Calendar } from '@weldsuite/ui/components/calendar';
import { Popover, PopoverContent, PopoverTrigger } from '@weldsuite/ui/components/popover';
import { cn } from '@/lib/utils';
import { WEEK_STARTS_ON, formatClock } from '../lib/calendar-format';
import type { TimeFormat } from '../lib/calendar-format';

/** Minutes between the times offered in the list. */
const TIME_STEP_MINUTES = 15;

const isValidDate = (d: Date | null | undefined): d is Date => d instanceof Date && !Number.isNaN(d.getTime());

const minutesOfDay = (d: Date) => d.getHours() * 60 + d.getMinutes();

const atMinutes = (day: Date, minutes: number) => {
  const next = new Date(day);
  next.setHours(0, minutes, 0, 0);
  return next;
};

/** "Mon, Oct 5"; a date in another year trades the weekday for the year ("Oct 5, 2027") to stay as short. */
function formatDay(date: Date): string {
  return format(date, date.getFullYear() === new Date().getFullYear() ? 'EEE, MMM d' : 'MMM d, yyyy');
}

/**
 * A date + time of day, picked with a calendar popover and a list of times.
 * All-day values only show the date. The trigger with `id` is the date button,
 * so a `<Label htmlFor>` names it; the time button is named by `labelId` plus
 * its own text ("Start 9:00 AM").
 */
export function DateTimeField({
  id,
  labelId,
  value,
  onChange,
  allDay = false,
  timeFormat = '12h',
  invalid = false,
  fallback,
}: Readonly<{
  id: string;
  labelId: string;
  value: Date | null | undefined;
  onChange: (next: Date) => void;
  allDay?: boolean;
  timeFormat?: TimeFormat;
  invalid?: boolean;
  /** Day and time to start from while there is no value yet (an end with no end time). */
  fallback?: Date | null;
}>) {
  const [dateOpen, setDateOpen] = useState(false);
  const [timeOpen, setTimeOpen] = useState(false);
  const current = isValidDate(value) ? value : null;
  const base = current ?? (isValidDate(fallback) ? fallback : null) ?? new Date();
  const selectedMinutes = current ? minutesOfDay(current) : null;

  // Every quarter hour, plus the current time when it sits between two of them.
  const timeOptions = useMemo(() => {
    const options = Array.from({ length: (24 * 60) / TIME_STEP_MINUTES }, (_, i) => i * TIME_STEP_MINUTES);
    if (selectedMinutes !== null && !options.includes(selectedMinutes)) {
      options.push(selectedMinutes);
      options.sort((a, b) => a - b);
    }
    return options;
  }, [selectedMinutes]);

  const timeId = `${id}-time`;

  return (
    <div className="flex items-center gap-2">
      <Popover open={dateOpen} onOpenChange={setDateOpen}>
        <PopoverTrigger asChild>
          <Button
            id={id}
            type="button"
            variant="outline"
            aria-invalid={invalid}
            className={cn(
              'h-9 min-w-0 flex-1 justify-start px-3 font-normal shadow-none',
              !current && 'text-muted-foreground',
            )}
          >
            <span className="truncate">{current ? formatDay(current) : '–'}</span>
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-auto overflow-hidden p-0" align="start">
          <Calendar
            mode="single"
            weekStartsOn={WEEK_STARTS_ON}
            selected={current ?? undefined}
            defaultMonth={base}
            onSelect={(day) => {
              if (day) onChange(atMinutes(day, minutesOfDay(base)));
              setDateOpen(false);
            }}
          />
        </PopoverContent>
      </Popover>

      {!allDay && (
        // Modal, so the list scrolls inside a dialog (which locks scrolling
        // for everything outside itself, portaled popovers included).
        <Popover open={timeOpen} onOpenChange={setTimeOpen} modal>
          <PopoverTrigger asChild>
            <Button
              id={timeId}
              type="button"
              variant="outline"
              aria-invalid={invalid}
              aria-labelledby={`${labelId} ${timeId}`}
              className={cn(
                'h-9 shrink-0 justify-start px-3 font-normal tabular-nums shadow-none',
                !current && 'text-muted-foreground',
              )}
            >
              {current ? formatClock(current, timeFormat) : '–'}
            </Button>
          </PopoverTrigger>
          <PopoverContent className="w-32 p-1" align="end">
            <div role="listbox" aria-labelledby={labelId} className="max-h-60 overflow-y-auto">
              {timeOptions.map((minutes) => {
                const selected = minutes === selectedMinutes;
                return (
                  <button
                    key={minutes}
                    type="button"
                    role="option"
                    aria-selected={selected}
                    // Open on the current time rather than at midnight.
                    ref={selected ? (el) => el?.scrollIntoView?.({ block: 'center' }) : undefined}
                    onClick={() => {
                      onChange(atMinutes(base, minutes));
                      setTimeOpen(false);
                    }}
                    className={cn(
                      'flex w-full items-center rounded-sm px-2 py-1.5 text-left text-sm tabular-nums outline-none hover:bg-accent hover:text-accent-foreground focus-visible:bg-accent',
                      selected && 'bg-accent font-medium text-accent-foreground',
                    )}
                  >
                    {formatClock(atMinutes(base, minutes), timeFormat)}
                  </button>
                );
              })}
            </div>
          </PopoverContent>
        </Popover>
      )}
    </div>
  );
}
