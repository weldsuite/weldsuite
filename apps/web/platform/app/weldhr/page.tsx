/**
 * WeldHR dashboard: headcount, today's attendance/leave, upcoming starts.
 * Members who can only use My HR (`employees:self`, no HR read permission) are sent to /weldhr/me instead.
 */

import { useEffect } from 'react';
import { Link, useNavigate } from '@tanstack/react-router';
import { CalendarClock, Clock, Palmtree, Users } from 'lucide-react';
import { useTranslations } from '@weldsuite/i18n/client';
import { usePermissions } from '@weldsuite/permissions/react';
import { Button } from '@weldsuite/ui/components/button';
import { PageLoader } from '@/components/page-loader';
import { useHrDashboard } from '@/hooks/queries/use-weldhr-queries';
import { HR_DASHBOARD_PERMISSIONS, MY_HR_PATHS } from './access';
import { DashboardPage, KpiCard, KpiGrid, SectionCard, EmptyText, useHrBreadcrumbs } from './components/page-kit';
import { EmployeeAvatar, ErrorBanner, errorMessage, formatDate } from './components/shared';

/** The dashboard for HR; a member who only has My HR is sent there instead. */
export default function WeldHrDashboardPage() {
  const { canAny, can, isLoading } = usePermissions();
  const navigate = useNavigate();
  const selfServiceOnly = !isLoading && !canAny(...HR_DASHBOARD_PERMISSIONS) && can('employees:self');

  useEffect(() => {
    if (selfServiceOnly) void navigate({ to: MY_HR_PATHS.overview, replace: true });
  }, [selfServiceOnly, navigate]);

  // Permissions are still loading, or the redirect above is in flight: do not fire the dashboard query.
  if (isLoading || selfServiceOnly) return <PageLoader fullScreen={false} />;

  return <DashboardContent />;
}

function DashboardContent() {
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
          </KpiGrid>

          <div className="grid gap-4 lg:grid-cols-2">
            <SectionCard title={t('weldhr.dashboard.upcomingStarts.title')}>
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
          </div>
        </>
      )}
    </DashboardPage>
  );
}
