'use client';

import { useEffect, useReducer, useTransition } from 'react';
import { addDays, format, startOfDay } from 'date-fns';
import { formatInTimeZone } from 'date-fns-tz';
import { toast } from 'sonner';

import { DEFAULT_MAX_ADVANCE_DAYS } from '@/lib/availability';
import type { BookingPageProps } from '@/lib/schemas';
import { LAYOUT } from '@/lib/constants';

import {
  cancelBooking,
  createBooking,
  getAvailableSlots,
  rescheduleBooking,
  type TimeSlot,
} from './actions';
import {
  cancelPersonalBooking,
  createPersonalBooking,
  getPersonalAvailableSlots,
  reschedulePersonalBooking,
} from '../../p/[slug]/actions';
import { BookingPageInfo } from './components/booking-page-info';
import {
  BookingDetailsForm,
  type BookingFormState,
} from './components/booking-details-form';
import { CalendarWidget, hasAvailabilityForDay } from './components/calendar-widget';
import { CancelledCard, ConfirmationCard } from './components/confirmation-card';
import { RescheduleConfirm } from './components/reschedule-confirm';
import { TimeSlotList } from './components/time-slot-list';
import { getBrowserTimezone } from './components/timezone-picker';

// ── State ──────────────────────────────────────────────────────────────

type Step = 'select-time' | 'enter-details' | 'confirmed' | 'cancelled';

interface State {
  step: Step;
  selectedDate: Date | null;
  currentMonth: Date;
  slots: TimeSlot[];
  selectedSlot: TimeSlot | null;
  use24h: boolean;
  pendingDates: Set<string>;
  emptyDates: Set<string>;
  initialLoading: boolean;
  timezone: string;
  formState: BookingFormState;
  emailDelivery: 'sent' | 'failed' | 'partial' | null;
  bookingId: string | null;
  /** Signed token that authorises cancelling / rescheduling `bookingId` (workspace pages). */
  manageToken: string | null;
  /** Join link of the booking's meeting (WeldMeet, or the page's own link). */
  meetingUrl: string | null;
  isRescheduling: boolean;
  /** Slot picked while rescheduling, waiting for the booker to confirm it. */
  pendingReschedule: TimeSlot | null;
  // The slot of the confirmed booking, preserved so "Keep current time"
  // can restore it after the user enters reschedule mode.
  confirmedSlot: TimeSlot | null;
}

type Action =
  | { type: 'set-timezone'; tz: string }
  | { type: 'set-month'; month: Date }
  | { type: 'select-date'; date: Date }
  | { type: 'set-slots'; date: Date; slots: TimeSlot[] }
  | { type: 'mark-empty'; dateStr: string }
  | { type: 'clear-pending'; dateStr: string }
  | { type: 'finish-initial' }
  | { type: 'select-slot'; slot: TimeSlot }
  | { type: 'go-back' }
  | { type: 'use-24h'; use24h: boolean }
  | {
      type: 'booking-confirmed';
      bookingId: string;
      manageToken: string | null;
      meetingUrl: string | null;
      formState: BookingFormState;
      emailDelivery: 'sent' | 'failed' | 'partial';
    }
  | { type: 'start-reschedule' }
  | { type: 'cancel-reschedule' }
  | { type: 'pick-reschedule-slot'; slot: TimeSlot }
  | { type: 'clear-reschedule-slot' }
  | {
      type: 'reschedule-confirmed';
      slot: TimeSlot;
      meetingUrl: string | null;
      emailDelivery: 'sent' | 'failed' | 'partial';
    }
  | { type: 'booking-cancelled' };

const today = startOfDay(new Date());

const initialFormState: BookingFormState = {
  name: '',
  email: '',
  notes: '',
  answers: {},
  guests: [],
};

