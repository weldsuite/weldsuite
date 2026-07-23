'use client';

import { useEffect, useRef, type KeyboardEvent } from 'react';
import {
  addDays,
  format,
  isBefore,
  isToday as isDateToday,
  startOfDay,
} from 'date-fns';
import { ChevronLeft, ChevronRight } from 'lucide-react';

import { DAY_NAMES, type DayName } from '@/lib/constants';
import type { WeeklyAvailability } from '@/lib/schemas';

interface CalendarWidgetProps {
  currentMonth: Date;
  selectedDate: Date | null;
  today: Date;
  maxDate: Date;
  availability: WeeklyAvailability;
  emptyDates: Set<string>;
  pendingDates: Set<string>;
  accentColor: string;
  onDateSelect: (date: Date) => void;
  onMonthChange: (month: Date) => void;
}

export function CalendarWidget({
  currentMonth,
  selectedDate,
  today,
  maxDate,
  availability,
  emptyDates,
  pendingDates,
  accentColor,
  onDateSelect,
  onMonthChange,
}: CalendarWidgetProps) {
  const gridRef = useRef<HTMLDivElement>(null);

  const days = generateCalendarDays(currentMonth);

  // Keep one cell focusable (roving tabindex). Default to selected day, else
  // today if it's in this month, else the first available day.
  const focusableDate =
    selectedDate ??
    (isInMonth(today, currentMonth)
      ? today
      : (days.find((d): d is Date => d != null && !isBefore(d, today)) ?? days.find((d): d is Date => d != null) ?? null));

  const focusableKey = focusableDate ? format(focusableDate, 'yyyy-MM-dd') : null;

  const isDayDisabled = (day: Date): boolean => {
    const dayStr = format(day, 'yyyy-MM-dd');
    return (
      isBefore(day, today) ||
      day > maxDate ||
      !hasAvailabilityForDay(day, availability) ||
      emptyDates.has(dayStr) ||
      pendingDates.has(dayStr)
    );
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>, day: Date) => {
    let next: Date | null = null;
    switch (event.key) {
      case 'ArrowLeft':
        next = addDays(day, -1);
        break;
      case 'ArrowRight':
        next = addDays(day, 1);
        break;
      case 'ArrowUp':
        next = addDays(day, -7);
        break;
      case 'ArrowDown':
        next = addDays(day, 7);
        break;
      case 'Home':
        next = addDays(day, -day.getDay());
        break;
      case 'End':
        next = addDays(day, 6 - day.getDay());
        break;
      case 'Enter':
      case ' ':
        if (!isDayDisabled(day)) {
          event.preventDefault();
          onDateSelect(day);
        }
        return;
      default:
        return;
    }
    event.preventDefault();
    if (!next) return;
    if (next > maxDate) return;
    if (isBefore(next, today)) return;

    if (!isInMonth(next, currentMonth)) {
      onMonthChange(new Date(next.getFullYear(), next.getMonth(), 1));
    }

    // Defer focus until after the re-render so the cell exists.
    requestAnimationFrame(() => {
      const cell = gridRef.current?.querySelector<HTMLElement>(
        `[data-day="${format(next!, 'yyyy-MM-dd')}"]`,
      );
      cell?.focus();
    });
  };

  const prevDisabled =
    currentMonth.getFullYear() === today.getFullYear() &&
    currentMonth.getMonth() <= today.getMonth();

  return (
    <div className="flex-1 min-w-0 md:border-r md:border-b-0 md:border-gray-200 dark:md:border-[#26262B] flex flex-col overflow-hidden py-3 px-4 md:px-5">
      <div
        className="flex items-center justify-between"
        style={{ padding: '8px 6px 4px 8px' }}
      >
        <h2 className="text-lg tracking-tight tabular-nums">
          <span className="font-semibold text-gray-900 dark:text-[#F2F2F4]">
            {format(currentMonth, 'MMMM')}
          </span>{' '}
          <span className="font-normal text-gray-400 dark:text-[#6E6E76]">
            {format(currentMonth, 'yyyy')}
          </span>
        </h2>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() =>
              onMonthChange(
                new Date(currentMonth.getFullYear(), currentMonth.getMonth() - 1, 1),
              )
            }
            disabled={prevDisabled}
            aria-label="Previous month"
            className="h-8 w-8 flex items-center justify-center rounded-[10px] text-gray-400 dark:text-[#6E6E76] hover:text-gray-600 dark:hover:text-[#C4C4CA] hover:bg-gray-100 dark:hover:bg-[#1F1F23] transition-colors disabled:opacity-30 disabled:pointer-events-none"
          >
            <ChevronLeft className="h-4 w-4" aria-hidden="true" />
          </button>
          <button
            type="button"
            onClick={() =>
              onMonthChange(
                new Date(currentMonth.getFullYear(), currentMonth.getMonth() + 1, 1),
              )
            }
            aria-label="Next month"
            className="h-8 w-8 flex items-center justify-center rounded-[10px] text-gray-400 dark:text-[#6E6E76] hover:text-gray-600 dark:hover:text-[#C4C4CA] hover:bg-gray-100 dark:hover:bg-[#1F1F23] transition-colors"
          >
            <ChevronRight className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>
      </div>

      <div
        role="grid"
        aria-label="Select a date"
        ref={gridRef}
        className="contents"
      >
        <div
          role="row"
          className="grid mt-4 grid-cols-7 md:grid-cols-[repeat(7,59px)] gap-1 md:gap-1.5 md:justify-center"
        >
          {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((d) => (
            <div
              key={d}
              role="columnheader"
              className="text-[12px] font-medium text-gray-400 dark:text-[#6E6E76] text-center pt-2 pb-4 tracking-wide uppercase"
            >
              {d}
            </div>
          ))}
        </div>

        <div
          role="row"
          className="grid grid-cols-7 md:grid-cols-[repeat(7,59px)] gap-1 md:gap-1.5 md:justify-center"
        >
          {days.map((day, i) => {
            if (!day) {
              return (
                <div
                  key={`empty-${i}`}
                  role="gridcell"
                  className="aspect-square md:aspect-auto md:h-[59px]"
                />
              );
            }

            const dayStr = format(day, 'yyyy-MM-dd');
            const disabled = isDayDisabled(day);
            const isSelected = !!selectedDate && dayStr === format(selectedDate, 'yyyy-MM-dd');
            const isToday = isDateToday(day);
            const isFocusable = dayStr === focusableKey;

            return (
              <DayCell
                key={dayStr}
                day={day}
                dayStr={dayStr}
                disabled={disabled}
                isSelected={isSelected}
                isToday={isToday}
                isFocusable={isFocusable}
                accentColor={accentColor}
                onSelect={() => onDateSelect(day)}
                onKeyDown={(e) => handleKeyDown(e, day)}
              />
            );
          })}
        </div>
      </div>
    </div>
  );
}

