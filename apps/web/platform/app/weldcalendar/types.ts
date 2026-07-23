export type {
  CalendarEvent,
  BookingPage,
  WeeklyAvailability,
  TimeRange,
  BookingQuestion,
  TimeSlot,
  Booking,
} from '@/hooks/queries/use-calendar-queries';

export const DEFAULT_AVAILABILITY: import('@/hooks/queries/use-calendar-queries').WeeklyAvailability = {
  monday: [{ start: '09:00', end: '17:00' }],
  tuesday: [{ start: '09:00', end: '17:00' }],
  wednesday: [{ start: '09:00', end: '17:00' }],
  thursday: [{ start: '09:00', end: '17:00' }],
  friday: [{ start: '09:00', end: '17:00' }],
  saturday: [],
  sunday: [],
};

export const DURATION_OPTIONS = [
  { label: '15 minutes', value: 15 },
  { label: '30 minutes', value: 30 },
  { label: '45 minutes', value: 45 },
  { label: '1 hour', value: 60 },
  { label: '1.5 hours', value: 90 },
  { label: '2 hours', value: 120 },
] as const;

export const LOCATION_TYPE_OPTIONS = [
  { label: 'In Person', value: 'in-person' },
  { label: 'Phone Call', value: 'phone' },
  { label: 'WeldMeet', value: 'video' },
] as const;
