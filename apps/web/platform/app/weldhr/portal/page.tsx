/** WeldHR — white-label workforce portal: settings, branding and access. */

import { useNavigate, useSearch } from '@tanstack/react-router';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@weldsuite/ui/components/tabs';
import { useTranslations } from '@weldsuite/i18n/client';
import { usePermissions } from '@weldsuite/permissions/react';
import { EmptyState, PageBody, PageHeader } from '../components/shared';
import { PortalSettingsTab } from './components/settings-tab';
import { PortalBrandingTab } from './components/branding-tab';
import { PortalAccessTab } from './components/access-tab';

const TABS = ['settings', 'branding', 'access'] as const;
type PortalTab = (typeof TABS)[number];

function isPortalTab(value: string | undefined): value is PortalTab {
  return Boolean(value) && (TABS as readonly string[]).includes(value as string);
}

export default function WeldHrPortalPage() {
  const t = useTranslations();
  const { can } = usePermissions();
  const search = useSearch({ from: '/weldhr/portal/' });
  const navigate = useNavigate();

  if (!can('employees:manage')) {
    return (
      <PageBody>
        <EmptyState title={t('weldhr.common.noPermission')} />
      </PageBody>
    );
  }

  const activeTab: PortalTab = isPortalTab(search.tab) ? search.tab : 'settings';

  function setTab(tab: PortalTab) {
    navigate({ to: '/weldhr/portal', search: { tab } });
  }

  return (
    <PageBody wide>
      <PageHeader title={t('weldhr.portal.title')} subtitle={t('weldhr.portal.subtitle')} />

      <Tabs value={activeTab} onValueChange={(v) => setTab(v as PortalTab)}>
        <TabsList>
          <TabsTrigger value="settings">{t('weldhr.portal.tabs.settings')}</TabsTrigger>
          <TabsTrigger value="branding">{t('weldhr.portal.tabs.branding')}</TabsTrigger>
          <TabsTrigger value="access">{t('weldhr.portal.tabs.access')}</TabsTrigger>
        </TabsList>

        <TabsContent value="settings" className="pt-4">
          <PortalSettingsTab />
        </TabsContent>
        <TabsContent value="branding" className="pt-4">
          <PortalBrandingTab />
        </TabsContent>
        <TabsContent value="access" className="pt-4">
          <PortalAccessTab />
        </TabsContent>
      </Tabs>
    </PageBody>
  );
}
