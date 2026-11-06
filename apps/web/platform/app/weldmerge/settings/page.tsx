import { useState } from 'react';
import { useCan } from '@weldsuite/permissions/react';
import { InfoBanner } from '@weldsuite/ui/components/info-banner';
import { PageTabs, type PageTab } from '@weldsuite/ui/components/page-tabs';
import { useI18n } from '@/lib/i18n/provider';
import { useSearchParams } from '@/lib/router';
import { AccountsSection } from './accounts-section';
import { LabelsSection } from './labels-section';
import { NotificationsSection } from './notifications-section';
import { ProvidersSection } from './providers-section';
import { TeamsSection } from './teams-section';

type SettingsTab = 'providers' | 'teams' | 'labels' | 'accounts' | 'notifications';

/**
 * WeldMerge settings: git providers and their repositories, teams, labels and
 * the member's own provider accounts. Everything that changes the workspace is
 * gated on its permission; without it the sections are read-only.
 */
export default function WeldMergeSettingsPage() {
  const { t } = useI18n();
  const tm = t.weldmerge;
  const search = useSearchParams();
  const canManageConnections = useCan('merge_connections:manage');
  const canManageTeams = useCan('merge_teams:manage');
  const canReadConnections = useCan('merge_connections:read');
  const canReadTeams = useCan('merge_teams:read');
  const requestedTab = search.get('tab');
  const [tab, setTab] = useState<SettingsTab | null>(
    requestedTab === 'providers' || requestedTab === 'teams' || requestedTab === 'labels' || requestedTab === 'accounts' || requestedTab === 'notifications'
      ? requestedTab
      : null,
  );

  const tabs: PageTab[] = [
    ...(canReadConnections ? [{ id: 'providers', label: tm.settings.sections.providers }] : []),
    ...(canReadTeams ? [{ id: 'teams', label: tm.settings.sections.teams }] : []),
    ...(canReadTeams ? [{ id: 'labels', label: tm.settings.sections.labels }] : []),
    { id: 'accounts', label: tm.settings.sections.accounts },
    ...(canManageTeams ? [{ id: 'notifications', label: tm.across.notifications.tab }] : []),
  ];
  const active = (tab && tabs.some((item) => item.id === tab) ? tab : (tabs[0]?.id as SettingsTab)) ?? 'accounts';
  const readOnly = !canManageConnections && !canManageTeams;

  return (
    <div className="flex h-full flex-col">
      <div className="space-y-3 px-4 pt-3">
        <div>
          <h1 className="text-lg font-semibold">{tm.settings.title}</h1>
          <p className="text-sm text-muted-foreground">{tm.settings.description}</p>
        </div>
        <PageTabs tabs={tabs} activeTab={active} onTabChange={(id) => setTab(id as SettingsTab)} />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-5xl space-y-6 p-4 md:p-6">
          {readOnly && <InfoBanner variant="neutral">{tm.settings.noAccess}</InfoBanner>}
          {active === 'providers' && (
            <ProvidersSection installed={search.get('installed') === '1'} installError={search.get('error')} />
          )}
          {active === 'teams' && <TeamsSection />}
          {active === 'labels' && <LabelsSection />}
          {active === 'accounts' && <AccountsSection />}
          {active === 'notifications' && <NotificationsSection />}
        </div>
      </div>
    </div>
  );
}
