/**
 * My HR: the signed-in member's own WeldHR employee record. Overview, leave,
 * attendance, onboarding tasks, coaching and evaluations, and goals. Every
 * endpoint resolves the employee from the session, so this page never takes an
 * employee id. Members who are not linked to an employee (or whose record is
 * terminated) get a "not set up yet" state instead of tabs.
 */

import { useNavigate, useSearch } from '@tanstack/react-router';
import { UserRoundSearch } from 'lucide-react';
import { useTranslations } from '@weldsuite/i18n/client';
import { usePermissions } from '@weldsuite/permissions/react';
import type { HrSelf } from '@weldsuite/app-api-client/domains/weldhr';
import { PageLoader } from '@/components/page-loader';
import { useMyHr, useMyHrOverview } from '@/hooks/queries/use-weldhr-queries';
import { DetailHeader, DetailPage, DetailTabs, emptyIcon, useHrBreadcrumbs } from '../components/page-kit';
import { EmployeeAvatar, ErrorBanner, StatusBadge, errorMessage } from '../components/shared';
import { MyAttendanceTab } from './components/attendance-tab';
import { MyGoalsTab } from './components/goals-tab';
import { MyLeaveTab } from './components/leave-tab';
import { MyOverviewTab } from './components/overview-tab';
import { MyReviewsTab } from './components/reviews-tab';
import { isMeTabId, type MeTabId } from './components/shared';
import { MyTasksTab } from './components/tasks-tab';

export default function WeldHrMePage() {
  const t = useTranslations();
  useHrBreadcrumbs({ label: t('weldhr.me.title') });
  const { can, isLoading: permissionsLoading } = usePermissions();
  const allowed = can('employees:self');
  const { data: self, isLoading, error } = useMyHr({ enabled: allowed });

  if (permissionsLoading || isLoading) return <PageLoader fullScreen={false} />;

  if (!allowed) {
    return (
      <DetailPage>
        <ErrorBanner error={t('weldhr.common.noPermission')} />
      </DetailPage>
    );
  }

  if (!self) {
    return (
      <DetailPage>
        <ErrorBanner error={errorMessage(error, t('weldhr.me.loadFailed'))} />
      </DetailPage>
    );
  }

  if (!self.employee) return <NotSetUp />;

  return <MyHrContent employee={self.employee} features={self.features} />;
}

/** The member has My HR access but no (active) employee record to show. */
function NotSetUp() {
  const t = useTranslations();
  return (
    <DetailPage>
      <div className="flex flex-col items-center justify-center px-4 py-16 text-center">
        {emptyIcon(UserRoundSearch)}
        <h2 className="mb-1.5 text-[15px] font-semibold">{t('weldhr.me.notSetUp.title')}</h2>
        <p className="max-w-md text-sm leading-relaxed text-muted-foreground">{t('weldhr.me.notSetUp.description')}</p>
      </div>
    </DetailPage>
  );
}

function MyHrContent({
  employee,
  features,
}: Readonly<{
  employee: NonNullable<HrSelf['employee']>;
  features: HrSelf['features'];
}>) {
  const t = useTranslations();
  const search = useSearch({ from: '/weldhr/me/' });
  const navigate = useNavigate();
  // Same query the Overview tab runs; here it only feeds the tab counters.
  const { data: overview } = useMyHrOverview();

  const activeTab: MeTabId = isMeTabId(search.tab) ? search.tab : 'overview';

  function setTab(tab: MeTabId) {
    void navigate({ to: '/weldhr/me', search: { tab }, replace: true });
  }

  const toAcknowledge = overview ? overview.toAcknowledge.coaching + overview.toAcknowledge.evaluations : 0;
  const tabs = [
    { id: 'overview', label: t('weldhr.me.tabs.overview') },
    { id: 'leave', label: t('weldhr.me.tabs.leave') },
    { id: 'attendance', label: t('weldhr.me.tabs.attendance') },
    { id: 'tasks', label: t('weldhr.me.tabs.tasks'), count: overview?.openTasks },
    { id: 'reviews', label: t('weldhr.me.tabs.reviews'), count: toAcknowledge },
    { id: 'goals', label: t('weldhr.me.tabs.goals') },
  ] satisfies Array<{ id: MeTabId; label: string; count?: number }>;

  return (
    <DetailPage>
      <DetailHeader
        leading={<EmployeeAvatar name={employee.displayName} src={employee.avatarUrl} className="h-12 w-12" />}
        title={employee.displayName}
        badges={<StatusBadge group="employee" status={employee.status} />}
        subtitle={
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span>
              {employee.jobTitle ?? t('weldhr.me.header.noJobTitle')}
              {employee.departmentName && ` · ${employee.departmentName}`}
            </span>
            {employee.manager && (
              <>
                <span className="text-muted-foreground">·</span>
                <span>{t('weldhr.me.header.manager', { name: employee.manager.displayName })}</span>
              </>
            )}
          </div>
        }
      />

      <DetailTabs tabs={tabs} activeTab={activeTab} onTabChange={(tab) => isMeTabId(tab) && setTab(tab)} />

      {activeTab === 'overview' && (
        <MyOverviewTab employee={employee} canClockIn={features.selfClockIn} onNavigate={setTab} />
      )}
      {activeTab === 'leave' && <MyLeaveTab canRequest={features.leaveRequests} />}
      {activeTab === 'attendance' && <MyAttendanceTab />}
      {activeTab === 'tasks' && <MyTasksTab />}
      {activeTab === 'reviews' && <MyReviewsTab />}
      {activeTab === 'goals' && <MyGoalsTab />}
    </DetailPage>
  );
}
