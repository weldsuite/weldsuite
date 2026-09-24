/** WeldHR — Leave: requests, the shared calendar, and balances. */

import { useNavigate, useSearch } from '@tanstack/react-router';
import { useTranslations } from '@weldsuite/i18n/client';
import { HrTabsPage, TabBody, useHrBreadcrumbs } from '../components/page-kit';
import { BalancesTab } from './components/balances-tab';
import { CalendarTab } from './components/calendar-tab';
import { RequestsTab } from './components/requests-tab';

type Tab = 'requests' | 'calendar' | 'balances';

export default function WeldHrLeavePage() {
  const t = useTranslations();
  const navigate = useNavigate();
  useHrBreadcrumbs({ label: t('weldhr.leave.title') });

  const search = useSearch({ from: '/weldhr/leave/' }) as { tab?: string };
  const tab: Tab = search.tab === 'calendar' || search.tab === 'balances' ? search.tab : 'requests';

  function setTab(next: string) {
    void navigate({ to: '/weldhr/leave', search: { tab: next === 'requests' ? undefined : next }, replace: true });
  }

  const tabs = [
    { id: 'requests', label: t('weldhr.leave.tabs.requests') },
    { id: 'calendar', label: t('weldhr.leave.tabs.calendar') },
    { id: 'balances', label: t('weldhr.leave.tabs.balances') },
  ];

  return (
    <HrTabsPage tabs={tabs} activeTab={tab} onTabChange={setTab}>
      {tab === 'requests' && <RequestsTab />}
      {tab === 'calendar' && (
        <TabBody>
          <CalendarTab />
        </TabBody>
      )}
      {tab === 'balances' && (
        <TabBody>
          <BalancesTab />
        </TabBody>
      )}
    </HrTabsPage>
  );
}
