/** WeldHR — Attendance: records, the shift calendar, shift requests, and CSV import. */

import { useNavigate, useSearch } from '@tanstack/react-router';
import { useTranslations } from '@weldsuite/i18n/client';
import { useHrShiftRequests } from '@/hooks/queries/use-weldhr-queries';
import { HrTabsPage, TabBody, useHrBreadcrumbs } from '../components/page-kit';
import { ImportTab } from './components/import-tab';
import { RecordsTab } from './components/records-tab';
import { RequestsTab } from './components/requests-tab';
import { ScheduleTab } from './components/schedule-tab';

type Tab = 'records' | 'schedule' | 'requests' | 'import';

export default function WeldHrAttendancePage() {
  const t = useTranslations();
  const navigate = useNavigate();
  useHrBreadcrumbs({ label: t('weldhr.attendance.title') });

  const search = useSearch({ from: '/weldhr/attendance/' }) as { tab?: string };
  const tab: Tab =
    search.tab === 'schedule' || search.tab === 'requests' || search.tab === 'import' ? search.tab : 'records';

  // The Requests tab shares this query, so the count and the list never disagree.
  const { data: pendingRequests } = useHrShiftRequests({ status: 'pending' });

  function setTab(next: string) {
    void navigate({ to: '/weldhr/attendance', search: { tab: next === 'records' ? undefined : next }, replace: true });
  }

  const tabs = [
    { id: 'records', label: t('weldhr.attendance.tabs.records') },
    { id: 'schedule', label: t('weldhr.attendance.tabs.schedule') },
    { id: 'requests', label: t('weldhr.attendance.tabs.requests'), count: pendingRequests?.length },
    { id: 'import', label: t('weldhr.attendance.tabs.import') },
  ];

  return (
    <HrTabsPage tabs={tabs} activeTab={tab} onTabChange={setTab}>
      {tab === 'records' && <RecordsTab />}
      {tab === 'schedule' && <ScheduleTab />}
      {tab === 'requests' && <RequestsTab />}
      {tab === 'import' && (
        <TabBody>
          <ImportTab />
        </TabBody>
      )}
    </HrTabsPage>
  );
}
