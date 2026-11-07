import { useState } from 'react';
import { useCan, useCanAny } from '@weldsuite/permissions/react';
import { InfoBanner } from '@weldsuite/ui/components/info-banner';
import { PageLoader } from '@weldsuite/ui/components/page-loader';
import { PageTabs, type PageTab } from '@weldsuite/ui/components/page-tabs';
import { WELDMERGE_READ_PERMISSIONS } from '@/app/weldmerge/layout';
import { AccountsSection } from '@/app/weldmerge/settings/accounts-section';
import { LabelsSection } from '@/app/weldmerge/settings/labels-section';
import { NotificationsSection } from '@/app/weldmerge/settings/notifications-section';
import { ProvidersSection } from '@/app/weldmerge/settings/providers-section';
import { TeamsSection } from '@/app/weldmerge/settings/teams-section';
import { useAppAccess } from '@/hooks/use-app-access';
import { useI18n } from '@/lib/i18n/provider';
import { useSearchParams } from '@/lib/router';

type SettingsTab = 'providers' | 'teams' | 'labels' | 'accounts' | 'notifications';

const isSettingsTab = (value: string | null): value is SettingsTab =>
  value === 'providers' || value === 'teams' || value === 'labels' || value === 'accounts' || value === 'notifications';

/**
 * Settings → Apps → WeldMerge: git providers and their repositories, teams,
 * labels and the member's own provider accounts. Everything that changes the
 * workspace is gated on its permission; without it the sections are read-only.
 * Takes the same access as the WeldMerge app: installed, and able to read part of it.
 */
export default function WeldMergeSettingsPage() {
  const { t } = useI18n();
  const { isInstalled, isLoading } = useAppAccess('weldmerge');
  const canRead = useCanAny(WELDMERGE_READ_PERMISSIONS);

  if (isLoading) return <PageLoader fullScreen={false} />;
  if (!isInstalled) {
    return <div className="flex items-center justify-center py-16 text-muted-foreground">{t.common.empty.appNotInstalled}</div>;
  }
  if (!canRead) {
    return <div className="flex items-center justify-center py-16 text-muted-foreground">{t.weldmerge.noAccess}</div>;
  }
  return <WeldMergeSettings />;
}

function WeldMergeSettings() {
  const { t } = useI18n();
  const tm = t.weldmerge;
  const search = useSearchParams();
  const canManageConnections = useCan('merge_connections:manage');
  const canManageTeams = useCan('merge_teams:manage');
  const canReadConnections = useCan('merge_connections:read');
  const canReadTeams = useCan('merge_teams:read');
  const requestedTab = search.get('tab');
  const [tab, setTab] = useState<SettingsTab | null>(isSettingsTab(requestedTab) ? requestedTab : null);

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
    // `min-w-0`: never wider than the settings column, so the repository table scrolls inside its own box.
    <div className="min-w-0 space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{tm.title}</h1>
        <p className="text-muted-foreground">{tm.settings.description}</p>
      </div>
      <PageTabs tabs={tabs} activeTab={active} onTabChange={(id) => setTab(id as SettingsTab)} overflow="dropdown" />
      {readOnly && <InfoBanner variant="neutral">{tm.settings.noAccess}</InfoBanner>}
      {active === 'providers' && (
        <ProvidersSection installed={search.get('installed') === '1'} installError={search.get('error')} />
      )}
      {active === 'teams' && <TeamsSection />}
      {active === 'labels' && <LabelsSection />}
      {active === 'accounts' && <AccountsSection />}
      {active === 'notifications' && <NotificationsSection />}
    </div>
  );
}
