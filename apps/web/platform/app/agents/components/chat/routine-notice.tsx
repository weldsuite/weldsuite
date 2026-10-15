'use client';

import { CalendarClock } from 'lucide-react';
import { getTranslations, getLocale } from '@/lib/i18n';
import { describeCron, formatNextRun } from '../routine-schedule';
import type { ThreadRoutine } from './thread';

/** A routine the agent just scheduled, with a way to find it again. */
export function RoutineNotice({
  routine,
  onManage,
}: Readonly<{ routine: ThreadRoutine; onManage: () => void }>) {
  const t = getTranslations('common').agents.detail.routineNotice;
  const locale = getLocale();
  const schedule = describeCron(routine.cronExpr, t.schedule, locale);
  const next = formatNextRun(routine.nextRunAt, routine.timezone, locale);

  return (
    <div className="flex items-start gap-3 rounded-xl border bg-card px-3.5 py-3">
      <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-emerald-500/10 text-emerald-600">
        <CalendarClock className="h-4 w-4" />
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium">{t.scheduled.replace('{name}', routine.name)}</p>
        <p className="mt-0.5 text-xs text-muted-foreground">
          {[schedule, routine.timezone].filter(Boolean).join(' · ')}
        </p>
        {next && <p className="mt-0.5 text-xs text-muted-foreground">{t.next.replace('{time}', next)}</p>}
        <p className="mt-1.5 text-xs text-muted-foreground">{t.delivery}</p>
      </div>
      <button
        type="button"
        onClick={onManage}
        className="shrink-0 rounded-md px-2 py-1 text-xs font-medium text-muted-foreground hover:bg-accent hover:text-foreground"
      >
        {t.manage}
      </button>
    </div>
  );
}
