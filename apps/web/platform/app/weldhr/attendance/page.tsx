/** WeldHR — Attendance: records, the weekly schedule, and CSV import. */

import { useNavigate, useSearch } from '@tanstack/react-router';
import { useTranslations } from '@weldsuite/i18n/client';
import { PageBody, PageHeader } from '../components/shared';
import { ImportTab } from './components/import-tab';
import { RecordsTab } from './components/records-tab';
import { ScheduleTab } from './components/schedule-tab';

type Tab = 'records' | 'schedule' | 'import';

export default function WeldHrAttendancePage() {
  const t = useTranslations();
  const navigate = useNavigate();
  const search = useSearch({ from: '/weldhr/attendance/' }) as { tab?: string };
  const tab: Tab = search.tab === 'schedule' || search.tab === 'import' ? search.tab : 'records';

  function setTab(next: Tab) {
    void navigate({ to: '/weldhr/attendance', search: { tab: next }, replace: true });
  }

  const tabs: Array<{ id: Tab; label: string }> = [
    { id: 'records', label: t('weldhr.attendance.tabs.records') },
    { id: 'schedule', label: t('weldhr.attendance.tabs.schedule') },
    { id: 'import', label: t('weldhr.attendance.tabs.import') },
  ];

  return (
    <PageBody wide>
      <PageHeader title={t('weldhr.attendance.title')} subtitle={t('weldhr.attendance.subtitle')} />

      <div className="flex gap-1 border-b">
        {tabs.map((item) => (
          <button
            key={item.id}
            onClick={() => setTab(item.id)}
            className={`border-b-2 px-3 py-2 text-sm font-medium transition-colors ${
              tab === item.id
                ? 'border-primary text-foreground'
                : 'border-transparent text-muted-foreground hover:text-foreground'
            }`}
          >
            {item.label}
          </button>
        ))}
      </div>

      {tab === 'records' && <RecordsTab />}
      {tab === 'schedule' && <ScheduleTab />}
      {tab === 'import' && <ImportTab />}
    </PageBody>
  );
}
