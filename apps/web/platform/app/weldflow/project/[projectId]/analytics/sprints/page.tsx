import { useMemo } from 'react';
import { CircleCheckBig, Gauge, Repeat2, TrendingUp } from 'lucide-react';
import { EmptyState, EmptyText } from '@weldsuite/ui/components/empty-state';
import { ErrorState } from '@weldsuite/ui/components/error-banner';
import { KpiCard, KpiGrid } from '@weldsuite/ui/components/kpi-card';
import { ListToolbar } from '@weldsuite/ui/components/list-toolbar';
import { PageLoader } from '@weldsuite/ui/components/page-loader';
import { SectionCard } from '@weldsuite/ui/components/section-card';
import { SoftBadge } from '@weldsuite/ui/components/soft-badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@weldsuite/ui/components/table';
import { useBreadcrumbs } from '@/contexts/breadcrumb-context';
import { Link, useParams } from '@/lib/router';
import { useI18n } from '@/lib/i18n/provider';
import { BurndownChart } from '@/components/weldflow/agile/burndown-chart';
import { VelocityChart } from '@/components/weldflow/agile/velocity-chart';
import { useProjectDelivery, useProjectSprints, useSprintReport } from '@/hooks/queries/use-flow-agile-queries';
import { completedSprints, sprintKpis, sprintPoints, velocityBars } from '@/app/weldflow/lib/sprint-metrics';
import { useSprintDates } from '@/app/weldflow/project/[projectId]/pipeline/_components/sprint-bar';
import { AnalyticsViewSwitch } from '../_components/analytics-view-switch';

function ActiveBurndown({ projectId, sprintId, name }: Readonly<{ projectId: string; sprintId: string; name: string }>) {
  const { t, format } = useI18n();
  const copy = t.flowAgileSprints.analytics;
  const report = useSprintReport(projectId, sprintId);
  if (report.isLoading) return <PageLoader fullScreen={false} />;
  if (report.isError || !report.data) return <ErrorState message={copy.loadFailed} onRetry={() => void report.refetch()} />;
  const label = format(copy.burndownFor, { name });
  return (
    <>
      <p className="mb-2 text-sm text-muted-foreground">{label}</p>
      <BurndownChart points={report.data.burndown} label={label} />
    </>
  );
}

/** Analytics, Sprints: velocity, commitment reliability, the running sprint's burndown and every completed sprint. */
export default function SprintAnalyticsPage() {
  const { t, plural } = useI18n();
  const copy = t.flowAgileSprints.analytics;
  const params = useParams();
  const projectId = params.projectId as string;
  const delivery = useProjectDelivery(projectId);
  const sprints = useProjectSprints(projectId, delivery.usesSprints);
  const dates = useSprintDates();

  useBreadcrumbs([
    { label: t.projects.title, href: '/weldflow' },
    { label: t.projects.analytics.projectAnalytics, href: `/weldflow/project/${projectId}/analytics` },
    { label: t.flowAgile.views.sprints },
  ]);

  const all = useMemo(() => sprints.data ?? [], [sprints.data]);
  const kpis = useMemo(() => sprintKpis(all), [all]);
  const bars = useMemo(() => velocityBars(all), [all]);
  const history = useMemo(() => [...completedSprints(all)].reverse(), [all]);
  const active = all.find((sprint) => sprint.status === 'active') ?? null;

  const toolbar = <ListToolbar leftActionButtons={<AnalyticsViewSwitch projectId={projectId} />} className="shrink-0 pt-2 pb-2" />;
  const points = (value: number | null) => (value === null ? copy.kpi.none : plural(value, t.flowAgile.points));

  let body;
  if (delivery.isLoading || sprints.isLoading) body = <PageLoader fullScreen={false} />;
  else if (!delivery.usesSprints) body = <EmptyState icon={Gauge} title={t.flowAgileSprints.page.unavailable} />;
  else if (sprints.isError) body = <ErrorState message={copy.loadFailed} onRetry={() => void sprints.refetch()} />;
  else {
    body = (
      <div className="grid gap-4">
        <KpiGrid>
          <KpiCard icon={TrendingUp} label={copy.kpi.averageVelocity} value={points(kpis.averageVelocity)} hint={copy.kpi.averageHint} />
          <KpiCard icon={Gauge} label={copy.kpi.lastVelocity} value={points(kpis.lastVelocity)} hint={copy.kpi.lastHint} />
          <KpiCard
            icon={CircleCheckBig}
            label={copy.kpi.reliability}
            value={kpis.reliability === null ? copy.kpi.none : `${kpis.reliability}%`}
            hint={copy.kpi.reliabilityHint}
          />
          <KpiCard
            icon={Repeat2}
            label={copy.kpi.carriedOver}
            value={kpis.carriedOver === null ? copy.kpi.none : plural(kpis.carriedOver, t.flowAgileSprints.items)}
            hint={copy.kpi.carriedHint}
          />
        </KpiGrid>

        <div className="grid gap-4 lg:grid-cols-2">
          <SectionCard title={copy.burndown}>
            {active ? <ActiveBurndown projectId={projectId} sprintId={active.id} name={active.name} /> : <EmptyText>{copy.noActive}</EmptyText>}
          </SectionCard>
          <SectionCard title={copy.velocity} description={copy.velocityDescription}>
            {bars.length > 0 ? (
              <VelocityChart bars={bars} average={kpis.averageVelocity} label={copy.velocity} />
            ) : (
              <EmptyText>{copy.noVelocity}</EmptyText>
            )}
          </SectionCard>
        </div>

        <SectionCard title={copy.history} description={copy.historyDescription} contentClassName="overflow-x-auto">
          {history.length === 0 ? (
            <EmptyState title={copy.emptyTitle} description={copy.emptyDescription} />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{copy.columns.sprint}</TableHead>
                  <TableHead>{copy.columns.dates}</TableHead>
                  <TableHead>{copy.columns.goal}</TableHead>
                  <TableHead className="text-right">{copy.columns.committed}</TableHead>
                  <TableHead className="text-right">{copy.columns.added}</TableHead>
                  <TableHead className="text-right">{copy.columns.completed}</TableHead>
                  <TableHead>{copy.columns.goalMet}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {history.map((sprint) => {
                  const numbers = sprintPoints(sprint);
                  const goalMet = sprint.report?.goalMet;
                  return (
                    <TableRow key={sprint.id}>
                      <TableCell className="font-medium">
                        <Link href={`/weldflow/project/${projectId}/sprints/${sprint.id}/report`} className="hover:underline">
                          {sprint.name}
                        </Link>
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-muted-foreground tabular-nums">{dates(sprint)}</TableCell>
                      <TableCell className="max-w-64 truncate text-muted-foreground" title={sprint.goal ?? undefined}>
                        {sprint.goal ?? ''}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">{numbers.committed}</TableCell>
                      <TableCell className="text-right tabular-nums">{sprint.report?.added?.points ? `+${sprint.report.added.points}` : '0'}</TableCell>
                      <TableCell className="text-right tabular-nums">{numbers.completed}</TableCell>
                      <TableCell>
                        {typeof goalMet === 'boolean' ? (
                          <SoftBadge tone={goalMet ? 'success' : 'danger'}>{goalMet ? copy.goalYes : copy.goalNo}</SoftBadge>
                        ) : (
                          <span className="text-muted-foreground">{copy.goalOpen}</span>
                        )}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </SectionCard>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      {toolbar}
      <div className="min-h-0 flex-1 overflow-y-auto px-3 pt-4 pb-8 md:px-4">{body}</div>
    </div>
  );
}
