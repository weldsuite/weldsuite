'use client';

import { useState } from 'react';
import { formatInTimeZone } from 'date-fns-tz';
import { CalendarX2, CheckCircle2, ExternalLink, Loader2 } from 'lucide-react';

import { EXTERNAL_CALENDAR_BASE } from '@/lib/constants';
import type { BookingPageProps } from '@/lib/schemas';
import type { TimeSlot } from '../actions';

interface ConfirmationCardProps {
  bookingPage: BookingPageProps;
  workspaceName: string;
  selectedSlot: TimeSlot | null;
  selectedDate: Date | null;
  bookerName: string;
  bookerEmail: string;
  timezone: string;
  use24h: boolean;
  locationLabel: string;
  emailDelivery: 'sent' | 'failed' | 'partial' | null;
  onReschedule: () => void;
  onCancel: () => void;
  cancelling: boolean;
}

export function ConfirmationCard({
  bookingPage,
  workspaceName,
  selectedSlot,
  selectedDate,
  bookerName,
  bookerEmail,
  timezone,
  use24h,
  locationLabel,
  emailDelivery,
  onReschedule,
  onCancel,
  cancelling,
}: ConfirmationCardProps) {
  const [confirmingCancel, setConfirmingCancel] = useState(false);
  const formatTime = (date: Date) =>
    formatInTimeZone(date, timezone, use24h ? 'HH:mm' : 'h:mm a');
  const formatDateInTz = (date: Date, pattern: string) =>
    formatInTimeZone(date, timezone, pattern);

  return (
    <div className="flex flex-col items-center text-center px-6 py-10 md:px-10 md:py-14 w-full flex-1">
      <div className="confirmed-badge inline-flex items-center gap-2 px-4 py-2.5 rounded-[16px] bg-white dark:bg-[#131316] border border-gray-200 dark:border-[#2E2E33] text-green-800 dark:text-green-200 text-[15px] font-medium leading-none mb-5">
        <CheckCircle2 className="h-4 w-4" strokeWidth={2.5} aria-hidden="true" />
        <span className="leading-none relative top-[0.75px]">Confirmed</span>
      </div>

      <h1 className="text-[26px] md:text-[28px] font-semibold text-gray-900 dark:text-[#F2F2F4] tabular-nums leading-tight mb-1.5">
        This meeting is scheduled
      </h1>

      <p className="text-sm text-muted-foreground dark:text-[#9999A1] max-w-md mb-4">
        {bookingPage.confirmationMessage ?? (
          <>
            <span className="md:hidden">We've sent everyone a calendar invitation with details.</span>
            <span className="hidden md:inline">
              We've sent everyone a calendar invitation with all the details.
            </span>
          </>
        )}
      </p>

      {emailDelivery === 'failed' && (
        <div
          role="status"
          className="mb-6 max-w-md text-sm rounded-md border border-amber-300 bg-amber-50 dark:bg-amber-950/30 dark:border-amber-800 text-amber-900 dark:text-amber-200 px-4 py-3"
        >
          Booking confirmed, but we couldn't deliver the confirmation email. Please reach out to{' '}
          <strong>{workspaceName}</strong> directly if you need the details.
        </div>
      )}
      {emailDelivery === 'partial' && (
        <div
          role="status"
          className="mb-6 max-w-md text-sm rounded-md border border-amber-300 bg-amber-50 dark:bg-amber-950/30 dark:border-amber-800 text-amber-900 dark:text-amber-200 px-4 py-3"
        >
          Some invite emails couldn't be delivered. The host has been notified.
        </div>
      )}

      {selectedSlot && selectedDate && (
        <div className="w-full max-w-md text-left">
          <dl className="divide-y divide-gray-100 dark:divide-[#26262B]">
            <div className="grid grid-cols-[88px_1fr] gap-4 items-baseline py-4">
              <dt className="text-[14px] text-gray-500 dark:text-[#9999A1] font-normal">What</dt>
              <dd className="font-medium text-gray-900 dark:text-[#F2F2F4] tabular-nums">
                {bookingPage.name}
              </dd>
            </div>

            <div className="grid grid-cols-[88px_1fr] gap-4 py-4">
              <dt className="text-[14px] text-gray-500 dark:text-[#9999A1] font-normal pt-0.5">
                When
              </dt>
              <dd className="text-gray-900 dark:text-[#F2F2F4] tabular-nums leading-snug">
                <p className="font-medium">
                  {formatDateInTz(new Date(selectedSlot.start), 'EEEE, MMMM d, yyyy')}
                </p>
                <p className="text-gray-500 dark:text-[#9999A1] text-[13px] mt-1">
                  {formatTime(new Date(selectedSlot.start))} –{' '}
                  {formatTime(new Date(selectedSlot.end))} · {timezone}
                </p>
              </dd>
            </div>

            <div className="grid grid-cols-[88px_1fr] gap-4 py-4">
              <dt className="text-[14px] text-gray-500 dark:text-[#9999A1] font-normal pt-1.5">
                Who
              </dt>
              <dd className="space-y-3">
                <div className="flex items-center gap-2">
                  <span className="font-medium text-gray-900 dark:text-[#F2F2F4] truncate">
                    {workspaceName}
                  </span>
                  <span className="inline-flex items-center h-[22px] px-2 rounded text-[12px] font-medium leading-none bg-blue-50 dark:bg-blue-950 text-blue-600 dark:text-blue-300">
                    HOST
                  </span>
                </div>
                {(bookerName || bookerEmail) && (
                  <div className="min-w-0">
                    {bookerName && (
                      <p className="font-medium text-gray-900 dark:text-[#F2F2F4] truncate leading-tight">
                        {bookerName}
                      </p>
                    )}
                    {bookerEmail && (
                      <p className="text-gray-500 dark:text-[#9999A1] text-[13px] truncate mt-1">
                        {bookerEmail}
                      </p>
                    )}
                  </div>
                )}
              </dd>
            </div>

            {bookingPage.locationType && (
              <div className="grid grid-cols-[88px_1fr] gap-4 items-baseline py-4">
                <dt className="text-[14px] text-gray-500 dark:text-[#9999A1] font-normal">
                  Where
                </dt>
                <dd className="text-gray-900 dark:text-[#F2F2F4]">
                  {bookingPage.locationType === 'video' && bookingPage.locationValue ? (
                    <a
                      href={bookingPage.locationValue}
                      target="_blank"
                      rel="noreferrer"
                      className="font-medium text-gray-900 dark:text-[#F2F2F4] hover:underline inline-flex items-center gap-1.5"
                    >
                      {locationLabel}
                      <ExternalLink
                        className="h-3.5 w-3.5 text-gray-500 dark:text-[#9999A1]"
                        aria-hidden="true"
                      />
                    </a>
                  ) : (
                    <p className="font-medium">{locationLabel}</p>
                  )}
                </dd>
              </div>
            )}
          </dl>

          <div className="mt-4 pt-8 border-t border-[#ECEDF1] dark:border-[#26262B] text-center text-sm text-gray-700 dark:text-[#C4C4CA]">
            {confirmingCancel ? (
              <div className="flex flex-col items-center gap-3">
                <span>Cancel this meeting? This can't be undone.</span>
                <div className="flex items-center justify-center gap-3">
                  <button
                    type="button"
                    onClick={onCancel}
                    disabled={cancelling}
                    className="inline-flex items-center gap-1.5 rounded-md bg-red-600 px-3 py-1.5 text-white font-medium hover:bg-red-700 disabled:opacity-60 disabled:cursor-not-allowed transition-colors"
                  >
                    {cancelling && <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />}
                    Yes, cancel
                  </button>
                  <button
                    type="button"
                    onClick={() => setConfirmingCancel(false)}
                    disabled={cancelling}
                    className="rounded-md px-3 py-1.5 font-medium text-gray-700 dark:text-[#C4C4CA] hover:bg-gray-100 dark:hover:bg-[#1F1F23] disabled:opacity-60 transition-colors"
                  >
                    Keep it
                  </button>
                </div>
              </div>
            ) : (
              <>
                Need to make a change?{' '}
                <button
                  type="button"
                  onClick={onReschedule}
                  className="text-gray-900 dark:text-[#F2F2F4] underline underline-offset-2 hover:text-gray-700 dark:hover:text-[#C4C4CA]"
                >
                  Reschedule
                </button>{' '}
                <span className="text-gray-400 dark:text-[#6E6E76]">or</span>{' '}
                <button
                  type="button"
                  onClick={() => setConfirmingCancel(true)}
                  className="text-gray-900 dark:text-[#F2F2F4] underline underline-offset-2 hover:text-gray-700 dark:hover:text-[#C4C4CA]"
                >
                  Cancel
                </button>
              </>
            )}
          </div>

          <AddToCalendar
            bookingName={bookingPage.name}
            workspaceName={workspaceName}
            locationValue={bookingPage.locationValue}
            startIso={selectedSlot.start}
            endIso={selectedSlot.end}
          />
        </div>
      )}
    </div>
  );
}

