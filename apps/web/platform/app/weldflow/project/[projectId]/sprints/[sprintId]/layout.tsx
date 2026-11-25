import type { ReactNode } from 'react';
import { ArrowLeft, CalendarX } from 'lucide-react';
import { isApiError } from '@weldsuite/api-client';
import { Button } from '@weldsuite/ui/components/button';
import { EmptyState } from '@weldsuite/ui/components/empty-state';
import { ErrorState } from '@weldsuite/ui/components/error-banner';
import { PageLoader } from '@weldsuite/ui/components/page-loader';
import { Link, useParams } from '@/lib/router';
import { useI18n } from '@/lib/i18n/provider';
import { ProjectSubNavLayout, type SubNavItem } from '@/app/weldflow/components/sub-nav';
import { useProjectDelivery, useSprint } from '@/hooks/queries/use-flow-agile-queries';
import { SprintActions } from '@/app/weldflow/project/[projectId]/pipeline/_components/sprint-actions';
import { SprintStatusBadge, useSprintDates } from '@/app/weldflow/project/[projectId]/pipeline/_components/sprint-bar';

/**
 * One sprint: its name, status, dates, goal and Start or Complete sprint on
 * top, then Board, Report and Retro as pills. The Board lays itself out edge to
 * edge; Report and Retro get the padded, scrolling content area.
 */
export default function SprintLayout({ children }: Readonly<{ children: ReactNode }>) {
  const { t, format } = useI18n();
  const copy = t.flowAgileSprints.page;
  const params = useParams();
  const projectId = params.projectId as string;
  const sprintId = params.sprintId as string;
  const delivery = useProjectDelivery(projectId);
  const query = useSprint(projectId, sprintId);
  const dates = useSprintDates();

  const pipelineHref = `/weldflow/project/${projectId}/pipeline?sprint=${encodeURIComponent(sprintId)}`;

  if (!delivery.isLoading && !delivery.available) {
    return <EmptyState icon={CalendarX} title={copy.unavailable} className="m-4" />;
  }
  if (query.isLoading || delivery.isLoading) return <PageLoader fullScreen={false} />;
  if (query.isError || !query.data) {
    const notFound = isApiError(query.error) && query.error.status === 404;
    if (notFound) {
      return (
        <EmptyState
          icon={CalendarX}
          title={copy.notFoundTitle}
          description={copy.notFoundDescription}
          action={
            <Button asChild variant="outline" size="sm">
              <Link href={`/weldflow/project/${projectId}/pipeline`}>{copy.backToSprints}</Link>
            </Button>
          }
          className="m-4"
        />
      );
    }
    return <ErrorState message={copy.loadFailed} onRetry={() => void query.refetch()} className="m-4" />;
  }

  const sprint = query.data;
  const views = t.flowAgile.views;
  const items: SubNavItem[] = [
    { id: 'board', label: views.board, path: '' },
    { id: 'report', label: views.report, path: '/report' },
    { id: 'retro', label: views.retro, path: '/retro' },
  ];
  const points = sprint.report?.completed?.points ?? sprint.storyPointsCompleted ?? null;
  const committed = sprint.report?.committed?.points ?? sprint.storyPointsCommitted ?? null;
  const done = sprint.status === 'completed';
  const goalMet = sprint.report?.goalMet;
  let goalText: string | null = null;
  if (done && typeof goalMet === 'boolean') goalText = goalMet ? copy.goalMet : copy.goalNotMet;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex shrink-0 flex-wrap items-start gap-x-4 gap-y-2 border-b border-border px-3 py-3 md:px-4">
        <Button asChild variant="ghost" size="icon" className="-ml-1 size-8">
          <Link href={pipelineHref} aria-label={copy.backToSprints} title={copy.backToSprints}>
            <ArrowLeft aria-hidden />
          </Link>
        </Button>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <h2 className="text-lg font-semibold">{sprint.name}</h2>
            <SprintStatusBadge status={sprint.status} />
            <span className="text-sm text-muted-foreground tabular-nums">
              {[
                dates(sprint),
                done && points !== null && committed !== null ? format(copy.stats, { completed: points, committed }) : null,
                goalText,
              ]
                .filter(Boolean)
                .join(' · ')}
            </span>
          </div>
          {sprint.goal ? <p className="mt-1 text-sm text-muted-foreground">{format(t.flowAgileSprints.bar.goal, { goal: sprint.goal })}</p> : null}
        </div>
        <div className="flex items-center gap-2">
          <SprintActions projectId={projectId} sprint={sprint} />
        </div>
      </header>
      <div className="min-h-0 flex-1">
        <ProjectSubNavLayout section={`sprints/${sprintId}`} label={copy.navLabel} items={items} fullBleedId="board">
          {children}
        </ProjectSubNavLayout>
      </div>
    </div>
  );
}
