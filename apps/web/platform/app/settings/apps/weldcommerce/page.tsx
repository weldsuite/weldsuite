/**
 * Settings → Apps → WeldCommerce, in tabs (`?tab=general|channels|payments|online-store`):
 * General (the order number and the default currency), Channels (sales
 * channels, their keys and shipping rates), Payments (the Mollie
 * connection) and Online store (addresses, visibility and deployments of
 * the online stores). They live here, not in WeldCommerce itself
 * (AGENTS.md, "App settings live in Settings"). WeldCommerce is Rust-only, so
 * on Global the page says it is not available.
 */

import { useCallback } from 'react';
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
import { PaymentsTab } from './payments-tab';
import { OnlineStoreTab } from './online-store-tab';

type SettingsTab = 'general' | 'channels' | 'payments' | 'online-store';

/** The tab from `?tab=`, or General when it is unknown or the member may not see it. */
function pickTab(requested: string | undefined, showChannels: boolean, showPayments: boolean, showOnlineStore: boolean): SettingsTab {
  if (requested === 'channels' && showChannels) return 'channels';
  if (requested === 'payments' && showPayments) return 'payments';
  if (requested === 'online-store' && showOnlineStore) return 'online-store';
  return 'general';
}

function SettingsContent() {
  const t = getTranslations('commerce');
  const permissions = usePermissionsMaybe();
  const search = useSearch({ strict: false }) as { tab?: string; channel?: string; mollie?: string; reason?: string; site?: string };
  const navigate = useNavigate();
  const showChannels = permissions?.can('commerce_channels:read') ?? false;
  const showPayments = permissions?.can('commerce_settings:read') ?? false;
  const showOnlineStore = permissions?.can('websites:read') ?? false;
  const activeTab = pickTab(search.tab, showChannels, showPayments, showOnlineStore);

  const go = (next: { tab?: SettingsTab; channel?: string; site?: string }) =>
    void navigate({ to: '/settings/apps/weldcommerce', search: next.tab && next.tab !== 'general' ? next : {} });

  // The Mollie callback result is read once by the Payments tab; then the query string is cleaned (no history entry).
  const clearCallback = useCallback(
    () => void navigate({ to: '/settings/apps/weldcommerce', search: { tab: 'payments' }, replace: true }),
    [navigate],
  );

  const tabs: PageTab[] = [
    { id: 'general', label: t.channels.tabs.general },
    ...(showChannels ? [{ id: 'channels', label: t.channels.tabs.channels }] : []),
    ...(showPayments ? [{ id: 'payments', label: t.channels.tabs.payments }] : []),
    ...(showOnlineStore ? [{ id: 'online-store', label: t.onlineStore.settingsTab.tab }] : []),
  ];

  return (
    // `min-w-0`: never wider than the settings column, so the tables' row buttons stay reachable.
    <div className="min-w-0 space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{t.settings.title}</h1>
        <p className="text-muted-foreground">{t.settings.description}</p>
      </div>
      {tabs.length > 1 && <PageTabs tabs={tabs} activeTab={activeTab} onTabChange={(id) => go({ tab: id as SettingsTab })} overflow="dropdown" />}
      <div className="@container">
        {activeTab === 'general' && <GeneralTab />}
        {activeTab === 'channels' && (
          <ChannelsTab channelId={search.channel} onOpenChannel={(channel) => go({ tab: 'channels', channel })} />
        )}
        {activeTab === 'payments' && (
          <PaymentsTab callback={{ mollie: search.mollie, reason: search.reason }} onCallbackHandled={clearCallback} />
        )}
        {activeTab === 'online-store' && <OnlineStoreTab siteId={search.site} onSelectSite={(site) => go({ tab: 'online-store', site })} />}
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