interface CancelledCardProps {
  bookingPage: BookingPageProps;
  workspaceName: string;
  selectedSlot: TimeSlot | null;
  timezone: string;
  use24h: boolean;
}

export function CancelledCard({
  bookingPage,
  workspaceName,
  selectedSlot,
  timezone,
  use24h,
}: CancelledCardProps) {
  const formatTime = (date: Date) =>
    formatInTimeZone(date, timezone, use24h ? 'HH:mm' : 'h:mm a');
  const formatDateInTz = (date: Date, pattern: string) =>
    formatInTimeZone(date, timezone, pattern);

  return (
    <div className="flex flex-col items-center text-center px-6 py-10 md:px-10 md:py-14 w-full flex-1">
      <div className="inline-flex items-center gap-2 px-4 py-2.5 rounded-[16px] bg-white dark:bg-[#131316] border border-gray-200 dark:border-[#2E2E33] text-gray-600 dark:text-[#9999A1] text-[15px] font-medium leading-none mb-5">
        <CalendarX2 className="h-4 w-4" strokeWidth={2.5} aria-hidden="true" />
        <span className="leading-none relative top-[0.75px]">Cancelled</span>
      </div>

      <h1 className="text-[26px] md:text-[28px] font-semibold text-gray-900 dark:text-[#F2F2F4] tabular-nums leading-tight mb-1.5">
        This meeting is cancelled
      </h1>

      <p className="text-sm text-muted-foreground dark:text-[#9999A1] max-w-md mb-4">
        We've let everyone know. If you'd like to rebook, please contact{' '}
        <strong>{workspaceName}</strong> or start a new booking.
      </p>

      {selectedSlot && (
        <p className="text-sm text-gray-500 dark:text-[#9999A1] line-through tabular-nums">
          {bookingPage.name} ·{' '}
          {formatDateInTz(new Date(selectedSlot.start), 'EEEE, MMMM d, yyyy')} ·{' '}
          {formatTime(new Date(selectedSlot.start))}
        </p>
      )}
    </div>
  );
}

