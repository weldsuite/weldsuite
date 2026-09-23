/** WeldHR dashboard: headcount, today's attendance/leave, lifecycle, coaching follow-ups, recent evaluations, client accounts. */

import { Link } from '@tanstack/react-router';
import { useTranslations } from '@weldsuite/i18n/client';
import { Button } from '@weldsuite/ui/components/button';
import { Card } from '@weldsuite/ui/components/card';
import { useHrDashboard } from '@/hooks/queries/use-weldhr-queries';
import {
  EmployeeAvatar,
  ErrorBanner,
  InlineSpinner,
  PageBody,
  PageHeader,
  ScoreBadge,
  StatTile,
  StatusBadge,
  errorMessage,
  formatDate,
} from './components/shared';

export default function WeldHrDashboardPage() {
  const t = useTranslations();
  const { data, isLoading, error } = useHrDashboard();

  return (
    <PageBody wide>
      <PageHeader title={t('weldhr.title')} subtitle={t('weldhr.dashboard.subtitle')} />
      <ErrorBanner error={error ? errorMessage(error, t('weldhr.dashboard.loadFailed')) : null} />

      {isLoading ? (
        <InlineSpinner />
      ) : !data ? null : (
        <>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
            <StatTile label={t('weldhr.dashboard.headcount')} value={data.headcount.total} />
            <StatTile label={t('weldhr.dashboard.clockedInToday')} value={data.today.clockedIn} />
            <StatTile label={t('weldhr.dashboard.onLeaveToday')} value={data.today.onLeave.length} />
            <StatTile
              label={t('weldhr.dashboard.pendingLeaveRequests')}
              value={data.pendingLeaveRequests}
              tone={data.pendingLeaveRequests > 0 ? 'warning' : 'default'}
            />
            <StatTile
              label={t('weldhr.dashboard.openOnboardingTasks')}
              value={data.lifecycle.openTasks}
              hint={
                data.lifecycle.overdueTasks > 0
                  ? t('weldhr.dashboard.overdueOnboardingTasks', { count: data.lifecycle.overdueTasks })
                  : undefined
              }
              tone={data.lifecycle.overdueTasks > 0 ? 'danger' : 'default'}
            />
            <StatTile
              label={t('weldhr.dashboard.coachingFollowUpsDue')}
              value={data.coachingFollowUpsDue}
              tone={data.coachingFollowUpsDue > 0 ? 'warning' : 'default'}
            />
            <StatTile
              label={t('weldhr.dashboard.avgEvaluationScore')}
              value={data.evaluations.averageScore90d !== null ? data.evaluations.averageScore90d.toFixed(1) : '—'}
            />
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <Card className="p-4">
              <div className="flex items-center justify-between">
                <h2 className="text-sm font-semibold">{t('weldhr.dashboard.upcomingStarts.title')}</h2>
                <Link to="/weldhr/lifecycle">
                  <Button variant="ghost" size="sm">
                    {t('weldhr.dashboard.links.lifecycle')}
                  </Button>
                </Link>
              </div>
              {data.lifecycle.upcomingStarts.length === 0 ? (
                <p className="mt-3 text-sm text-muted-foreground">{t('weldhr.dashboard.upcomingStarts.empty')}</p>
              ) : (
                <ul className="mt-3 space-y-2">
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
            </Card>

            <Card className="p-4">
              <div className="flex items-center justify-between">
                <h2 className="text-sm font-semibold">{t('weldhr.dashboard.onLeave.title')}</h2>
                <Link to="/weldhr/leave">
                  <Button variant="ghost" size="sm">
                    {t('weldhr.dashboard.links.leave')}
                  </Button>
                </Link>
              </div>
              {data.today.onLeave.length === 0 ? (
                <p className="mt-3 text-sm text-muted-foreground">{t('weldhr.dashboard.onLeave.empty')}</p>
              ) : (
                <ul className="mt-3 space-y-2">
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
            </Card>

            <Card className="p-4">
              <div className="flex items-center justify-between">
                <h2 className="text-sm font-semibold">{t('weldhr.dashboard.recentEvaluations.title')}</h2>
                <Link to="/weldhr/evaluations">
                  <Button variant="ghost" size="sm">
                    {t('weldhr.dashboard.links.evaluations')}
                  </Button>
                </Link>
              </div>
              {data.evaluations.recent.length === 0 ? (
                <p className="mt-3 text-sm text-muted-foreground">{t('weldhr.dashboard.recentEvaluations.empty')}</p>
              ) : (
                <ul className="mt-3 space-y-2">
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
            </Card>

            <Card className="p-4">
              <div className="flex items-center justify-between">
                <h2 className="text-sm font-semibold">{t('weldhr.dashboard.clients.title')}</h2>
                <Link to="/weldhr/clients">
                  <Button variant="ghost" size="sm">
                    {t('weldhr.dashboard.clients.viewAll')}
                  </Button>
                </Link>
              </div>
              {data.clients.length === 0 ? (
                <p className="mt-3 text-sm text-muted-foreground">{t('weldhr.dashboard.clients.empty')}</p>
              ) : (
                <ul className="mt-3 space-y-2">
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
            </Card>
          </div>
        </>
      )}
    </PageBody>
  );
}
