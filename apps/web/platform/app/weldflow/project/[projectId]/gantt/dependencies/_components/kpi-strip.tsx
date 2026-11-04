import type { ProjectSchedule } from '@weldsuite/app-api-client/domains/project-schedule';
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/i18n/provider';
import { fill, intlLocaleOf, shortDate, taskLabel } from '../_lib/format';

function Tile({ label, value, detail, tone }: Readonly<{ label: string; value: string; detail: string; tone?: 'bad' | 'good' | 'warn' }>) {
  return (
    <div className="rounded-lg border bg-card px-4 py-3">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div
        className={cn(
          'mt-0.5 text-lg font-semibold tabular-nums',
          tone === 'bad' && 'text-red-700 dark:text-red-400',
          tone === 'warn' && 'text-orange-700 dark:text-orange-400',
          tone === 'good' && 'text-emerald-700 dark:text-emerald-400',
        )}
      >
        {value}
      </div>
      <div className="mt-0.5 text-xs text-muted-foreground">{detail}</div>
    </div>
  );
}

function floatTileOf(
  schedule: ProjectSchedule,
  copy: ReturnType<typeof useI18n>['t']['flowSchedule']['dependencies']['kpis'],
  locale: string,
): { value: string; detail: string; tone: 'bad' | 'warn' | 'good' | undefined } {
  const slack = schedule.goLiveSlackDays;
  if (slack === null || !schedule.goLive.date || !schedule.finish) {
    return { value: copy.floatNone, detail: copy.floatNoneDetail, tone: undefined };
  }
  const value = fill(copy.floatValue, { days: slack });
  if (slack < 0) return { value, detail: fill(copy.floatLate, { days: -slack }), tone: 'bad' };
  return {
    value,
    detail: fill(copy.floatDetail, { finish: shortDate(schedule.finish, locale), goLive: shortDate(schedule.goLive.date, locale) }),
    tone: slack <= 2 ? 'warn' : 'good',
  };
}

/** Critical path, float to go-live, conflicts and tasks without links. */
export function KpiStrip({ schedule }: Readonly<{ schedule: ProjectSchedule }>) {
  const { t, language } = useI18n();
  const copy = t.flowSchedule.dependencies.kpis;
  const locale = intlLocaleOf(language);
  const { summary } = schedule;
  const byId = new Map(schedule.tasks.map((task) => [task.id, task]));

  const floatTile = floatTileOf(schedule, copy, locale);

  const first = schedule.conflicts[0];
  const successor = first ? byId.get(first.successorId) : undefined;
  const predecessor = first ? byId.get(first.predecessorId) : undefined;
  const unlinked = schedule.tasks.find((task) => task.scheduled && !task.linked);

  return (
    <div className="grid gap-3 [grid-template-columns:repeat(auto-fit,minmax(13rem,1fr))]">
      <Tile
        label={copy.critical}
        value={summary.criticalCount > 0 ? fill(copy.criticalValue, { days: summary.criticalSpanDays ?? 0 }) : copy.criticalNone}
        detail={summary.criticalCount > 0 ? fill(copy.criticalDetail, { count: summary.criticalCount }) : copy.criticalNoneDetail}
      />
      <Tile label={copy.float} value={floatTile.value} detail={floatTile.detail} tone={floatTile.tone} />
      <Tile
        label={copy.conflicts}
        value={summary.conflictCount > 0 ? fill(copy.conflictsValue, { count: summary.conflictCount }) : copy.conflictsNone}
        detail={
          successor && predecessor
            ? fill(copy.conflictsDetail, { task: taskLabel(successor), predecessor: taskLabel(predecessor) })
            : copy.conflictsNoneDetail
        }
        tone={summary.conflictCount > 0 ? 'bad' : undefined}
      />
      <Tile
        label={copy.unlinked}
        value={fill(copy.unlinkedValue, { count: summary.unlinkedCount, total: summary.scheduledCount })}
        detail={unlinked ? `${taskLabel(unlinked)}: ${copy.unlinkedDetail}` : copy.unlinkedNone}
      />
    </div>
  );
}
