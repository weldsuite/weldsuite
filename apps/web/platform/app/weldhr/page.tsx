/** WeldHR dashboard: headcount, today's attendance/leave, lifecycle, coaching follow-ups, recent evaluations, client accounts. */

import { Link } from '@tanstack/react-router';
import {
  CalendarClock,
  ClipboardList,
  Clock,
  MessageCircle,
  Palmtree,
  Star,
  Users,
} from 'lucide-react';
import { useTranslations } from '@weldsuite/i18n/client';
import { Button } from '@weldsuite/ui/components/button';
import { PageLoader } from '@/components/page-loader';
import { useHrDashboard } from '@/hooks/queries/use-weldhr-queries';
import { DashboardPage, KpiCard, KpiGrid, SectionCard, EmptyText, useHrBreadcrumbs } from './components/page-kit';
import { EmployeeAvatar, ErrorBanner, ScoreBadge, StatusBadge, errorMessage, formatDate } from './components/shared';

export default function WeldHrDashboardPage() {
  const t = useTranslations();
  useHrBreadcrumbs();
  const { data, isLoading, error } = useHrDashboard();

  if (isLoading) return <PageLoader fullScreen={false} />;

  return (
    <DashboardPage title={t('weldhr.title')}>
      <ErrorBanner error={error ? errorMessage(error, t('weldhr.dashboard.loadFailed')) : null} />

      {data && (
        <>
          <KpiGrid>
            <KpiCard label={t('weldhr.dashboard.headcount')} value={data.headcount.total} icon={Users} />
            <KpiCard label={t('weldhr.dashboard.clockedInToday')} value={data.today.clockedIn} icon={Clock} />
            <KpiCard label={t('weldhr.dashboard.onLeaveToday')} value={data.today.onLeave.length} icon={Palmtree} />
            <KpiCard
              label={t('weldhr.dashboard.pendingLeaveRequests')}
              value={data.pendingLeaveRequests}
              icon={CalendarClock}
              tone={data.pendingLeaveRequests > 0 ? 'warning' : 'default'}
            />
            <KpiCard
              label={t('weldhr.dashboard.openOnboardingTasks')}
              value={data.lifecycle.openTasks}
              icon={ClipboardList}
              hint={
                data.lifecycle.overdueTasks > 0
                  ? t('weldhr.dashboard.overdueOnboardingTasks', { count: data.lifecycle.overdueTasks })
                  : undefined
              }
              tone={data.lifecycle.overdueTasks > 0 ? 'danger' : 'default'}
            />
            <KpiCard
              label={t('weldhr.dashboard.coachingFollowUpsDue')}
              value={data.coachingFollowUpsDue}
              icon={MessageCircle}
              tone={data.coachingFollowUpsDue > 0 ? 'warning' : 'default'}
            />
            <KpiCard
              label={t('weldhr.dashboard.avgEvaluationScore')}
              value={data.evaluations.averageScore90d !== null ? data.evaluations.averageScore90d.toFixed(1) : '—'}
              icon={Star}
            />
          </KpiGrid>

          <div className="grid gap-4 lg:grid-cols-2">
            <SectionCard
              title={t('weldhr.dashboard.upcomingStarts.title')}
              action={
                <Link to="/weldhr/lifecycle">
                  <Button variant="ghost" size="sm">
                    {t('weldhr.dashboard.links.lifecycle')}
                  </Button>
                </Link>
              }
            >
              {data.lifecycle.upcomingStarts.length === 0 ? (
                <EmptyText>{t('weldhr.dashboard.upcomingStarts.empty')}</EmptyText>
              ) : (
                <ul className="space-y-2">
                  {data.lifecycle.upcomingStarts.map((e) => (
                    <li key={e.id} className="flex items-center justify-between gap-2 text-sm">
                      <Link
                        to="/weldhr/employees/$employeeId"
                        params={{ employeeId: e.id }}
                        className="flex min-w-0 items-center gap-2 hover:underline"
                      >
                        <EmployeeAvatar name={e.displayName} />
                        <span className="truncate">
                          {e.displayName}
                          {e.jobTitle && <span className="text-muted-foreground"> · {e.jobTitle}</span>}
                        </span>
                      </Link>
                      <span className="shrink-0 text-xs text-muted-foreground">{formatDate(e.startDate)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </SectionCard>

            <SectionCard
              title={t('weldhr.dashboard.onLeave.title')}
              action={
                <Link to="/weldhr/leave">
                  <Button variant="ghost" size="sm">
                    {t('weldhr.dashboard.links.leave')}
                  </Button>
                </Link>
              }
            >
              {data.today.onLeave.length === 0 ? (
                <EmptyText>{t('weldhr.dashboard.onLeave.empty')}</EmptyText>
              ) : (
                <ul className="space-y-2">
                  {data.today.onLeave.map((l) => (
                    <li key={l.employeeId} className="flex items-center justify-between gap-2 text-sm">
                      <Link
                        to="/weldhr/employees/$employeeId"
                        params={{ employeeId: l.employeeId }}
                        className="truncate hover:underline"
                      >
                        {l.employeeName}
                      </Link>
                      <span className="shrink-0 text-xs text-muted-foreground">
                        {l.leaveTypeName ? `${l.leaveTypeName} · ` : ''}
                        {t('weldhr.dashboard.onLeave.until', { date: formatDate(l.endDate) })}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </SectionCard>

            <SectionCard
              title={t('weldhr.dashboard.recentEvaluations.title')}
              action={
                <Link to="/weldhr/evaluations">
                  <Button variant="ghost" size="sm">
                    {t('weldhr.dashboard.links.evaluations')}
                  </Button>
                </Link>
              }
            >
              {data.evaluations.recent.length === 0 ? (
                <EmptyText>{t('weldhr.dashboard.recentEvaluations.empty')}</EmptyText>
              ) : (
                <ul className="space-y-2">
                  {data.evaluations.recent.map((ev) => (
                    <li key={ev.id} className="flex items-center justify-between gap-2 text-sm">
                      <Link
                        to="/weldhr/employees/$employeeId"
                        params={{ employeeId: ev.employeeId }}
                        className="truncate hover:underline"
                      >
                        {ev.employeeName}
                      </Link>
                      <div className="flex shrink-0 items-center gap-2">
                        <StatusBadge group="evaluation" status={ev.status} />
                        <ScoreBadge score={ev.overallScore} />
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </SectionCard>

            <SectionCard
              title={t('weldhr.dashboard.clients.title')}
              action={
                <Link to="/weldhr/clients">
                  <Button variant="ghost" size="sm">
                    {t('weldhr.dashboard.clients.viewAll')}
                  </Button>
                </Link>
              }
            >
              {data.clients.length === 0 ? (
                <EmptyText>{t('weldhr.dashboard.clients.empty')}</EmptyText>
              ) : (
                <ul className="space-y-2">
                  {data.clients.slice(0, 8).map((c) => (
                    <li key={c.companyId} className="flex items-center justify-between gap-2 text-sm">
                      <Link
                        to="/weldhr/clients/$companyId"
                        params={{ companyId: c.companyId }}
                        className="truncate hover:underline"
                      >
                        {c.companyName ?? c.companyId}
                      </Link>
                      <span className="shrink-0 text-xs text-muted-foreground">
                        {t('weldhr.dashboard.clients.headcount', { count: c.activeCount })} ·{' '}
                        {t('weldhr.dashboard.clients.fte', { fte: c.fte.toFixed(1) })}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </SectionCard>
          </div>
        </>
      )}
    </DashboardPage>
  );
}
