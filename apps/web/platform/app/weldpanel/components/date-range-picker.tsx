/** Date range picker: presets and a custom from/to (both days included). */

import { useState } from 'react';
import { Calendar, Check } from 'lucide-react';
import { PANEL_DATE_PRESETS, type PanelDateRange } from '@weldsuite/app-api-client/schemas/weldpanel-query';
import { Button } from '@weldsuite/ui/components/button';
import { Input } from '@weldsuite/ui/components/input';
import { Label } from '@weldsuite/ui/components/label';
import { Popover, PopoverContent, PopoverTrigger } from '@weldsuite/ui/components/popover';
import { cn } from '@weldsuite/ui/lib/utils';
import { useI18n } from '@/lib/i18n/provider';
import { isCustomRange, todayYmd } from '../lib/date-range';
import { formatDay } from '../lib/format';

interface DateRangePickerProps {
  value: PanelDateRange;
  onChange: (range: PanelDateRange) => void;
  className?: string;
}

export function DateRangePicker({ value, onChange, className }: Readonly<DateRangePickerProps>) {
  const { t, language } = useI18n();
  const tr = t.weldpanel.analytics.range;
  const [open, setOpen] = useState(false);
  const [from, setFrom] = useState(isCustomRange(value) ? value.from : '');
  const [to, setTo] = useState(isCustomRange(value) ? value.to : '');
  const custom = isCustomRange(value);
  const valid = from !== '' && to !== '' && from <= to;
  const showInvalid = from !== '' && to !== '' && from > to;

  const label = custom ? `${formatDay(value.from, language)} – ${formatDay(value.to, language)}` : tr[value.preset];

  function choose(range: PanelDateRange) {
    onChange(range);
    setOpen(false);
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button type="button" variant="outline" className={cn('h-8 gap-2 font-normal', className)} aria-label={`${tr.label}: ${label}`}>
          <Calendar className="size-4 text-muted-foreground" />
          <span className="truncate">{label}</span>
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-72 p-2">
        <ul className="grid gap-0.5" aria-label={tr.label}>
          {PANEL_DATE_PRESETS.map((preset) => {
            const active = !custom && value.preset === preset;
            return (
              <li key={preset}>
                <button
                  type="button"
                  aria-pressed={active}
                  onClick={() => choose({ preset })}
                  className={cn('flex w-full items-center justify-between rounded-sm px-2 py-1.5 text-left text-sm hover:bg-accent', active && 'font-medium')}
                >
                  {tr[preset]}
                  {active && <Check className="size-4" />}
                </button>
              </li>
            );
          })}
        </ul>
        <div className="mt-2 grid gap-2 border-t px-2 pt-3">
          <p className={cn('text-sm', custom && 'font-medium')}>{tr.custom}</p>
          <div className="grid grid-cols-2 gap-2">
            <div className="grid gap-1">
              <Label htmlFor="weldpanel-range-from" className="text-xs text-muted-foreground">
                {tr.from}
              </Label>
              <Input id="weldpanel-range-from" type="date" value={from} max={to || todayYmd()} onChange={(event) => setFrom(event.target.value)} />
            </div>
            <div className="grid gap-1">
              <Label htmlFor="weldpanel-range-to" className="text-xs text-muted-foreground">
                {tr.to}
              </Label>
              <Input id="weldpanel-range-to" type="date" value={to} min={from || undefined} max={todayYmd()} onChange={(event) => setTo(event.target.value)} />
            </div>
          </div>
          {showInvalid && <p className="text-xs text-destructive">{tr.invalid}</p>}
          <Button type="button" size="sm" disabled={!valid} onClick={() => choose({ from, to })}>
            {tr.apply}
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
