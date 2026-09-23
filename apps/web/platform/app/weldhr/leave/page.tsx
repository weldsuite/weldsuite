/** WeldHR — Leave: requests, the shared calendar, and balances. */

import { useNavigate, useSearch } from '@tanstack/react-router';
import { useTranslations } from '@weldsuite/i18n/client';
import { PageBody, PageHeader } from '../components/shared';
import { BalancesTab } from './components/balances-tab';
import { CalendarTab } from './components/calendar-tab';
import { RequestsTab } from './components/requests-tab';

type Tab = 'requests' | 'calendar' | 'balances';

export default function WeldHrLeavePage() {
  const t = useTranslations();
  const navigate = useNavigate();
  const search = useSearch({ from: '/weldhr/leave/' }) as { tab?: string };
  const tab: Tab = search.tab === 'calendar' || search.tab === 'balances' ? search.tab : 'requests';

  function setTab(next: Tab) {
    void navigate({ to: '/weldhr/leave', search: { tab: next }, replace: true });
  }

  const tabs: Array<{ id: Tab; label: string }> = [
    { id: 'requests', label: t('weldhr.leave.tabs.requests') },
    { id: 'calendar', label: t('weldhr.leave.tabs.calendar') },
    { id: 'balances', label: t('weldhr.leave.tabs.balances') },
  ];

  return (
    <PageBody wide>
      <PageHeader title={t('weldhr.leave.title')} subtitle={t('weldhr.leave.subtitle')} />

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

      {tab === 'requests' && <RequestsTab />}
      {tab === 'calendar' && <CalendarTab />}
      {tab === 'balances' && <BalancesTab />}
    </PageBody>
  );
}
