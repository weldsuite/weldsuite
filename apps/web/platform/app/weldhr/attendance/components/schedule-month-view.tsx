/**
 * Attendance → Schedule, month view: a month grid in WeldCalendar's style.
 * Each day shows how many people work, their avatars, and who is on leave or
 * sick (dashed while a leave request waits for approval). Clicking a day opens
 * it in the day view.
 */

import { format } from 'date-fns';
import { useTranslations } from '@weldsuite/i18n/client';
import { TODAY_BLUE } from '@/app/weldcalendar/components/calendar-shared';
import { cn } from '@/lib/utils';
import { EmployeeAvatar, todayIso } from '../../components/shared';
import { monthGridWeeks, type DayStats } from './schedule-model';
import { TimeOffBar, useTimeOffText } from './schedule-parts';

/** Avatars and leave chips a day cell shows before summing up the rest. */
const MAX_AVATARS = 4;
const MAX_CHIPS = 2;

export function ScheduleMonthView({
  anchor,
  dayStats,
  onOpenDay,
}: Readonly<{
  /** Any day in the month to show. */
  anchor: string;
  /** Per day of the month; days of the months either side have none. */
  dayStats: Map<string, DayStats>;
  onOpenDay: (day: string) => void;
}>) {
  const t = useTranslations();
  const timeOffText = useTimeOffText();
  const weeks = monthGridWeeks(anchor);
  const month = anchor.slice(0, 7);
  const today = todayIso();

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-auto">
      <div className="grid shrink-0 grid-cols-7 border-b border-border">
        {weeks[0]!.map((day) => (
          <div
            key={day}
            className="border-r border-border py-2 text-center text-[11px] font-medium uppercase tracking-wide text-muted-foreground last:border-r-0"
          >
            {format(new Date(`${day}T12:00:00`), 'EEE')}
          </div>
        ))}
      </div>
      <div className="grid flex-1" style={{ gridTemplateRows: `repeat(${weeks.length}, minmax(116px, 1fr))` }}>
        {weeks.map((week) => (
          <div key={week[0]} className="grid grid-cols-7 border-b border-border last:border-b-0">
            {week.map((day) => {
              const inMonth = day.startsWith(month);
              const isToday = day === today;
              const stats = inMonth ? dayStats.get(day) : undefined;
              const working = stats?.working ?? [];
              const chips = [...(stats?.away ?? []), ...(stats?.requested ?? [])];
              const date = new Date(`${day}T12:00:00`);
              return (
                <div
                  key={day}
                  className={cn(
                    'relative min-w-0 overflow-hidden border-r border-border p-1.5 last:border-r-0',
                    inMonth ? 'transition-colors hover:bg-accent/30' : 'bg-muted/50',
                  )}
                >
                  {inMonth && (
                    <button
                      type="button"
                      onClick={() => onOpenDay(day)}
                      aria-label={t('weldhr.attendance.schedule.openDay', { date: format(date, 'EEEE d MMMM') })}
                      className="absolute inset-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                    />
                  )}
                  <div className="pointer-events-none relative flex items-center justify-between gap-1">
                    <span className="truncate pl-0.5 text-[11px] tabular-nums text-muted-foreground">
                      {working.length > 0 && t('weldhr.attendance.schedule.dayOn', { count: working.length })}
                    </span>
                    <span
                      className={cn(
                        'flex h-6 w-6 shrink-0 items-center justify-center rounded-[7px] text-sm font-medium',
                        isToday && 'font-semibold',
                        !inMonth && 'text-muted-foreground',
                      )}
                      style={isToday ? { color: TODAY_BLUE } : undefined}
                    >
                      {format(date, 'd')}
                    </span>
                  </div>
                  {stats && (
                    <div className="pointer-events-none relative mt-1 space-y-1">
                      {working.length > 0 && (
                        // Side by side, not overlapping: overlapped initials hide each other.
                        <div className="flex items-center gap-1">
                          {working.slice(0, MAX_AVATARS).map((employee) => (
                            <EmployeeAvatar key={employee.id} name={employee.name} src={employee.avatarUrl} className="h-6 w-6 shrink-0" />
                          ))}
                          {working.length > MAX_AVATARS && (
                            <span className="text-[11px] tabular-nums text-muted-foreground">+{working.length - MAX_AVATARS}</span>
                          )}
                        </div>
                      )}
                      {chips.slice(0, MAX_CHIPS).map(({ employee, item }) => {
                        const { label, title } = timeOffText(item);
                        return (
                          <TimeOffBar
                            key={`${employee.id}|${item.id}`}
                            item={item}
                            label={`${employee.name.split(' ')[0]} · ${label}`}
                            title={`${employee.name} · ${title}`}
                            className="h-5"
                          />
                        );
                      })}
                      {chips.length > MAX_CHIPS && (
                        <div className="pl-0.5 text-[11px] text-muted-foreground">
                          {t('weldhr.attendance.schedule.more', { count: chips.length - MAX_CHIPS })}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}
