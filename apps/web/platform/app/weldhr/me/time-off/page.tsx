import { useState } from 'react';
import { useTranslations } from '@weldsuite/i18n/client';
import { useObjectPanelUrlSync } from '@/components/object-panel';
import { MY_HR_PATHS } from '../../access';
import { HrTabsPage } from '../../components/page-kit';
import { MyLeaveBalancesList } from '../components/leave-balances';
import { MyLeaveList } from '../components/leave-tab';
import { useMyHrSelf } from '../components/my-hr-context';
import { useMyHrBreadcrumbs } from '../components/my-hr-page';
import { MySickReportsList } from '../components/sick-reports';

type Tab = 'leave' | 'balances' | 'sick';

/**
 * My HR → Time off: everything about not working, in the standard lists the
 * back office uses: leave requests, leave balances and sick reports, a tab each.
 */
export default function MyTimeOffPage() {
  const t = useTranslations();
  const { features } = useMyHrSelf();
  const [tab, setTab] = useState<Tab>('leave');
  useMyHrBreadcrumbs(t('weldhr.me.pages.timeOff'));
  // A row opens its details panel; the URL keeps it (`?stack=`), so a link or reload reopens it.
  useObjectPanelUrlSync(MY_HR_PATHS.timeOff);

  const tabs = [
    { id: 'leave', label: t('weldhr.me.timeOff.tabs.leave') },
    { id: 'balances', label: t('weldhr.me.timeOff.tabs.balances') },
    { id: 'sick', label: t('weldhr.me.timeOff.tabs.sick') },
  ];

  return (
    <HrTabsPage tabs={tabs} activeTab={tab} onTabChange={(next) => setTab(next as Tab)}>
      {tab === 'leave' && <MyLeaveList canRequest={features.leaveRequests} />}
      {tab === 'balances' && <MyLeaveBalancesList />}
      {tab === 'sick' && <MySickReportsList />}
    </HrTabsPage>
  );
}
