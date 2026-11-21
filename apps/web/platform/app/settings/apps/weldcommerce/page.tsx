/**
 * Settings → Apps → WeldCommerce, in tabs (`?tab=general|channels`): General
 * (the order number and the default currency) and Channels (sales channels,
 * their keys and shipping rates). They live here, not in WeldCommerce itself
 * (AGENTS.md, "App settings live in Settings"). WeldCommerce is Rust-only, so
 * on Global the page says it is not available.
 */

import { useNavigate, useSearch } from '@tanstack/react-router';
import { PageLoader } from '@weldsuite/ui/components/page-loader';
import { PageTabs, type PageTab } from '@weldsuite/ui/components/page-tabs';
import { usePermissionsMaybe } from '@weldsuite/permissions/react';
import { EditionUnavailablePage } from '@/components/edition-unavailable-page';
import { useAppAccess } from '@/hooks/use-app-access';
import { isFeatureAvailable } from '@/lib/edition';
import { getTranslations } from '@/lib/i18n';
import { ChannelsTab } from './channels-tab';
import { GeneralTab } from './general-tab';

type SettingsTab = 'general' | 'channels';

function SettingsContent() {
  const t = getTranslations('commerce');
  const permissions = usePermissionsMaybe();
  const search = useSearch({ strict: false }) as { tab?: string; channel?: string };
  const navigate = useNavigate();
  const showChannels = permissions?.can('commerce_channels:read') ?? false;
  const activeTab: SettingsTab = search.tab === 'channels' && showChannels ? 'channels' : 'general';

  const go = (next: { tab?: SettingsTab; channel?: string }) =>
    void navigate({ to: '/settings/apps/weldcommerce', search: next.tab && next.tab !== 'general' ? next : {} });

  const tabs: PageTab[] = [
    { id: 'general', label: t.channels.tabs.general },
    ...(showChannels ? [{ id: 'channels', label: t.channels.tabs.channels }] : []),
  ];

  return (
    // `min-w-0`: never wider than the settings column, so the tables' row buttons stay reachable.
    <div className="min-w-0 space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{t.settings.title}</h1>
        <p className="text-muted-foreground">{t.settings.description}</p>
      </div>
      {showChannels && <PageTabs tabs={tabs} activeTab={activeTab} onTabChange={(id) => go({ tab: id as SettingsTab })} overflow="dropdown" />}
      <div className="@container">
        {activeTab === 'general' && <GeneralTab />}
        {activeTab === 'channels' && (
          <ChannelsTab channelId={search.channel} onOpenChannel={(channel) => go({ tab: 'channels', channel })} />
        )}
      </div>
    </div>
  );
}

export default function WeldCommerceSettingsPage() {
  const t = getTranslations('commerce');
  const { isInstalled, isLoading } = useAppAccess('weldcommerce');

  if (!isFeatureAvailable('commerce')) return <EditionUnavailablePage />;
  if (isLoading) return <PageLoader fullScreen={false} />;
  if (!isInstalled) {
    return <div className="flex items-center justify-center py-16 text-muted-foreground">{t.notInstalled}</div>;
  }
  return <SettingsContent />;
}
