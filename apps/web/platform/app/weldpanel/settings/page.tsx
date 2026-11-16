/**
 * WeldPanel settings for the whole workspace, at `/weldpanel/settings`. The
 * `tab` search param picks the tab; `usage` is the only one for now (the usage
 * emails and the banner link to `?tab=usage`). Needs `panel_projects:manage`.
 */

import { useSearch } from '@tanstack/react-router';
import { useCan } from '@weldsuite/permissions/react';
import { EmptyState } from '@weldsuite/ui/components/empty-state';
import { DashboardPage } from '@weldsuite/ui/components/page-layout';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@weldsuite/ui/components/tabs';
import { useI18n } from '@/lib/i18n/provider';
import { useRouter } from '@/lib/router';
import { SETTINGS_TABS, type SettingsTab } from './search';
import { UsageView } from './usage-view';

export default function WeldPanelSettingsPage() {
  const { t } = useI18n();
  const ts = t.weldpanel.observe.settings;
  const canManage = useCan('panel_projects:manage');
  const router = useRouter();
  const search = useSearch({ strict: false }) as { tab?: string };
  const tab: SettingsTab = SETTINGS_TABS.includes(search.tab as SettingsTab) ? (search.tab as SettingsTab) : 'usage';

  return (
    <DashboardPage title={ts.title} description={ts.description}>
      {canManage ? (
        <Tabs value={tab} onValueChange={(value) => router.replace(`/weldpanel/settings?tab=${value}`)} className="gap-4">
          <TabsList>
            <TabsTrigger value="usage">{ts.tabs.usage}</TabsTrigger>
          </TabsList>
          <TabsContent value="usage">
            <UsageView />
          </TabsContent>
        </Tabs>
      ) : (
        <EmptyState title={ts.title} description={ts.noPermission} />
      )}
    </DashboardPage>
  );
}
