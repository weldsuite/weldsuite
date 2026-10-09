/**
 * WeldHR — Absenteeism: sick reports. Employees report themselves sick and
 * recovered under "My absence"; with `absences:read`, HR also gets everyone's
 * ongoing and completed reports and can file or correct one on someone's behalf.
 */

import { useNavigate, useSearch } from '@tanstack/react-router';
import { useTranslations } from '@weldsuite/i18n/client';
import { usePermissions } from '@weldsuite/permissions/react';
import { PageLoader } from '@/components/page-loader';
import { useMyHr } from '@/hooks/queries/use-weldhr-queries';
import { DetailPage, HrTabsPage, TabBody, useHrBreadcrumbs } from '../components/page-kit';
import { ErrorBanner } from '../components/shared';
import { AbsencesTab } from './components/absences-tab';
import { MyAbsenceTab } from './components/my-absence-tab';

type Tab = 'mine' | 'ongoing' | 'completed';

export default function WeldHrAbsenteeismPage() {
  const t = useTranslations();
  const navigate = useNavigate();
  useHrBreadcrumbs({ label: t('weldhr.absenteeism.title') });

  const { can, isLoading: permissionsLoading } = usePermissions();
  const canSelf = can('employees:self');
  const canRead = can('absences:read');
  const { data: self, isLoading: selfLoading } = useMyHr({ enabled: canSelf });
  const search = useSearch({ from: '/weldhr/absenteeism/' }) as { tab?: string };

  if (permissionsLoading || (canSelf && selfLoading)) return <PageLoader fullScreen={false} />;

  if (!canSelf && !canRead) {
    return (
      <DetailPage>
        <ErrorBanner error={t('weldhr.common.noPermission')} />
      </DetailPage>
    );
  }

  const hasEmployee = Boolean(self?.employee);
  // HR without an employee record of their own has nothing under "My absence".
  const showMine = canSelf && (hasEmployee || !canRead);
  const tabs: Array<{ id: Tab; label: string }> = [
    ...(showMine ? [{ id: 'mine' as const, label: t('weldhr.absenteeism.tabs.mine') }] : []),
    ...(canRead
      ? [
          { id: 'ongoing' as const, label: t('weldhr.absenteeism.tabs.ongoing') },
          { id: 'completed' as const, label: t('weldhr.absenteeism.tabs.completed') },
        ]
      : []),
  ];
  const defaultTab = tabs[0]!.id;
  const tab = tabs.find((candidate) => candidate.id === search.tab)?.id ?? defaultTab;

  function setTab(next: string) {
    void navigate({ to: '/weldhr/absenteeism', search: { tab: next === defaultTab ? undefined : next }, replace: true });
  }

  const mine = hasEmployee ? <MyAbsenceTab /> : <ErrorBanner error={t('weldhr.absenteeism.mine.notSetUp')} />;

  // An employee without HR access only has their own reports: no tab strip needed.
  if (!canRead) return <DetailPage>{mine}</DetailPage>;

  return (
    <HrTabsPage tabs={tabs} activeTab={tab} onTabChange={setTab}>
      {tab === 'mine' && <TabBody>{mine}</TabBody>}
      {tab === 'ongoing' && <AbsencesTab key="ongoing" status="ongoing" />}
      {tab === 'completed' && <AbsencesTab key="completed" status="completed" />}
    </HrTabsPage>
  );
}
