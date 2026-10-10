import { useTranslations } from '@weldsuite/i18n/client';
import { DetailHeader, DetailPage } from '../components/page-kit';
import { EmployeeAvatar, StatusBadge } from '../components/shared';
import { useMyHrSelf } from './components/my-hr-context';
import { useMyHrBreadcrumbs } from './components/my-hr-page';
import { MyOverviewTab } from './components/overview-tab';

/** My HR → Overview: who you are in WeldHR (name, job, manager), the time clock and what needs your attention. */
export default function WeldHrMePage() {
  const t = useTranslations();
  useMyHrBreadcrumbs();
  const { employee, features } = useMyHrSelf();

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

      <MyOverviewTab employee={employee} canClockIn={features.selfClockIn} />
    </DetailPage>
  );
}
