import { useMemo } from 'react';
import { Skeleton } from '@weldsuite/ui/components/skeleton';
import { ErrorState } from '@weldsuite/ui/components/error-banner';
import { EmptyText } from '@weldsuite/ui/components/empty-state';
import { KpiCard, KpiGrid } from '@weldsuite/ui/components/kpi-card';
import { SectionCard } from '@weldsuite/ui/components/section-card';
import { useParams } from '@/lib/router';
import { useI18n } from '@/lib/i18n/provider';
import { useObjectPanel } from '@/components/object-panel';
import { BurndownChart } from '@/components/weldflow/agile/burndown-chart';
import { useProjectDelivery, useSprint, useSprintReport } from '@/hooks/queries/use-flow-agile-queries';
import { isClosedStatus, useProjectItems } from '@/hooks/queries/use-flow-agile-sprint-queries';
import type { ApiTask } from '@/app/weldflow/lib/api-client';
import { intlLocaleOf, shortDate } from '@/app/weldflow/project/[projectId]/gantt/dependencies/_lib/format';

function ItemList({ items, empty }: Readonly<{ items: readonly ApiTask[]; empty: string }>) {
  const { t, plural } = useI18n();
  const { open } = useObjectPanel();
  if (items.length === 0) return <EmptyText>{empty}</EmptyText>;
  return (
    <ul className="divide-y">
      {items.map((task) => (
        <li key={task.id}>
          <button
            type="button"
            onClick={() => open({ type: 'task', id: task.id })}
            className="flex w-full items-center gap-3 px-1 py-2 text-left text-sm outline-none transition-colors hover:bg-accent/50 focus-visible:ring-[3px] focus-visible:ring-ring/50"
          >
            {task.number != null ? <span className="shrink-0 text-xs tabular-nums text-muted-foreground">#{task.number}</span> : null}
            <span className="min-w-0 flex-1 truncate">{task.title}</span>
            {task.storyPoints != null ? (
              <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{plural(task.storyPoints, t.flowAgile.points)}</span>
            ) : null}
          </button>
        </li>
      ))}
    </ul>
  );
}

/** Sprint, Report: the burndown, the numbers of the sprint and what is done and not done. Live while it runs, frozen once completed. */
export default function SprintReportPage() {
  const { t, plural, language, format } = useI18n();
  const copy = t.flowAgileSprints.report;
  const params = useParams();
  const projectId = params.projectId as string;
  const sprintId = params.sprintId as string;
  const delivery = useProjectDelivery(projectId);
  const sprint = useSprint(projectId, sprintId);
  const report = useSprintReport(projectId, sprintId);
  const planned = sprint.data?.status === 'planned';
  const items = useProjectItems(projectId, !planned);
  const completed = sprint.data?.status === 'completed';

  const { done, notDone } = useMemo(() => {
    const tasks = items.data ?? [];
    const ids = new Set(report.data?.carriedOver.taskIds ?? []);
    const inSprint = tasks.filter((task) => task.sprintId === sprintId);
    return {
      done: inSprint.filter((task) => isClosedStatus(task.status)),
      // A completed sprint's unfinished items moved on; the report remembers which they were.
      notDone: completed ? tasks.filter((task) => ids.has(task.id)) : inSprint.filter((task) => !isClosedStatus(task.status)),
    };
  }, [items.data, report.data, sprintId, completed]);

  if (!delivery.available) return null;
  if (report.isLoading) {
    return (
      <div role="status" aria-busy="true" className="grid gap-4">
        <Skeleton className="h-72 rounded-xl" />
        <Skeleton className="h-28 rounded-xl" />
      </div>
    );
  }
  if (report.isError && planned) return <EmptyText>{copy.noBurndown}</EmptyText>;
  if (report.isError || !report.data) return <ErrorState message={copy.loadFailed} onRetry={() => void report.refetch()} />;

  const data = report.data;
  const points = (value: number) => plural(value, t.flowAgile.points);
  const count = (value: number) => plural(value, t.flowAgileSprints.items);
  let goal = copy.goalOpen;
  if (data.goalMet === true) goal = copy.goalYes;
  else if (data.goalMet === false) goal = copy.goalNo;
  const completedAt = data.completedAt ?? sprint.data?.completedAt;
  const note = completed && completedAt ? format(copy.frozen, { date: shortDate(completedAt, intlLocaleOf(language)) }) : copy.live;
  const carriedHint = data.carriedOver.count > 0 && completed
    ? format(copy.carriedTo, { sprint: count(data.carriedOver.count - data.carriedOver.toBacklog), backlog: count(data.carriedOver.toBacklog) })
    : undefined;

  return (
    <div className="grid gap-4">
      <p className="text-sm text-muted-foreground">{note}</p>

      <SectionCard title={copy.burndown} description={copy.burndownDescription}>
        {data.burndown.length > 0 ? (
          <BurndownChart points={data.burndown} label={copy.burndown} />
        ) : (
          <EmptyText>{copy.noBurndown}</EmptyText>
        )}
      </SectionCard>

      <section aria-label={copy.numbers}>
        <KpiGrid className="lg:grid-cols-3 xl:grid-cols-6">
          <KpiCard label={copy.committed} value={points(data.committed.points)} hint={count(data.committed.count)} />
          <KpiCard label={copy.completed} value={points(data.completed.points)} hint={count(data.completed.count)} tone="success" />
          <KpiCard
            label={copy.added}
            value={points(data.added.points)}
            hint={count(data.added.count)}
            tone={data.added.points > 0 ? 'warning' : 'default'}
          />
          <KpiCard label={copy.removed} value={points(data.removed.points)} hint={count(data.removed.count)} />
          <KpiCard label={copy.carriedOver} value={points(data.carriedOver.points)} hint={carriedHint ?? count(data.carriedOver.count)} />
          <KpiCard label={copy.goalMet} value={goal} tone={data.goalMet === true ? 'success' : data.goalMet === false ? 'danger' : 'default'} />
        </KpiGrid>
      </section>

      {items.isError ? (
        <ErrorState message={copy.itemsFailed} onRetry={() => void items.refetch()} />
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          <SectionCard title={`${copy.doneTitle} · ${done.length}`}>
            {items.isLoading ? <Skeleton className="h-24 rounded-lg" /> : <ItemList items={done} empty={copy.noneDone} />}
          </SectionCard>
          <SectionCard title={`${completed ? copy.carriedTitle : copy.notDoneTitle} · ${notDone.length}`}>
            {items.isLoading ? <Skeleton className="h-24 rounded-lg" /> : <ItemList items={notDone} empty={copy.noneLeft} />}
          </SectionCard>
        </div>
      )}
    </div>
  );
}
