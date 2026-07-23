'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { Check, Globe } from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from '@weldsuite/ui/components/popover';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@weldsuite/ui/components/command';

type IntlWithSupportedValues = typeof Intl & {
  supportedValuesOf?: (key: 'timeZone') => string[];
};

const FALLBACK_TIMEZONES = [
  'UTC',
  'Europe/Amsterdam',
  'Europe/London',
  'Europe/Paris',
  'Europe/Berlin',
  'America/New_York',
  'America/Chicago',
  'America/Denver',
  'America/Los_Angeles',
  'Asia/Tokyo',
  'Asia/Shanghai',
  'Asia/Singapore',
  'Australia/Sydney',
];

function getTimezoneList(): string[] {
  const intl = Intl as IntlWithSupportedValues;
  if (typeof intl.supportedValuesOf === 'function') {
    return intl.supportedValuesOf('timeZone');
  }
  return FALLBACK_TIMEZONES;
}

function getTimezoneOffsetLabel(tz: string): string {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      timeZoneName: 'longOffset',
    }).formatToParts(new Date());
    const raw = parts.find((p) => p.type === 'timeZoneName')?.value ?? '';
    if (raw === 'GMT' || raw === '') return 'UTC+00:00';
    return raw.replace('GMT', 'UTC');
  } catch {
    return 'UTC+00:00';
  }
}

function offsetSortKey(label: string): number {
  const match = label.match(/UTC([+-])(\d{2}):(\d{2})/);
  if (!match) return 0;
  const sign = match[1] === '-' ? -1 : 1;
  const hours = match[2] ?? '00';
  const minutes = match[3] ?? '00';
  return sign * (parseInt(hours, 10) * 60 + parseInt(minutes, 10));
}

interface TimezonePickerProps {
  value: string;
  onChange: (tz: string) => void;
  accentColor: string;
}

export function TimezonePicker({ value, onChange, accentColor }: TimezonePickerProps) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [overflows, setOverflows] = useState(true);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const container = containerRef.current;
    if (!container) return;

    const recheck = () => {
      const list = container.querySelector('[data-slot="command-list"]');
      if (!(list instanceof HTMLElement)) return;
      setOverflows(list.scrollHeight > list.clientHeight);
    };

    const id = requestAnimationFrame(recheck);
    return () => cancelAnimationFrame(id);
  }, [open, search]);

  const timezones = useMemo(() => {
    return getTimezoneList()
      .map((tz) => ({ tz, offset: getTimezoneOffsetLabel(tz) }))
      .sort((a, b) => {
        const diff = offsetSortKey(a.offset) - offsetSortKey(b.offset);
        return diff !== 0 ? diff : a.tz.localeCompare(b.tz);
      });
  }, []);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label="Select timezone"
          aria-expanded={open}
          className="flex items-center gap-2.5 text-sm text-gray-500 dark:text-[#9999A1] hover:text-gray-900 dark:hover:text-[#F2F2F4] data-[state=open]:text-gray-900 dark:data-[state=open]:text-[#F2F2F4] text-left -ml-0.5 px-0.5 rounded"
          title="Change timezone"
        >
          <Globe className="h-4 w-4 shrink-0" aria-hidden="true" />
          <span className="underline decoration-dotted decoration-gray-300 dark:decoration-[#3F3F46] underline-offset-4">
            {value}
          </span>
        </button>
      </PopoverTrigger>
      <PopoverContent className="p-0 w-[280px]" align="start">
        <div ref={containerRef}>
          <Command>
            <CommandInput
              placeholder="Search timezone..."
              value={search}
              onValueChange={setSearch}
            />
            <CommandList
              className="max-h-[260px] scrollbar-thin tz-list"
              data-overflows={overflows ? 'true' : 'false'}
            >
              <CommandEmpty>No timezone found.</CommandEmpty>
              <CommandGroup className="!p-0">
                {timezones.map(({ tz, offset }) => {
                  const chosen = tz === value;
                  return (
                    <CommandItem
                      key={tz}
                      value={`${offset} ${tz}`}
                      onSelect={() => {
                        onChange(tz);
                        setOpen(false);
                      }}
                      className="tz-row"
                      data-chosen={chosen ? 'true' : 'false'}
                      style={chosen ? { color: accentColor } : undefined}
                    >
                      <span className="tz-name">
                        <span className="tz-offset">({offset})</span>
                        {tz}
                      </span>
                      {chosen && (
                        <Check
                          className="h-4 w-4 shrink-0"
                          style={{ color: accentColor }}
                          aria-hidden="true"
                        />
                      )}
                    </CommandItem>
                  );
                })}
              </CommandGroup>
            </CommandList>
          </Command>
        </div>
      </PopoverContent>
    </Popover>
  );
}

export function getBrowserTimezone(): string | null {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || null;
  } catch {
    return null;
  }
}
