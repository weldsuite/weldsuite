'use client';

import { formatInTimeZone } from 'date-fns-tz';
import { CalendarClock, Loader2 } from 'lucide-react';

import type { TimeSlot } from '../actions';

interface RescheduleConfirmProps {
  /** The slot the booker picked as the new time. */
  slot: TimeSlot;
  timezone: string;
  use24h: boolean;
  accentColor: string;
  submitting: boolean;
  onConfirm: () => void;
  onBack: () => void;
}

/** "Reschedule to <date time>?": moving a booking asks before it applies. */
export function RescheduleConfirm({
  slot,
  timezone,
  use24h,
  accentColor,
  submitting,
  onConfirm,
  onBack,
}: Readonly<RescheduleConfirmProps>) {
  const timePattern = use24h ? 'HH:mm' : 'h:mm a';
  const start = new Date(slot.start);
  const end = new Date(slot.end);
  const dateLabel = formatInTimeZone(start, timezone, 'EEEE, MMMM d, yyyy');
  const timeLabel = `${formatInTimeZone(start, timezone, timePattern)} – ${formatInTimeZone(end, timezone, timePattern)}`;

  return (
    <div className="flex flex-col items-center justify-center text-center px-6 py-10 md:px-10 md:py-14 w-full flex-1">
      <div className="inline-flex items-center gap-2 px-4 py-2.5 rounded-[16px] bg-white dark:bg-[#131316] border border-gray-200 dark:border-[#2E2E33] text-gray-700 dark:text-[#C4C4CA] text-[15px] font-medium leading-none mb-5">
        <CalendarClock className="h-4 w-4" strokeWidth={2.5} aria-hidden="true" />
        <span className="leading-none relative top-[0.75px]">Reschedule</span>
      </div>

      <h1 className="text-[22px] md:text-[26px] font-semibold text-gray-900 dark:text-[#F2F2F4] leading-tight mb-2">
        Reschedule to {dateLabel}, {timeLabel}?
      </h1>
      <p className="text-sm text-gray-500 dark:text-[#9999A1] tabular-nums mb-8">{timezone}</p>

      <div className="flex items-center justify-center gap-3">
        <button
          type="button"
          onClick={onConfirm}
          disabled={submitting}
          style={{ backgroundColor: accentColor }}
          className="inline-flex items-center gap-1.5 rounded-md px-4 py-2 text-sm font-medium text-white hover:opacity-90 disabled:opacity-60 disabled:cursor-not-allowed transition-opacity dark:!bg-[#F2F2F4] dark:!text-[#0A0A0B]"
        >
          {submitting && <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />}
          Confirm
        </button>
        <button
          type="button"
          onClick={onBack}
          disabled={submitting}
          className="rounded-md px-4 py-2 text-sm font-medium text-gray-700 dark:text-[#C4C4CA] hover:bg-gray-100 dark:hover:bg-[#1F1F23] disabled:opacity-60 transition-colors"
        >
          Back
        </button>
      </div>
    </div>
  );
}
