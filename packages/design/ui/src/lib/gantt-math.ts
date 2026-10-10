import {
  addDays,
  addMonths,
  addWeeks,
  differenceInDays,
  differenceInHours,
  differenceInMonths,
  differenceInWeeks,
  endOfDay,
  endOfMonth,
  endOfWeek,
  getDate,
  getDaysInMonth,
  isSameDay,
  startOfDay,
  startOfMonth,
  startOfWeek,
} from 'date-fns';

/**
 * Pure date <-> pixel math for the Gantt chart. Kept free of React so the drag
 * behaviour can be unit tested.
 *
 * Coordinates are measured in pixels from the start of the timeline (1 January
 * of the first rendered year). One column is `columnWidth * zoom / 100` px wide:
 * a day (daily), a Monday-aligned week (weekly), or a calendar month
 * (monthly / quarterly).
 */

export type GanttRange = 'daily' | 'weekly' | 'monthly' | 'quarterly';

export type GanttMathContext = {
  range: GanttRange;
  /** Base column width in px (before zoom). */
  columnWidth: number;
  /** Zoom percentage, 100 = no zoom. */
  zoom: number;
};

const WEEK_OPTIONS = { weekStartsOn: 1 } as const;

export const getsDaysIn = (range: GanttRange) => {
  if (range === 'monthly' || range === 'quarterly') return getDaysInMonth;
  if (range === 'weekly') return (_date: Date) => 7;
  return (_date: Date) => 1; // daily
};

export const getDifferenceIn = (range: GanttRange) => {
  if (range === 'monthly' || range === 'quarterly') return differenceInMonths;
  if (range === 'weekly') {
    // Monday-aligned week count so bar offsets and the today indicator
    // anchor to the same week boundaries.
    return (later: Date, earlier: Date) =>
      differenceInWeeks(
        startOfWeek(later, WEEK_OPTIONS),
        startOfWeek(earlier, WEEK_OPTIONS)
      );
  }
  return differenceInDays; // daily
};

export const getInnerDifferenceIn = (range: GanttRange) => {
  if (range === 'monthly' || range === 'quarterly') return differenceInDays;
  if (range === 'weekly') return differenceInDays;
  return differenceInHours; // daily
};

export const getStartOf = (range: GanttRange) => {
  if (range === 'monthly' || range === 'quarterly') return startOfMonth;
  if (range === 'weekly') return (date: Date) => startOfWeek(date, WEEK_OPTIONS);
  return startOfDay; // daily
};

export const getEndOf = (range: GanttRange) => {
  if (range === 'monthly' || range === 'quarterly') return endOfMonth;
  if (range === 'weekly') return (date: Date) => endOfWeek(date, WEEK_OPTIONS);
  return endOfDay; // daily
};

export const getAddRange = (range: GanttRange) => {
  if (range === 'monthly' || range === 'quarterly') return addMonths;
  if (range === 'weekly') return addWeeks;
  return addDays; // daily
};

export const getColumnWidthPx = (context: GanttMathContext) =>
  (context.columnWidth * context.zoom) / 100;

/** Position of `date` in px from the start of the timeline. */
export const getOffset = (
  date: Date,
  timelineStartDate: Date,
  context: GanttMathContext
) => {
  const parsedColumnWidth = getColumnWidthPx(context);
  const differenceIn = getDifferenceIn(context.range);
  const startOf = getStartOf(context.range);
  const fullColumns = differenceIn(startOf(date), timelineStartDate);

  if (context.range === 'daily') {
    return parsedColumnWidth * fullColumns;
  }

  if (context.range === 'weekly') {
    // Days since the Monday that starts this week column (0-6).
    const dayInWeek = differenceInDays(startOfDay(date), startOf(date));
    return fullColumns * parsedColumnWidth + (dayInWeek * parsedColumnWidth) / 7;
  }

  const partialColumns = date.getDate();
  const daysInMonth = getDaysInMonth(date);
  const pixelsPerDay = parsedColumnWidth / daysInMonth;

  return fullColumns * parsedColumnWidth + partialColumns * pixelsPerDay;
};

