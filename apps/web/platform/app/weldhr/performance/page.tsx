/** WeldHR — KPIs & milestones, tabbed via `?tab=`. */

import { useNavigate, useSearch } from '@tanstack/react-router';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@weldsuite/ui/components/tabs';
import { useTranslations } from '@weldsuite/i18n/client';
import { PageBody, PageHeader } from '../components/shared';
import { ImportTab } from './components/import-tab';
import { KpisTab } from './components/kpis-tab';
import { MilestonesTab } from './components/milestones-tab';

const TABS = ['kpis', 'import', 'milestones'] as const;
type TabKey = (typeof TABS)[number];

export default function WeldHrPerformancePage() {
  const t = useTranslations();
  const navigate = useNavigate();
  const search = useSearch({ strict: false }) as { tab?: string };
  const active: TabKey = TABS.includes(search.tab as TabKey) ? (search.tab as TabKey) : 'kpis';

  function setTab(tab: string) {
    void navigate({ to: '/weldhr/performance', search: { tab }, replace: true });
  }

  return (
    <PageBody wide>
      <PageHeader title={t('weldhr.performance.title')} subtitle={t('weldhr.performance.subtitle')} />

      <Tabs value={active} onValueChange={setTab}>
        <TabsList>
          <TabsTrigger value="kpis">{t('weldhr.performance.tabs.kpis')}</TabsTrigger>
          <TabsTrigger value="import">{t('weldhr.performance.tabs.import')}</TabsTrigger>
          <TabsTrigger value="milestones">{t('weldhr.performance.tabs.milestones')}</TabsTrigger>
        </TabsList>
        <TabsContent value="kpis">
          <KpisTab />
        </TabsContent>
        <TabsContent value="import">
          <ImportTab />
        </TabsContent>
        <TabsContent value="milestones">
          <MilestonesTab />
        </TabsContent>
      </Tabs>
    </PageBody>
  );
}