interface DayCellProps {
  day: Date;
  dayStr: string;
  disabled: boolean;
  isSelected: boolean;
  isToday: boolean;
  isFocusable: boolean;
  accentColor: string;
  onSelect: () => void;
  onKeyDown: (e: KeyboardEvent<HTMLDivElement>) => void;
}

function DayCell({
  day,
  dayStr,
  disabled,
  isSelected,
  isToday,
  isFocusable,
  accentColor,
  onSelect,
  onKeyDown,
}: DayCellProps) {
  // Make the *cell* the keyboard target so arrow nav works even on disabled
  // dates. Click is only enabled on the inner button when not disabled.
  return (
    <div
      role="gridcell"
      aria-selected={isSelected}
      aria-disabled={disabled}
      data-day={dayStr}
      tabIndex={isFocusable ? 0 : -1}
      onKeyDown={onKeyDown}
      className="flex flex-col items-center justify-center outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-blue-500 rounded-lg"
    >
      {!disabled || isSelected ? (
        <button
          type="button"
          tabIndex={-1}
          onClick={onSelect}
          aria-label={format(day, 'EEEE, MMMM d, yyyy')}
          className={`
            relative flex items-center justify-center rounded-lg text-[14px] tabular-nums transition-colors w-full aspect-square md:aspect-auto md:w-[59px] md:h-[59px]
            ${isSelected || isToday ? 'font-semibold' : 'font-medium'}
            ${
              isSelected
                ? 'text-white dark:!bg-[#F2F2F4] dark:!text-[#0A0A0B]'
                : 'bg-gray-200/60 dark:bg-[#1F1F23]/60 text-gray-900 dark:text-[#F2F2F4] hover:bg-[#dadade] dark:hover:bg-[#2E2E33]/70 cursor-pointer'
            }
          `}
          style={isSelected ? { backgroundColor: accentColor } : undefined}
        >
          {day.getDate()}
          {isToday && !isSelected && (
            <span
              aria-hidden="true"
              className="absolute bottom-3 left-1/2 -translate-x-1/2 h-1 w-1 rounded-full bg-gray-900 dark:bg-[#F2F2F4]"
            />
          )}
          {isToday && isSelected && (
            <span
              aria-hidden="true"
              className="absolute bottom-3 left-1/2 -translate-x-1/2 h-1 w-1 rounded-full bg-white dark:bg-[#0A0A0B]"
            />
          )}
        </button>
      ) : (
        <span
          aria-hidden="true"
          className={`relative text-[14px] tabular-nums text-gray-300 dark:text-[#3F3F46] select-none flex items-center justify-center w-full aspect-square md:aspect-auto md:w-[59px] md:h-[59px] ${
            isToday ? 'font-semibold' : 'font-medium'
          }`}
        >
          {day.getDate()}
          {isToday && (
            <span className="absolute bottom-3 left-1/2 -translate-x-1/2 h-1 w-1 rounded-full bg-gray-400" />
          )}
        </span>
      )}
    </div>
  );
}

function generateCalendarDays(month: Date): (Date | null)[] {
  const year = month.getFullYear();
  const m = month.getMonth();
  const firstDay = new Date(year, m, 1);
  const lastDay = new Date(year, m + 1, 0);
  const startPad = firstDay.getDay();
  const days: (Date | null)[] = [];

  for (let i = 0; i < startPad; i++) days.push(null);
  for (let d = 1; d <= lastDay.getDate(); d++) days.push(new Date(year, m, d));

  return days;
}

function isInMonth(day: Date, month: Date): boolean {
  return day.getFullYear() === month.getFullYear() && day.getMonth() === month.getMonth();
}

export function hasAvailabilityForDay(date: Date, availability: WeeklyAvailability): boolean {
  const dayName = DAY_NAMES[date.getDay() as 0 | 1 | 2 | 3 | 4 | 5 | 6] satisfies DayName;
  const slots = availability[dayName] ?? [];
  return slots.length > 0;
}

// Re-exported so the orchestrator can use the same `today` zero-time normalisation.
export const todayStart = () => startOfDay(new Date());