/** An existing booking opened from the signed link in a confirmation email. */
export interface ManagedBooking {
  bookingId: string;
  token: string;
  bookerName: string;
  bookerEmail: string;
  startTime: string;
  endTime: string;
  cancelled: boolean;
  /** Extra guests (email addresses) on the booking. */
  guests: string[];
  /** Join link of the booking's meeting, when it has one. */
  meetingUrl: string | null;
  /** Which button of the email was clicked. */
  intent: 'reschedule' | 'cancel' | null;
}

function makeInitialState({
  bookingPage,
  initialBooking,
}: {
  bookingPage: BookingPageProps;
  initialBooking: ManagedBooking | null;
}): State {
  const base: State = {
    step: 'select-time',
    selectedDate: null,
    currentMonth: new Date(),
    slots: [],
    selectedSlot: null,
    use24h: true,
    pendingDates: new Set([format(today, 'yyyy-MM-dd')]),
    emptyDates: new Set(),
    initialLoading: true,
    timezone: bookingPage.timezone,
    formState: initialFormState,
    emailDelivery: null,
    bookingId: null,
    manageToken: null,
    meetingUrl: null,
    isRescheduling: false,
    pendingReschedule: null,
    confirmedSlot: null,
  };
  if (!initialBooking) return base;

  const slot: TimeSlot = {
    start: initialBooking.startTime,
    end: initialBooking.endTime,
    available: true,
  };
  let step: Step = 'confirmed';
  if (initialBooking.cancelled) step = 'cancelled';
  else if (initialBooking.intent === 'reschedule') step = 'select-time';
  return {
    ...base,
    step,
    selectedSlot: slot,
    selectedDate: new Date(initialBooking.startTime),
    confirmedSlot: slot,
    isRescheduling: step === 'select-time',
    bookingId: initialBooking.bookingId,
    manageToken: initialBooking.token,
    meetingUrl: initialBooking.meetingUrl,
    formState: {
      ...initialFormState,
      name: initialBooking.bookerName,
      email: initialBooking.bookerEmail,
      guests: initialBooking.guests,
    },
  };
}

function reducer(state: State, action: Action): State {
  switch (action.type) {
    case 'set-timezone':
      return { ...state, timezone: action.tz };
    case 'set-month':
      return { ...state, currentMonth: action.month };
    case 'select-date':
      return { ...state, selectedDate: action.date, selectedSlot: null };
    case 'set-slots': {
      const dateStr = format(action.date, 'yyyy-MM-dd');
      const next = new Set(state.pendingDates);
      next.delete(dateStr);
      const empty = action.slots.filter((s) => s.available).length === 0;
      const emptySet = empty ? new Set(state.emptyDates).add(dateStr) : state.emptyDates;
      return { ...state, slots: action.slots, pendingDates: next, emptyDates: emptySet };
    }
    case 'mark-empty':
      return { ...state, emptyDates: new Set(state.emptyDates).add(action.dateStr) };
    case 'clear-pending': {
      const next = new Set(state.pendingDates);
      next.delete(action.dateStr);
      return { ...state, pendingDates: next };
    }
    case 'finish-initial':
      return { ...state, initialLoading: false, pendingDates: new Set() };
    case 'select-slot':
      return { ...state, selectedSlot: action.slot, step: 'enter-details' };
    case 'go-back':
      return { ...state, step: 'select-time', selectedSlot: null };
    case 'use-24h':
      return { ...state, use24h: action.use24h };
    case 'booking-confirmed':
      return {
        ...state,
        step: 'confirmed',
        formState: action.formState,
        emailDelivery: action.emailDelivery,
        bookingId: action.bookingId,
        manageToken: action.manageToken,
        meetingUrl: action.meetingUrl,
        confirmedSlot: state.selectedSlot,
        isRescheduling: false,
      };
    case 'start-reschedule':
      return {
        ...state,
        step: 'select-time',
        isRescheduling: true,
        selectedSlot: null,
        pendingReschedule: null,
        // Open on the month of the booking being moved.
        currentMonth: state.selectedDate ?? state.currentMonth,
      };
    case 'cancel-reschedule':
      return {
        ...state,
        step: 'confirmed',
        isRescheduling: false,
        pendingReschedule: null,
        selectedSlot: state.confirmedSlot,
      };
    case 'pick-reschedule-slot':
      return { ...state, pendingReschedule: action.slot };
    case 'clear-reschedule-slot':
      return { ...state, pendingReschedule: null };
    case 'reschedule-confirmed':
      return {
        ...state,
        step: 'confirmed',
        isRescheduling: false,
        pendingReschedule: null,
        selectedSlot: action.slot,
        confirmedSlot: action.slot,
        meetingUrl: action.meetingUrl,
        emailDelivery: action.emailDelivery,
      };
    case 'booking-cancelled':
      return { ...state, step: 'cancelled', isRescheduling: false };
  }
}

