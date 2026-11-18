/**
 * WeldPanel settings for the whole workspace, at `/weldpanel/settings`. The
 * `tab` search param picks the tab: `usage` (the usage emails and the banner
 * link to `?tab=usage`), `exports` (raw data export of the current project;
 * the "export failing" email links to `?tab=exports`) and `api` (the public
 * API and MCP tools). Needs `panel_projects:manage`.
 */

import { useSearch } from '@tanstack/react-router';
import { useCan } from '@weldsuite/permissions/react';
import { EmptyState } from '@weldsuite/ui/components/empty-state';
import { DashboardPage } from '@weldsuite/ui/components/page-layout';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@weldsuite/ui/components/tabs';
import { useI18n } from '@/lib/i18n/provider';
import { useRouter } from '@/lib/router';
import { ExportsView } from '../exports/exports-view';
import { ApiAccessView } from './api-access-view';
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
            <TabsTrigger value="exports">{t.weldpanel.collab.exports.tab}</TabsTrigger>
            <TabsTrigger value="api">{t.weldpanel.collab.api.tab}</TabsTrigger>
          </TabsList>
          <TabsContent value="usage">
            <UsageView />
          </TabsContent>
          <TabsContent value="exports">
            <ExportsView />
          </TabsContent>
          <TabsContent value="api">
            <ApiAccessView />
          </TabsContent>
        </Tabs>
      ) : (
        <EmptyState title={ts.title} description={ts.noPermission} />
      )}
    </DashboardPage>
  );
}
