import { useState, useMemo, useEffect } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@weldsuite/ui/components/button';
import { useTranslations } from '@weldsuite/i18n/client';

interface MiniCalendarProps {
  selectedDate?: Date;
  onDateSelect?: (date: Date) => void;
}

export function MiniCalendar({ selectedDate: externalSelectedDate, onDateSelect }: MiniCalendarProps) {
  const t = useTranslations();
  const DAY_LABELS = t('sweep.miscA.miniCalendar.dayLabels').split(',');
  const today = new Date();
  const [viewMonth, setViewMonth] = useState(today.getMonth());
  const [viewYear, setViewYear] = useState(today.getFullYear());
  const [selectedDate, setSelectedDate] = useState<Date | undefined>(externalSelectedDate);

  // Listen for main calendar navigation
  useEffect(() => {
    const handler = (e: Event) => {
      const date = new Date((e as CustomEvent).detail.date);
      setSelectedDate(date);
      setViewMonth(date.getMonth());
      setViewYear(date.getFullYear());
    };
    window.addEventListener('weldcalendar:navigate-to-date', handler);
    return () => window.removeEventListener('weldcalendar:navigate-to-date', handler);
  }, []);

  // Listen for main view date changes (when user navigates via toolbar)
  useEffect(() => {
    const handler = (e: Event) => {
      const date = new Date((e as CustomEvent).detail.date);
      setViewMonth(date.getMonth());
      setViewYear(date.getFullYear());
    };
    window.addEventListener('weldcalendar:view-date-changed', handler);
    return () => window.removeEventListener('weldcalendar:view-date-changed', handler);
  }, []);

  const monthLabel = new Date(viewYear, viewMonth).toLocaleString('default', { month: 'long', year: 'numeric' });

  const goToPrevMonth = () => {
    if (viewMonth === 0) {
      setViewMonth(11);
      setViewYear(viewYear - 1);
    } else {
      setViewMonth(viewMonth - 1);
    }
  };

  const goToNextMonth = () => {
    if (viewMonth === 11) {
      setViewMonth(0);
      setViewYear(viewYear + 1);
    } else {
      setViewMonth(viewMonth + 1);
    }
  };

  const handleDateClick = (date: Date) => {
    setSelectedDate(date);
    onDateSelect?.(date);
  };

  // Build the calendar grid
  const weeks = useMemo(() => {
    const firstDay = new Date(viewYear, viewMonth, 1);
    const lastDay = new Date(viewYear, viewMonth + 1, 0);
    const startDayOfWeek = firstDay.getDay(); // 0 = Sunday
    const daysInMonth = lastDay.getDate();

    const grid: (Date | null)[][] = [];
    let week: (Date | null)[] = [];

    // Fill leading empty cells
    for (let i = 0; i < startDayOfWeek; i++) {
      const prevDate = new Date(viewYear, viewMonth, -(startDayOfWeek - 1 - i));
      week.push(prevDate);
    }

    // Fill days
    for (let day = 1; day <= daysInMonth; day++) {
      week.push(new Date(viewYear, viewMonth, day));
      if (week.length === 7) {
        grid.push(week);
        week = [];
      }
    }

    // Fill trailing empty cells
    if (week.length > 0) {
      let nextDay = 1;
      while (week.length < 7) {
        week.push(new Date(viewYear, viewMonth + 1, nextDay++));
      }
      grid.push(week);
    }

    return grid;
  }, [viewMonth, viewYear]);

  const isToday = (date: Date) =>
    date.getDate() === today.getDate() &&
    date.getMonth() === today.getMonth() &&
    date.getFullYear() === today.getFullYear();

  const isSelected = (date: Date) =>
    selectedDate &&
    date.getDate() === selectedDate.getDate() &&
    date.getMonth() === selectedDate.getMonth() &&
    date.getFullYear() === selectedDate.getFullYear();

  const isCurrentMonth = (date: Date) => date.getMonth() === viewMonth;

  return (
    <div className="py-2.5">
      {/* Month navigation */}
      <div className="flex items-center justify-between mb-2.5 px-0.5">
        <span className="text-sm font-medium text-foreground ml-[9px]">{monthLabel}</span>
        <div className="flex items-center gap-0.5">
          <Button
            variant="ghost"
            onClick={goToPrevMonth}
            className="p-1 rounded-md hover:bg-black/[0.05] dark:hover:bg-black/20 transition-colors"
          >
            <ChevronLeft className="h-4 w-4 text-muted-foreground" />
          </Button>
          <Button
            variant="ghost"
            onClick={goToNextMonth}
            className="p-1 rounded-md hover:bg-black/[0.05] dark:hover:bg-black/20 transition-colors"
          >
            <ChevronRight className="h-4 w-4 text-muted-foreground" />
          </Button>
        </div>
      </div>

      {/* Day labels — matches the YearMonth header treatment exactly */}
      <div className="grid grid-cols-7">
        {DAY_LABELS.map((label, i) => (
          <div key={i} className="text-[10px] text-muted-foreground text-center py-0.5">
            {label}
          </div>
        ))}
      </div>

      {/* Calendar grid — same date-cell pattern as YearMonth in calendar-view.tsx:
          outer button is the click/hover hit area, inner span is the visual badge
          (w-7 h-7, leading-7, tabular-nums, rounded-[9px]). Today gets the filled
          foreground/background pill; non-today in-month rows show the hover ring;
          selected day uses bg-accent so it doesn't compete with today. */}
      <div className="grid grid-cols-7 gap-0">
        {weeks.flat().map((date, di) => {
          if (!date) return <div key={di} />;
          const current = isCurrentMonth(date);
          const todayDate = isToday(date);
          const selected = isSelected(date);

          return (
            <Button
              key={di}
              variant="ghost"
              onClick={() => handleDateClick(date)}
              className={cn(
                'relative text-[12px] font-medium h-8 w-full flex items-center justify-center transition-colors',
                !current && 'text-muted-foreground/50',
                current && !todayDate && !selected && 'text-foreground',
              )}
            >
              <span
                className={cn(
                  'inline-block text-center tabular-nums rounded-[9px] transition-colors',
                  'w-7 h-7 leading-7',
                  todayDate && 'text-[#2563eb] font-semibold',
                  selected && !todayDate && 'bg-zinc-200/70 dark:bg-zinc-700/70 text-foreground font-semibold',
                  !todayDate && !selected && current && 'hover:bg-black/[0.05] dark:hover:bg-black/20',
                )}
              >
                {date.getDate()}
              </span>
            </Button>
          );
        })}
      </div>
    </div>
  );
}
