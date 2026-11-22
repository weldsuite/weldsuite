/** Attendance → Schedule: the pieces the day, week and month views share. */

import type { CSSProperties, ReactNode } from 'react';
import { format } from 'date-fns';
import { ArrowRight, Search } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { useTranslations } from '@weldsuite/i18n/client';
import type { HrShift } from '@weldsuite/app-api-client/domains/weldhr';
import { formatClockCompact, formatClockRange, type TimeFormat } from '@/app/weldcalendar/lib/calendar-format';
import { cn } from '@/lib/utils';
import { formatDate } from '../../components/shared';
import { shiftColor, timeOffColor, type TimeOff } from './schedule-model';

/** A shift in WeldCalendar's event style: hours, then type of work, client account, break and notes. */
export function ShiftBlock({
  shift,
  timeFormat,
  onClick,
  className,
  style,
  wrapTime = false,
  lines,
  children,
}: Readonly<{
  shift: HrShift;
  timeFormat: TimeFormat;
  onClick?: () => void;
  className?: string;
  style?: CSSProperties;
  /** Let the time range wrap onto a second line instead of cutting it off (the day view has the height). */
  wrapTime?: boolean;
  /**
   * Only the first lines, for the week roster's even rows: 1 = the hours, 2 =
   * the hours and the type of work (or client). The rest goes in the tooltip.
   */
  lines?: 1 | 2;
  /** Drawn inside the block, e.g. the day view's break band. */
  children?: ReactNode;
}>) {
  const t = useTranslations();
  const breakRange =
    shift.breakStartsAt && shift.breakEndsAt
      ? formatClockRange(new Date(shift.breakStartsAt), new Date(shift.breakEndsAt), timeFormat)
      : null;
  const timeRange = formatClockRange(new Date(shift.startsAt), new Date(shift.endsAt), timeFormat);
  const breakText = breakRange ? t('weldhr.attendance.schedule.break', { range: breakRange }) : null;

  if (lines) {
    const second = shift.workType ?? shift.companyName;
    // "8 AM – 5 PM" fits a narrow day column; the tooltip has the full range.
    const compactRange = `${formatClockCompact(new Date(shift.startsAt), timeFormat)} – ${formatClockCompact(new Date(shift.endsAt), timeFormat)}`;
    return (
      <button
        type="button"
        onClick={onClick}
        disabled={!onClick}
        title={[timeRange, shift.workType, shift.companyName, breakText, shift.notes].filter(Boolean).join('\n')}
        className={cn(
          'block w-full shrink-0 rounded-[6px] border border-white/10 px-2 text-left text-[12px] leading-tight text-white transition-[filter] hover:brightness-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default disabled:hover:brightness-100',
          className,
        )}
        style={{ backgroundColor: shiftColor(shift), ...style }}
      >
        <span className="block truncate font-semibold">{compactRange}</span>
        {lines === 2 && second && <span className="mt-[3px] block truncate text-white/80">{second}</span>}
      </button>
    );
  }

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={!onClick}
      className={cn(
        'block w-full shrink-0 rounded-[6px] border border-white/10 px-2.5 py-1.5 text-left text-[12px] leading-tight text-white transition-[filter] hover:brightness-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default disabled:hover:brightness-100',
        className,
      )}
      style={{ backgroundColor: shiftColor(shift), ...style }}
    >
      {children}
      <span className={cn('relative block font-semibold', wrapTime ? 'break-words' : 'truncate')}>
        {timeRange}
      </span>
      {shift.workType && <span className="relative mt-[3px] block truncate">{shift.workType}</span>}
      {shift.companyName && <span className="relative mt-[3px] block truncate text-white/70">{shift.companyName}</span>}
      {breakText && <span className="relative mt-[3px] block truncate text-white/70">{breakText}</span>}
      {shift.notes && <span className="relative mt-[3px] block truncate text-white/70">{shift.notes}</span>}
    </button>
  );
}

/** "Tue 17 Nov" */
function shortDay(isoDate: string): string {
  return format(new Date(`${isoDate}T12:00:00`), 'EEE d MMM');
}

