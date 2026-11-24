import { useState } from 'react';
import { useTranslations } from '@weldsuite/i18n/client';
import { useObjectPanelUrlSync } from '@/components/object-panel';
import { MY_HR_PATHS } from '../../access';
import { HrTabsPage } from '../../components/page-kit';
import { useMyHrBreadcrumbs } from '../components/my-hr-page';
import { MyOpenShiftsList } from '../components/open-shifts-card';
import { MyScheduleCalendar } from '../components/schedule-calendar-tab';
import { MyHoursList } from '../components/schedule-hours-tab';
import { type MyPeriod } from '../components/schedule-period';
import { MyShiftsList } from '../components/schedule-shifts-tab';
import { ShiftsViewToggle, type ShiftsView } from '../components/shifts-view-toggle';

type Tab = 'shifts' | 'openShifts' | 'hours';

/**
 * My HR → Schedule: your shifts (as a list, or as a calendar with your
 * hours and time off), open shifts to sign up for, and your clocked hours, a tab each.
 */
export default function MySchedulePage() {
  const t = useTranslations();
  const [tab, setTab] = useState<Tab>('shifts');
  // One period for Shifts and Hours, so switching tabs keeps it.
  const [period, setPeriod] = useState<MyPeriod>('around');
  // List or calendar, kept while switching tabs.
  const [shiftsView, setShiftsView] = useState<ShiftsView>('list');
  useMyHrBreadcrumbs(t('weldhr.me.pages.schedule'));
  // A row opens its details panel; the URL keeps it (`?stack=`), so a link or reload reopens it.
  useObjectPanelUrlSync(MY_HR_PATHS.schedule);

  const tabs = [
    { id: 'shifts', label: t('weldhr.me.schedule.tabs.shifts') },
    { id: 'openShifts', label: t('weldhr.me.schedule.tabs.openShifts') },
    { id: 'hours', label: t('weldhr.me.schedule.tabs.hours') },
  ];

  const viewToggle = <ShiftsViewToggle value={shiftsView} onChange={setShiftsView} />;

  return (
    <HrTabsPage tabs={tabs} activeTab={tab} onTabChange={(next) => setTab(next as Tab)}>
      {tab === 'shifts' &&
        (shiftsView === 'list' ? (
          <MyShiftsList period={period} onPeriodChange={setPeriod} viewToggle={viewToggle} />
        ) : (
          <MyScheduleCalendar viewToggle={viewToggle} />
        ))}
      {tab === 'openShifts' && <MyOpenShiftsList />}
      {tab === 'hours' && <MyHoursList period={period} onPeriodChange={setPeriod} />}
    </HrTabsPage>
  );
}
