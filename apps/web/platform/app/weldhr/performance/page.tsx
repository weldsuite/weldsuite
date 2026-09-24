/** WeldHR — KPIs & milestones, tabbed via `?tab=`. */

import { useNavigate, useSearch } from '@tanstack/react-router';
import { Gauge, Target, Upload } from 'lucide-react';
import { useTranslations } from '@weldsuite/i18n/client';
import { HrTabsPage, TabBody, useHrBreadcrumbs } from '../components/page-kit';
import { ImportTab } from './components/import-tab';
import { KpisTab } from './components/kpis-tab';
import { MilestonesTab } from './components/milestones-tab';

const TABS = ['kpis', 'import', 'milestones'] as const;
type TabKey = (typeof TABS)[number];

export default function WeldHrPerformancePage() {
  const t = useTranslations();
  useHrBreadcrumbs({ label: t('weldhr.performance.title') });
  const navigate = useNavigate();
  const search = useSearch({ strict: false }) as { tab?: string };
  const active: TabKey = TABS.includes(search.tab as TabKey) ? (search.tab as TabKey) : 'kpis';

  function setTab(tab: string) {
    void navigate({ to: '/weldhr/performance', search: { tab }, replace: true });
  }

  return (
    <HrTabsPage
      tabs={[
        { id: 'kpis', label: t('weldhr.performance.tabs.kpis'), icon: Gauge },
        { id: 'import', label: t('weldhr.performance.tabs.import'), icon: Upload },
        { id: 'milestones', label: t('weldhr.performance.tabs.milestones'), icon: Target },
      ]}
      activeTab={active}
      onTabChange={setTab}
    >
      {active === 'kpis' && <KpisTab />}
      {active === 'import' && (
        <TabBody>
          <ImportTab />
        </TabBody>
      )}
      {active === 'milestones' && <MilestonesTab />}
    </HrTabsPage>
  );
}