// ── Component ──────────────────────────────────────────────────────────

interface BookingClientProps {
  kind?: 'workspace' | 'personal';
  workspaceSlug?: string;
  workspaceName: string;
  workspaceImage: string | null;
  /** The member who owns the page; shown as the host, with the workspace as secondary. */
  hostName?: string | null;
  bookingPage: BookingPageProps;
  /** Set when the page was opened from a signed cancel / reschedule link. */
  initialBooking?: ManagedBooking | null;
}

function getLocationLabel(locationType: BookingPageProps['locationType']): string {
  if (locationType === 'video') return 'WeldMeet';
  if (locationType === 'phone') return 'Phone call';
  return 'In person';
}

export function BookingClient({
  kind = 'workspace',
  workspaceSlug = '',
  workspaceName,
  workspaceImage,
  hostName = null,
  bookingPage,
  initialBooking = null,
}: Readonly<BookingClientProps>) {
  const [state, dispatch] = useReducer(reducer, { bookingPage, initialBooking }, makeInitialState);
  const [slotsLoading, startSlotsTransition] = useTransition();
  const [submitting, startSubmitTransition] = useTransition();
  const [cancelling, startCancelTransition] = useTransition();
  const [rescheduling, startRescheduleTransition] = useTransition();

  const accentColor = bookingPage.color || '#111827';
  const maxDate = addDays(today, bookingPage.maxAdvance ?? DEFAULT_MAX_ADVANCE_DAYS);
  const locationLabel = getLocationLabel(bookingPage.locationType);
  // "Book again" goes to the clean page URL, without the signed booking query.
  const bookAgainHref =
    kind === 'personal'
      ? `/p/${encodeURIComponent(bookingPage.slug)}`
      : `/${encodeURIComponent(workspaceSlug)}/${encodeURIComponent(bookingPage.slug)}`;

  // Slots of a date. While a booking is being moved, its own slot counts as free.
  const fetchSlots = (dateStr: string, movingBookingId: string | null): Promise<TimeSlot[]> => {
    if (kind === 'personal') {
      return getPersonalAvailableSlots(bookingPage.id, dateStr, movingBookingId ?? undefined);
    }
    const manage =
      movingBookingId && state.manageToken
        ? { bookingId: movingBookingId, token: state.manageToken }
        : undefined;
    return getAvailableSlots(workspaceSlug, bookingPage.id, dateStr, manage);
  };

  // Sync timezone to browser on mount.
  useEffect(() => {
    const browserTz = getBrowserTimezone();
    if (browserTz) dispatch({ type: 'set-timezone', tz: browserTz });
  }, []);

  // Keep currentMonth >= "real" current month in the displayed timezone.
  useEffect(() => {
    const [yearStr = '', monthStr = ''] = formatInTimeZone(
      new Date(),
      state.timezone,
      'yyyy-M',
    ).split('-');
    const year = Number.parseInt(yearStr, 10);
    const month = Number.parseInt(monthStr, 10) - 1;
    if (Number.isNaN(year) || Number.isNaN(month)) return;
    const prevKey = state.currentMonth.getFullYear() * 12 + state.currentMonth.getMonth();
    const nowKey = year * 12 + month;
    if (prevKey < nowKey) {
      dispatch({ type: 'set-month', month: new Date(year, month, 1) });
    }
  }, [state.timezone, state.currentMonth]);

  // Initial load: find first available day. A booking opened from an email
  // link starts on its own day instead (see the reschedule effect below).
  useEffect(() => {
    if (initialBooking) {
      dispatch({ type: 'finish-initial' });
      return;
    }
    let cancelled = false;
    const fetchInitial = async () => {
      let date = new Date(today);
      const limit = addDays(today, bookingPage.maxAdvance ?? DEFAULT_MAX_ADVANCE_DAYS);

      while (date <= limit) {
        if (cancelled) return;
        if (
          hasAvailabilityForDay(
            date,
            bookingPage.availability,
            bookingPage.duration,
            bookingPage.dateOverrides,
          )
        ) {
          const dateStr = format(date, 'yyyy-MM-dd');
          const result =
            kind === 'personal'
              ? await getPersonalAvailableSlots(bookingPage.id, dateStr)
              : await getAvailableSlots(workspaceSlug, bookingPage.id, dateStr);
          if (cancelled) return;
          if (result.filter((s) => s.available).length > 0) {
            dispatch({ type: 'select-date', date });
            dispatch({ type: 'set-slots', date, slots: result });
            dispatch({ type: 'finish-initial' });
            return;
          }
          dispatch({ type: 'mark-empty', dateStr });
        }
        date = addDays(date, 1);
      }
      dispatch({ type: 'finish-initial' });
    };

    fetchInitial();
    return () => {
      cancelled = true;
    };
  }, [
    bookingPage.availability,
    bookingPage.dateOverrides,
    bookingPage.duration,
    bookingPage.id,
    bookingPage.maxAdvance,
    initialBooking,
    kind,
    workspaceSlug,
  ]);

  const handleDateSelect = (date: Date) => {
    dispatch({ type: 'select-date', date });
    const dateStr = format(date, 'yyyy-MM-dd');
    const movingBookingId = state.isRescheduling ? state.bookingId : null;
    startSlotsTransition(async () => {
      const result = await fetchSlots(dateStr, movingBookingId);
      dispatch({ type: 'set-slots', date, slots: result });
    });
  };

  // Entering reschedule mode: the slots in state predate the booking (its slot
  // would still be listed as free, or another day shown), so fetch the booked
  // day again.
  useEffect(() => {
    if (!state.isRescheduling || !state.selectedDate) return;
    const date = state.selectedDate;
    const dateStr = format(date, 'yyyy-MM-dd');
    let ignore = false;
    startSlotsTransition(async () => {
      const result = await fetchSlots(dateStr, state.bookingId);
      if (!ignore) dispatch({ type: 'set-slots', date, slots: result });
    });
    return () => {
      ignore = true;
    };
    // Only when the mode opens: picking another day fetches through handleDateSelect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.isRescheduling]);

  const handleSubmit = (formState: BookingFormState) => {
    if (!state.selectedSlot) return;
    startSubmitTransition(async () => {
      const result =
        kind === 'personal'
          ? await createPersonalBooking({
              bookingPageId: bookingPage.id,
              bookerName: formState.name,
              bookerEmail: formState.email,
              startTime: state.selectedSlot!.start,
              endTime: state.selectedSlot!.end,
              answers:
                Object.keys(formState.answers).length > 0 ? formState.answers : undefined,
              notes: formState.notes || undefined,
              guests:
                formState.guests.length > 0
                  ? formState.guests.map((email) => ({ email }))
                  : undefined,
            })
          : await createBooking({
              workspaceSlug,
              bookingPageId: bookingPage.id,
              bookerName: formState.name,
              bookerEmail: formState.email,
              startTime: state.selectedSlot!.start,
              endTime: state.selectedSlot!.end,
              answers:
                Object.keys(formState.answers).length > 0 ? formState.answers : undefined,
              notes: formState.notes || undefined,
              guests:
                formState.guests.length > 0
                  ? formState.guests.map((email) => ({ email }))
                  : undefined,
            });

      if (result.success) {
        dispatch({
          type: 'booking-confirmed',
          bookingId: result.bookingId,
          manageToken:
            'manageToken' in result && typeof result.manageToken === 'string'
              ? result.manageToken
              : null,
          meetingUrl: result.meetingUrl,
          formState,
          emailDelivery: result.emailDelivery,
        });
      } else {
        toast.error(result.error);
        // If the slot was taken between availability check and submit,
        // bounce back to slot picking and refresh the day's slots.
        if (state.selectedDate) {
          handleDateSelect(state.selectedDate);
        }
        dispatch({ type: 'go-back' });
      }
    });
  };

  const handleReschedule = (slot: TimeSlot) => {
    if (!state.bookingId) return;
    startRescheduleTransition(async () => {
      const result =
        kind === 'personal'
          ? await reschedulePersonalBooking({
              bookingId: state.bookingId!,
              startTime: slot.start,
              endTime: slot.end,
            })
          : await rescheduleBooking({
              workspaceSlug,
              bookingId: state.bookingId!,
              token: state.manageToken ?? '',
              startTime: slot.start,
              endTime: slot.end,
            });

      if (result.success) {
        dispatch({
          type: 'reschedule-confirmed',
          slot,
          meetingUrl: result.meetingUrl,
          emailDelivery: result.emailDelivery,
        });
        toast.success('Your meeting has been rescheduled.');
      } else {
        toast.error(result.error);
        // The slot may have been taken: back to the picker, with the day's
        // slots refreshed so it reflects reality.
        dispatch({ type: 'clear-reschedule-slot' });
        if (state.selectedDate) handleDateSelect(state.selectedDate);
      }
    });
  };

  const handleCancel = () => {
    if (!state.bookingId) return;
    startCancelTransition(async () => {
      const result =
        kind === 'personal'
          ? await cancelPersonalBooking({ bookingId: state.bookingId! })
          : await cancelBooking({
              workspaceSlug,
              bookingId: state.bookingId!,
              token: state.manageToken ?? '',
            });
      if (result.success) {
        dispatch({ type: 'booking-cancelled' });
      } else {
        toast.error(result.error);
      }
    });
  };

  const handleSlotSelect = (slot: TimeSlot) => {
    if (state.isRescheduling) {
      // Moving a booking is not undone by a stray click: ask first.
      dispatch({ type: 'pick-reschedule-slot', slot });
    } else {
      dispatch({ type: 'select-slot', slot });
    }
  };

  const containerMaxWidth =
    state.step === 'enter-details' || state.step === 'confirmed' || state.step === 'cancelled'
      ? 760
      : LAYOUT.CONTAINER_WIDTH;

  return (
    <div className="relative w-full" style={{ maxWidth: containerMaxWidth }}>
      <div
        className={`flex flex-col w-full bg-white dark:bg-[#131316] transition-all duration-300 ease-in-out overflow-hidden md:rounded-xl md:border md:border-gray-200 dark:md:border-[#26262B] ${
          state.step === 'enter-details' || state.step === 'confirmed' || state.step === 'cancelled'
            ? 'md:min-h-[535px] md:max-h-[min(85vh,720px)]'
            : 'md:h-[535px]'
        }`}
      >
        {state.step === 'confirmed' && (
          <ConfirmationCard
            bookingPage={bookingPage}
            workspaceName={workspaceName}
            hostName={hostName}
            startInCancelConfirm={initialBooking?.intent === 'cancel'}
            selectedSlot={state.selectedSlot}
            selectedDate={state.selectedDate}
            bookerName={state.formState.name}
            bookerEmail={state.formState.email}
            guests={state.formState.guests}
            meetingUrl={state.meetingUrl}
            timezone={state.timezone}
            use24h={state.use24h}
            locationLabel={locationLabel}
            emailDelivery={state.emailDelivery}
            onReschedule={() => dispatch({ type: 'start-reschedule' })}
            onCancel={handleCancel}
            cancelling={cancelling}
          />
        )}

        {state.step === 'cancelled' && (
          <CancelledCard
            bookingPage={bookingPage}
            workspaceName={workspaceName}
            selectedSlot={state.confirmedSlot}
            timezone={state.timezone}
            use24h={state.use24h}
            bookAgainHref={bookAgainHref}
            accentColor={accentColor}
          />
        )}

        {state.step === 'enter-details' && state.selectedSlot && state.selectedDate && (
          <div className="flex flex-col md:flex-row flex-1 min-h-0">
            <BookingPageInfo
              bookingPage={bookingPage}
              workspaceName={workspaceName}
              hostName={hostName}
              workspaceImage={workspaceImage}
              locationLabel={locationLabel}
              timezone={state.timezone}
            />
            <BookingDetailsForm
              bookingPage={bookingPage}
              selectedSlot={state.selectedSlot}
              timezone={state.timezone}
              use24h={state.use24h}
              submitting={submitting}
              accentColor={accentColor}
              initial={state.formState}
              onBack={() => dispatch({ type: 'go-back' })}
              onSubmit={handleSubmit}
            />
          </div>
        )}

        {state.step === 'select-time' && state.isRescheduling && state.pendingReschedule && (
          <RescheduleConfirm
            slot={state.pendingReschedule}
            timezone={state.timezone}
            use24h={state.use24h}
            accentColor={accentColor}
            submitting={rescheduling}
            onConfirm={() => handleReschedule(state.pendingReschedule!)}
            onBack={() => dispatch({ type: 'clear-reschedule-slot' })}
          />
        )}

        {state.step === 'select-time' && !(state.isRescheduling && state.pendingReschedule) && (
          <div className="flex flex-col flex-1 min-h-0 h-full">
            {state.isRescheduling && (
              <div className="flex items-center justify-between gap-3 px-6 py-3 border-b border-gray-200 dark:border-[#26262B] bg-gray-50 dark:bg-[#1A1A1E] text-sm">
                <span className="text-gray-700 dark:text-[#C4C4CA]">
                  Pick a new time for your meeting
                </span>
                <button
                  type="button"
                  onClick={() => dispatch({ type: 'cancel-reschedule' })}
                  disabled={rescheduling}
                  className="shrink-0 text-gray-900 dark:text-[#F2F2F4] underline underline-offset-2 hover:text-gray-700 dark:hover:text-[#C4C4CA] disabled:opacity-60"
                >
                  Keep current time
                </button>
              </div>
            )}
            <div className="flex flex-col md:flex-row flex-1 min-h-0">
              <BookingPageInfo
                bookingPage={bookingPage}
                workspaceName={workspaceName}
                hostName={hostName}
                workspaceImage={workspaceImage}
                locationLabel={locationLabel}
                timezone={state.timezone}
                onTimezoneChange={(tz) => dispatch({ type: 'set-timezone', tz })}
                accentColor={accentColor}
              />
              <CalendarWidget
                currentMonth={state.currentMonth}
                selectedDate={state.selectedDate}
                today={today}
                maxDate={maxDate}
                availability={bookingPage.availability}
                dateOverrides={bookingPage.dateOverrides}
                duration={bookingPage.duration}
                emptyDates={state.emptyDates}
                pendingDates={state.pendingDates}
                accentColor={accentColor}
                onDateSelect={handleDateSelect}
                onMonthChange={(month) => dispatch({ type: 'set-month', month })}
              />
              <TimeSlotList
                selectedDate={state.selectedDate}
                initialLoading={state.initialLoading}
                slotsLoading={slotsLoading || rescheduling}
                slots={state.slots}
                currentSlotStart={state.isRescheduling ? (state.confirmedSlot?.start ?? null) : null}
                use24h={state.use24h}
                timezone={state.timezone}
                onUse24hChange={(use24h) => dispatch({ type: 'use-24h', use24h })}
                onSlotSelect={handleSlotSelect}
              />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
