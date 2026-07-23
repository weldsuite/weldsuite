'use client';

import { Clock, Globe, Link2 } from 'lucide-react';

import type { BookingPageProps } from '@/lib/schemas';

import { TimezonePicker } from './timezone-picker';

interface BookingPageInfoProps {
  bookingPage: BookingPageProps;
  workspaceName: string;
  workspaceImage: string | null;
  locationLabel: string;
  timezone: string;
  /** When provided, the timezone row becomes a picker. */
  onTimezoneChange?: (tz: string) => void;
  accentColor?: string;
}

export function BookingPageInfo({
  bookingPage,
  workspaceName,
  workspaceImage,
  locationLabel,
  timezone,
  onTimezoneChange,
  accentColor = '#111827',
}: BookingPageInfoProps) {
  return (
    <div className="w-full md:w-[280px] shrink-0 md:border-r md:border-b-0 md:border-gray-200 dark:md:border-[#26262B] flex flex-col overflow-hidden">
      <div className="flex flex-col flex-1 px-6 pt-6 pb-6">
        <div className="h-10 w-10 rounded-full overflow-hidden mb-[13px] shrink-0">
          {workspaceImage ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={workspaceImage}
              alt={workspaceName}
              className="h-full w-full object-cover"
            />
          ) : (
            <div className="h-full w-full bg-gray-200 dark:bg-[#2E2E33] flex items-center justify-center text-sm font-semibold text-gray-500 dark:text-[#C4C4CA]">
              {workspaceName.charAt(0)}
            </div>
          )}
        </div>
        <p className="text-sm font-medium text-blue-600 dark:text-blue-400 mb-2 tabular-nums">
          {workspaceName}
        </p>
        <h1 className="text-[20px] font-semibold text-gray-900 dark:text-[#F2F2F4] leading-tight mb-2 tabular-nums">
          {bookingPage.name}
        </h1>
        {bookingPage.description && (
          <p className="text-[14px] text-gray-500 dark:text-[#9999A1] font-normal leading-relaxed">
            {bookingPage.description}
          </p>
        )}

        <div className="space-y-3 text-sm text-gray-500 dark:text-[#9999A1] mt-3 md:mt-auto tabular-nums">
          <div className="flex items-center gap-2.5">
            <Clock className="h-4 w-4 shrink-0" aria-hidden="true" />
            <span>{formatDuration(bookingPage.duration)}</span>
          </div>
          {bookingPage.locationType && (
            <div className="flex items-center gap-2.5">
              <Link2 className="h-4 w-4 shrink-0" aria-hidden="true" />
              <span>{locationLabel}</span>
            </div>
          )}
          {onTimezoneChange ? (
            <TimezonePicker
              value={timezone}
              onChange={onTimezoneChange}
              accentColor={accentColor}
            />
          ) : (
            <div className="flex items-center gap-2.5">
              <Globe className="h-4 w-4 shrink-0" aria-hidden="true" />
              <span>{timezone}</span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function formatDuration(minutes: number): string {
  if (minutes < 60) return `${minutes}m`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}
