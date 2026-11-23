/**
 * Settings → Apps → WeldCommerce, in tabs (`?tab=general|channels|payments`):
 * General (the order number and the default currency), Channels (sales
 * channels, their keys and shipping rates) and Payments (the Mollie
 * connection). They live here, not in WeldCommerce itself
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

type SettingsTab = 'general' | 'channels' | 'payments';

/** The tab from `?tab=`, or General when it is unknown or the member may not see it. */
function pickTab(requested: string | undefined, showChannels: boolean, showPayments: boolean): SettingsTab {
  if (requested === 'channels' && showChannels) return 'channels';
  if (requested === 'payments' && showPayments) return 'payments';
  return 'general';
}

function SettingsContent() {
  const t = getTranslations('commerce');
  const permissions = usePermissionsMaybe();
  const search = useSearch({ strict: false }) as { tab?: string; channel?: string; mollie?: string; reason?: string };
  const navigate = useNavigate();
  const showChannels = permissions?.can('commerce_channels:read') ?? false;
  const showPayments = permissions?.can('commerce_settings:read') ?? false;
  const activeTab = pickTab(search.tab, showChannels, showPayments);

  const go = (next: { tab?: SettingsTab; channel?: string }) =>
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