/** Width in px of a bar spanning `startAt` .. `endAt`. */
export const getWidth = (
  startAt: Date,
  endAt: Date | null,
  context: GanttMathContext
) => {
  const parsedColumnWidth = getColumnWidthPx(context);

  if (!endAt) {
    return parsedColumnWidth * 2;
  }

  const differenceIn = getDifferenceIn(context.range);

  if (context.range === 'daily') {
    const delta = differenceIn(endAt, startAt);

    return parsedColumnWidth * (delta || 1);
  }

  if (context.range === 'weekly') {
    const days = differenceInDays(startOfDay(endAt), startOfDay(startAt));
    return (Math.max(days, 1) * parsedColumnWidth) / 7;
  }

  const daysInStartMonth = getDaysInMonth(startAt);
  const pixelsPerDayInStartMonth = parsedColumnWidth / daysInStartMonth;

  if (isSameDay(startAt, endAt)) {
    return pixelsPerDayInStartMonth;
  }

  const innerDifferenceIn = getInnerDifferenceIn(context.range);
  const startOf = getStartOf(context.range);

  if (isSameDay(startOf(startAt), startOf(endAt))) {
    return innerDifferenceIn(endAt, startAt) * pixelsPerDayInStartMonth;
  }

  const startRangeOffset = daysInStartMonth - getDate(startAt);
  const endRangeOffset = getDate(endAt);
  const fullRangeOffset = differenceIn(startOf(endAt), startOf(startAt));
  const daysInEndMonth = getDaysInMonth(endAt);
  const pixelsPerDayInEndMonth = parsedColumnWidth / daysInEndMonth;

  return (
    (fullRangeOffset - 1) * parsedColumnWidth +
    startRangeOffset * pixelsPerDayInStartMonth +
    endRangeOffset * pixelsPerDayInEndMonth
  );
};

/**
 * Inverse of {@link getOffset}: the whole day whose offset is nearest to `px`.
 * Always returns local midnight, so a drag snaps to whole days.
 */
export const getDateAtOffset = (
  px: number,
  timelineStartDate: Date,
  context: GanttMathContext
): Date => {
  const columnWidth = getColumnWidthPx(context);
  const columnIndex = Math.floor(px / columnWidth);
  const withinColumn = px - columnIndex * columnWidth;

  if (context.range === 'daily') {
    return addDays(startOfDay(timelineStartDate), Math.round(px / columnWidth));
  }

  if (context.range === 'weekly') {
    const weekStart = addWeeks(
      startOfWeek(timelineStartDate, WEEK_OPTIONS),
      columnIndex
    );
    return addDays(weekStart, Math.round((withinColumn / columnWidth) * 7));
  }

  const monthStart = addMonths(startOfMonth(timelineStartDate), columnIndex);
  const daysInMonth = getDaysInMonth(monthStart);
  const dayNumber = Math.round((withinColumn / columnWidth) * daysInMonth);
  // getOffset places day N of a month at N * pixelsPerDay, so a position of
  // `dayNumber` days into the column belongs to day number `dayNumber`.
  return addDays(monthStart, dayNumber - 1);
};

/**
 * How many whole days a bar that starts at `date` should move when it is
 * dragged `deltaX` pixels. Uses the real scale of the current view, so the bar
 * follows the cursor at every zoom level and range.
 */
export const getDragShiftDays = (
  deltaX: number,
  date: Date,
  timelineStartDate: Date,
  context: GanttMathContext
): number => {
  const originOffset = getOffset(date, timelineStartDate, context);
  const target = getDateAtOffset(
    originOffset + deltaX,
    timelineStartDate,
    context
  );
  const origin = getDateAtOffset(originOffset, timelineStartDate, context);

  return differenceInDays(target, origin);
};
