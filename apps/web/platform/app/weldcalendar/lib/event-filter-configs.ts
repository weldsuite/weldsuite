import { getTranslations } from '@/lib/i18n';
import type { FilterConfig } from '@/components/entity-list';
import type { UserCalendar } from '@/hooks/queries/use-calendar-queries';

/**
 * The fields the toolbar "Filter" button offers on every calendar surface that
 * shows events (main calendar, booking page view). The field names are the
 * ones `applyEventFilters` understands, keep the two in step.
 */
export function buildEventFilterConfigs(calendars: readonly UserCalendar[]): FilterConfig[] {
  const t = getTranslations('weldcalendar');
  return [
    {
      field: 'type',
      label: t.calendarView.filterType,
      options: [
        { value: 'meeting', label: t.calendarView.filterTypeMeeting },
        { value: 'event', label: t.calendarView.filterTypeEvent },
        { value: 'call', label: t.calendarView.filterTypeCall },
        { value: 'appointment', label: t.calendarView.filterTypeAppointment },
        { value: 'reminder', label: t.calendarView.filterTypeTask },
        { value: 'other', label: t.calendarView.filterTypeOther },
      ],
    },
    {
      field: 'calendar',
      label: t.calendarView.filterCalendar,
      options: calendars.map((c) => ({ value: c.id, label: c.name })),
    },
    {
      field: 'status',
      label: t.calendarView.filterStatus,
      options: [
        { value: 'confirmed', label: t.calendarView.filterStatusConfirmed },
        { value: 'tentative', label: t.calendarView.filterStatusTentative },
        { value: 'cancelled', label: t.calendarView.filterStatusCancelled },
      ],
    },
    {
      field: 'priority',
      label: t.calendarView.filterPriority,
      options: [
        { value: 'low', label: t.calendarView.filterPriorityLow },
        { value: 'normal', label: t.calendarView.filterPriorityNormal },
        { value: 'high', label: t.calendarView.filterPriorityHigh },
        { value: 'urgent', label: t.calendarView.filterPriorityUrgent },
      ],
    },
    {
      field: 'allDay',
      label: t.calendarView.filterAllDay,
      options: [
        { value: 'true', label: t.calendarView.filterAllDayYes },
        { value: 'false', label: t.calendarView.filterAllDayNo },
      ],
    },
  ];
}