/**
 * Words for a time-off item: `label` for the bar ("Holiday", "Holiday ·
 * requested", "Sick", or "Sick since Tue 17 Nov" when the start is out of
 * view) and `title` for its tooltip, with the full date range.
 */
export function useTimeOffText() {
  const t = useTranslations();
  return (item: TimeOff, opts: { startsBefore?: boolean } = {}) => {
    const type = item.typeName ?? t('weldhr.attendance.schedule.timeOff.leave');
    let label: string;
    if (item.kind === 'sick') {
      label = opts.startsBefore
        ? t('weldhr.attendance.schedule.timeOff.sickSince', { date: shortDay(item.startDate) })
        : t('weldhr.attendance.schedule.timeOff.sick');
    } else {
      label = item.pending ? t('weldhr.attendance.schedule.timeOff.requested', { type }) : type;
    }
    const end = item.endDate ? formatDate(item.endDate) : t('weldhr.attendance.schedule.timeOff.noEndDate');
    const name = item.kind === 'sick' ? t('weldhr.attendance.schedule.timeOff.sick') : label;
    return { label, title: `${name}: ${formatDate(item.startDate)} – ${end}` };
  };
}

/**
 * Leave or sickness as a bar: tinted in the leave type's colour (red for
 * sickness), or dashed when the request still waits for approval. An arrow at
 * the end marks a sick report that has no end date yet.
 */
export function TimeOffBar({
  item,
  label,
  title,
  className,
  style,
  children,
}: Readonly<{
  item: TimeOff;
  label: string;
  title: string;
  className?: string;
  style?: CSSProperties;
  children?: ReactNode;
}>) {
  const color = timeOffColor(item);
  return (
    <div
      title={title}
      className={cn('flex h-[22px] min-w-0 items-center gap-1 rounded-[6px] px-2 text-[11px] font-medium leading-none text-foreground', className)}
      style={{
        ...(item.pending ? { border: `1px dashed ${color}` } : { backgroundColor: `color-mix(in srgb, ${color} 24%, transparent)` }),
        ...style,
      }}
    >
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {children}
      {item.kind === 'sick' && item.endDate === null && <ArrowRight className="h-3 w-3 shrink-0" aria-hidden />}
    </div>
  );
}

/** The collapsing search box from WeldCalendar's toolbar: an icon button that opens into an input. */
export function RosterSearchInput({
  open,
  query,
  placeholder,
  toggleLabel,
  onOpenChange,
  onQueryChange,
}: Readonly<{
  open: boolean;
  query: string;
  placeholder: string;
  toggleLabel: string;
  onOpenChange: (open: boolean) => void;
  onQueryChange: (query: string) => void;
}>) {
  return (
    <div className="relative flex items-center">
      <div className={cn('flex items-center transition-all duration-200 ease-out', open ? 'w-36 md:w-48' : 'w-8')}>
        <Button
          variant="outline"
          size="sm"
          className={cn(
            'h-8 w-8 flex-shrink-0 p-0 shadow-none transition-opacity duration-200',
            open && 'pointer-events-none absolute opacity-0',
          )}
          onClick={() => onOpenChange(true)}
          aria-label={toggleLabel}
          tabIndex={open ? -1 : 0}
        >
          <Search className="h-4 w-4" />
        </Button>
        <div
          className={cn(
            'relative transition-all duration-200 ease-out',
            open ? 'w-36 opacity-100 md:w-48' : 'pointer-events-none w-0 opacity-0',
          )}
        >
          <Search className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
          <input
            type="text"
            placeholder={placeholder}
            aria-label={placeholder}
            value={query}
            onChange={(e) => onQueryChange(e.target.value)}
            onBlur={() => !query && onOpenChange(false)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                onQueryChange('');
                onOpenChange(false);
              }
            }}
            ref={(el) => {
              if (el && open) el.focus();
            }}
            className="h-8 w-full rounded-md border border-gray-200 bg-white pl-8 pr-3 text-sm focus:outline-none dark:border-border dark:bg-background"
          />
        </div>
      </div>
    </div>
  );
}
