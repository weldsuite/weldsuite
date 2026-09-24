/** WeldHR — Attendance: records, the weekly schedule, and CSV import. */

import { useNavigate, useSearch } from '@tanstack/react-router';
import { useTranslations } from '@weldsuite/i18n/client';
import { HrTabsPage, TabBody, useHrBreadcrumbs } from '../components/page-kit';
import { ImportTab } from './components/import-tab';
import { RecordsTab } from './components/records-tab';
import { ScheduleTab } from './components/schedule-tab';

type Tab = 'records' | 'schedule' | 'import';

export default function WeldHrAttendancePage() {
  const t = useTranslations();
  const navigate = useNavigate();
  useHrBreadcrumbs({ label: t('weldhr.attendance.title') });

  const search = useSearch({ from: '/weldhr/attendance/' }) as { tab?: string };
  const tab: Tab = search.tab === 'schedule' || search.tab === 'import' ? search.tab : 'records';

  function setTab(next: string) {
    void navigate({ to: '/weldhr/attendance', search: { tab: next === 'records' ? undefined : next }, replace: true });
  }

  const tabs = [
    { id: 'records', label: t('weldhr.attendance.tabs.records') },
    { id: 'schedule', label: t('weldhr.attendance.tabs.schedule') },
    { id: 'import', label: t('weldhr.attendance.tabs.import') },
  ];

  return (
    <HrTabsPage tabs={tabs} activeTab={tab} onTabChange={setTab}>
      {tab === 'records' && <RecordsTab />}
      {tab === 'schedule' && (
        <TabBody>
          <ScheduleTab />
        </TabBody>
      )}
      {tab === 'import' && (
        <TabBody>
          <ImportTab />
        </TabBody>
      )}
    </HrTabsPage>
  );
}
