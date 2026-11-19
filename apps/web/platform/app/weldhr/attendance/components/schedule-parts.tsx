/** Attendance → Schedule: the pieces the day, week and month views share. */

import type { CSSProperties, ReactNode } from 'react';
import { format } from 'date-fns';
import { ArrowRight } from 'lucide-react';
import { useTranslations } from '@weldsuite/i18n/client';
import type { HrShift } from '@weldsuite/app-api-client/domains/weldhr';
import { formatClockRange, type TimeFormat } from '@/app/weldcalendar/lib/calendar-format';
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
  children,
}: Readonly<{
  shift: HrShift;
  timeFormat: TimeFormat;
  onClick?: () => void;
  className?: string;
  style?: CSSProperties;
  /** Let the time range wrap onto a second line instead of cutting it off (the day view has the height). */
  wrapTime?: boolean;
  /** Drawn inside the block, e.g. the day view's break band. */
  children?: ReactNode;
}>) {
  const t = useTranslations();
  const breakRange =
    shift.breakStartsAt && shift.breakEndsAt
      ? formatClockRange(new Date(shift.breakStartsAt), new Date(shift.breakEndsAt), timeFormat)
      : null;
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
        {formatClockRange(new Date(shift.startsAt), new Date(shift.endsAt), timeFormat)}
      </span>
      {shift.workType && <span className="relative mt-[3px] block truncate">{shift.workType}</span>}
      {shift.companyName && <span className="relative mt-[3px] block truncate text-white/70">{shift.companyName}</span>}
      {breakRange && (
        <span className="relative mt-[3px] block truncate text-white/70">{t('weldhr.attendance.schedule.break', { range: breakRange })}</span>
      )}
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
