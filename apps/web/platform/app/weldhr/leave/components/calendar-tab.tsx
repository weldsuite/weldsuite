/** Leave → Calendar: a month grid of approved and pending leave. */

import { useMemo, useState } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { Card } from '@weldsuite/ui/components/card';
import { useTranslations } from '@weldsuite/i18n/client';
import { useHrLeaveRequests } from '@/hooks/queries/use-weldhr-queries';
import { PageLoader } from '@/components/page-loader';
import { ErrorBanner, errorMessage, todayIso } from '../../components/shared';

function monthBounds(anchor: string) {
  const [year, month] = anchor.split('-').map(Number) as [number, number];
  const first = new Date(year, month - 1, 1);
  const last = new Date(year, month, 0);
  const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  return { first, last, firstIso: iso(first), lastIso: iso(last), year, month };
}

function shiftMonth(anchor: string, delta: number): string {
  const [year, month] = anchor.split('-').map(Number) as [number, number];
  const d = new Date(year, month - 1 + delta, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

const WEEKDAY_LABELS_START = 1; // Monday-first grid

export function CalendarTab() {
  const t = useTranslations();
  const [anchor, setAnchor] = useState(() => todayIso().slice(0, 7));
  const { first, lastIso, firstIso, year, month } = monthBounds(anchor);

  const { data: requests, isLoading, error } = useHrLeaveRequests({ status: 'approved,pending', from: firstIso, to: lastIso });

  const cells = useMemo(() => {
    const daysInMonth = new Date(year, month, 0).getDate();
    const leadingBlank = (first.getDay() - WEEKDAY_LABELS_START + 7) % 7;
    const out: Array<{ date: string | null; day: number | null }> = [];
    for (let i = 0; i < leadingBlank; i++) out.push({ date: null, day: null });
    for (let d = 1; d <= daysInMonth; d++) {
      out.push({ date: `${year}-${String(month).padStart(2, '0')}-${String(d).padStart(2, '0')}`, day: d });
    }
    return out;
  }, [year, month, first]);

  function leaveOn(date: string) {
    return (requests ?? []).filter((r) => r.startDate <= date && r.endDate >= date);
  }

  const today = todayIso();

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <Button variant="outline" size="icon" className="h-8 w-8" onClick={() => setAnchor((a) => shiftMonth(a, -1))}>
          <ChevronLeft className="h-4 w-4" />
        </Button>
        <Button variant="outline" size="sm" onClick={() => setAnchor(todayIso().slice(0, 7))}>
          {t('weldhr.leave.calendar.today')}
        </Button>
        <Button variant="outline" size="icon" className="h-8 w-8" onClick={() => setAnchor((a) => shiftMonth(a, 1))}>
          <ChevronRight className="h-4 w-4" />
        </Button>
        <span className="ml-2 text-sm font-medium">
          {first.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })}
        </span>
      </div>

      <ErrorBanner error={error ? errorMessage(error, t('weldhr.leave.calendar.loadFailed')) : null} />

      {isLoading ? (
        <PageLoader fullScreen={false} />
      ) : (
        <Card className="overflow-hidden p-0">
          <div className="grid grid-cols-7 border-b bg-muted/50 text-xs font-medium text-muted-foreground">
            {[1, 2, 3, 4, 5, 6, 0].map((weekday) => (
              <div key={weekday} className="px-2 py-1.5">
                {new Date(2024, 0, weekday + 1).toLocaleDateString(undefined, { weekday: 'short' })}
              </div>
            ))}
          </div>
          <div className="grid grid-cols-7">
            {cells.map((cell, i) => {
              const entries = cell.date ? leaveOn(cell.date) : [];
              const shown = entries.slice(0, 3);
              const extra = entries.length - shown.length;
              return (
                <div
                  key={i}
                  className={`min-h-24 border-b border-r p-1.5 last:border-r-0 ${cell.date === today ? 'bg-primary/5' : ''}`}
                >
                  {cell.day && (
                    <>
                      <p className="mb-1 text-xs text-muted-foreground">{cell.day}</p>
                      <div className="space-y-0.5">
                        {shown.map((entry) => (
                          <div
                            key={entry.id}
                            className="truncate rounded px-1 py-0.5 text-[11px]"
                            style={{ backgroundColor: `${entry.leaveTypeColor ?? '#94a3b8'}22`, color: entry.leaveTypeColor ?? undefined }}
                            title={`${entry.employeeName} · ${entry.leaveTypeName ?? ''}`}
                          >
                            {entry.employeeName}
                          </div>
                        ))}
                        {extra > 0 && <p className="text-[11px] text-muted-foreground">{t('weldhr.leave.calendar.more', { count: extra })}</p>}
                        {entries.length === 0 && cell.date && <p className="text-[11px] text-muted-foreground/50">·</p>}
                      </div>
                    </>
                  )}
                </div>
              );
            })}
          </div>
        </Card>
      )}
    </div>
  );
}