interface AddToCalendarProps {
  bookingName: string;
  workspaceName: string;
  locationValue: string | null;
  startIso: string;
  endIso: string;
}

function AddToCalendar({
  bookingName,
  workspaceName,
  locationValue,
  startIso,
  endIso,
}: AddToCalendarProps) {
  const start = new Date(startIso);
  const end = new Date(endIso);
  const fmt = (d: Date) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const title = encodeURIComponent(bookingName);
  const details = encodeURIComponent(`Booked with ${workspaceName}`);
  const location = locationValue ? encodeURIComponent(locationValue) : '';

  const googleUrl = `${EXTERNAL_CALENDAR_BASE.google}?action=TEMPLATE&text=${title}&dates=${fmt(start)}/${fmt(end)}&details=${details}&location=${location}`;
  const outlookUrl = `${EXTERNAL_CALENDAR_BASE.outlook}?path=/calendar/action/compose&rru=addevent&subject=${title}&body=${details}&location=${location}&startdt=${startIso}&enddt=${endIso}`;
  const weldcalUrl = `${EXTERNAL_CALENDAR_BASE.weldcal}?title=${title}&start=${startIso}&end=${endIso}&location=${location}`;

  const ics = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//WeldSuite//Booking//EN',
    'BEGIN:VEVENT',
    `UID:${start.getTime()}@weldsuite`,
    `DTSTAMP:${fmt(new Date())}`,
    `DTSTART:${fmt(start)}`,
    `DTEND:${fmt(end)}`,
    `SUMMARY:${bookingName}`,
    `DESCRIPTION:Booked with ${workspaceName}`,
    locationValue ? `LOCATION:${locationValue}` : '',
    'END:VEVENT',
    'END:VCALENDAR',
  ]
    .filter(Boolean)
    .join('\r\n');
  const icsUrl = `data:text/calendar;charset=utf-8,${encodeURIComponent(ics)}`;

  const btn =
    'h-9 w-9 rounded-[9px] border border-gray-200 dark:border-[#2E2E33] hover:bg-gray-50 dark:hover:bg-[#1F1F23] flex items-center justify-center transition-colors';

  return (
    <div className="mt-6 flex items-center justify-center gap-3 text-sm text-gray-700 dark:text-[#C4C4CA]">
      <span>Add to calendar</span>
      <div className="flex items-center gap-2">
        <a href={weldcalUrl} target="_blank" rel="noreferrer" className={btn} title="WeldCalendar">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/icons/weldcalendar.svg" alt="WeldCalendar" className="h-4 w-4" />
        </a>
        <a href={googleUrl} target="_blank" rel="noreferrer" className={btn} title="Google Calendar">
          <svg viewBox="0 0 24 24" className="h-[17px] w-[17px]" aria-hidden="true">
            <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4" />
            <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853" />
            <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05" />
            <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335" />
          </svg>
        </a>
        <a href={outlookUrl} target="_blank" rel="noreferrer" className={btn} title="Outlook">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/icons/outlook.svg" alt="Outlook" className="h-[17px] w-[17px]" />
        </a>
        <a href={icsUrl} download="booking.ics" className={btn} title="Apple / iCal">
          <svg viewBox="0 0 24 24" className="h-5 w-5" fill="currentColor" aria-hidden="true">
            <path d="M17.05 20.28c-.98.95-2.05.8-3.08.35-1.09-.46-2.09-.48-3.24 0-1.44.62-2.2.44-3.06-.35C2.79 15.25 3.51 7.59 9.05 7.31c1.35.07 2.29.74 3.08.8 1.18-.24 2.31-.93 3.57-.84 1.51.12 2.65.72 3.4 1.8-3.12 1.87-2.38 5.98.48 7.13-.57 1.5-1.31 2.99-2.54 4.09zM12 7.25c-.15-2.23 1.66-4.07 3.74-4.25.29 2.58-2.34 4.5-3.74 4.25z" />
          </svg>
        </a>
      </div>
    </div>
  );
}

