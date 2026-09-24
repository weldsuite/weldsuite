/** WeldHR — white-label workforce portal: settings, branding and access. */

import { Lock } from 'lucide-react';
import { useNavigate, useSearch } from '@tanstack/react-router';
import type { PageTab } from '@weldsuite/ui/components/page-tabs';
import { useTranslations } from '@weldsuite/i18n/client';
import { usePermissions } from '@weldsuite/permissions/react';
import { emptyIcon, useHrBreadcrumbs, HrTabsPage } from '../components/page-kit';
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

  useHrBreadcrumbs({ label: t('weldhr.portal.title') });

  if (!can('employees:manage')) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 text-center">
        {emptyIcon(Lock)}
        <p className="text-sm font-medium">{t('weldhr.common.noPermission')}</p>
      </div>
    );
  }

  const activeTab: PortalTab = isPortalTab(search.tab) ? search.tab : 'settings';

  function setTab(tab: string) {
    navigate({ to: '/weldhr/portal', search: { tab: tab as PortalTab } });
  }

  const tabs: PageTab[] = [
    { id: 'settings', label: t('weldhr.portal.tabs.settings') },
    { id: 'branding', label: t('weldhr.portal.tabs.branding') },
    { id: 'access', label: t('weldhr.portal.tabs.access') },
  ];

  return (
    <HrTabsPage tabs={tabs} activeTab={activeTab} onTabChange={setTab}>
      {activeTab === 'settings' && <PortalSettingsTab />}
      {activeTab === 'branding' && <PortalBrandingTab />}
      {activeTab === 'access' && <PortalAccessTab />}
    </HrTabsPage>
  );
}
