import { addDays, addHours, nextMonday, setHours, setMinutes } from 'date-fns';

/** The quick snooze choices of the row menu and the reading pane's snooze button. */
export const SNOOZE_PRESETS = [
  { id: 'hour', labelKey: 'laterToday1Hour', toastKey: 'snoozed1Hour', until: (now: Date) => addHours(now, 1) },
  { id: 'hours', labelKey: 'laterToday4Hours', toastKey: 'snoozed4Hours', until: (now: Date) => addHours(now, 4) },
  {
    id: 'tomorrow',
    labelKey: 'tomorrowMorning',
    toastKey: 'snoozedUntilTomorrow',
    until: (now: Date) => setMinutes(setHours(addDays(now, 1), 8), 0),
  },
  {
    id: 'week',
    labelKey: 'nextWeek',
    toastKey: 'snoozedUntilNextWeek',
    until: (now: Date) => setMinutes(setHours(nextMonday(now), 8), 0),
  },
] as const;
