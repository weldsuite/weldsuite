/**
 * WeldHR — Absenteeism: everyone's sick reports, ongoing and completed, for
 * HR (`absences:read`), who can also file or correct one on someone's behalf.
 * Employees report themselves sick under My HR → Time off.
 */

import { useNavigate, useSearch } from '@tanstack/react-router';
import { useTranslations } from '@weldsuite/i18n/client';
import { usePermissions } from '@weldsuite/permissions/react';
import { PageLoader } from '@/components/page-loader';
import { DetailPage, HrTabsPage, useHrBreadcrumbs } from '../components/page-kit';
import { ErrorBanner } from '../components/shared';
import { AbsencesTab } from './components/absences-tab';

type Tab = 'ongoing' | 'completed';

export default function WeldHrAbsenteeismPage() {
  const t = useTranslations();
  const navigate = useNavigate();
  useHrBreadcrumbs({ label: t('weldhr.absenteeism.title') });

  const { can, isLoading: permissionsLoading } = usePermissions();
  const search = useSearch({ from: '/weldhr/absenteeism/' });

  if (permissionsLoading) return <PageLoader fullScreen={false} />;

  if (!can('absences:read')) {
    return (
      <DetailPage>
        <ErrorBanner error={t('weldhr.common.noPermission')} />
      </DetailPage>
    );
  }

  const tabs: Array<{ id: Tab; label: string }> = [
    { id: 'ongoing', label: t('weldhr.absenteeism.tabs.ongoing') },
    { id: 'completed', label: t('weldhr.absenteeism.tabs.completed') },
  ];
  const tab: Tab = search.tab === 'completed' ? 'completed' : 'ongoing';

  function setTab(next: string) {
    void navigate({ to: '/weldhr/absenteeism', search: { tab: next === 'ongoing' ? undefined : next }, replace: true });
  }

  return (
    <HrTabsPage tabs={tabs} activeTab={tab} onTabChange={setTab}>
      {tab === 'ongoing' && <AbsencesTab key="ongoing" status="ongoing" />}
      {tab === 'completed' && <AbsencesTab key="completed" status="completed" />}
    </HrTabsPage>
  );
}
