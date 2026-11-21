/**
 * One channel inside Settings → Apps → WeldCommerce → Channels: its
 * summary, and for a storefront its keys and shipping rates. Shopify,
 * WooCommerce and manual channels have neither, and say so.
 */

import { useState } from 'react';
import { ArrowLeft, Pencil } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { ErrorState } from '@weldsuite/ui/components/error-banner';
import { InfoBanner } from '@weldsuite/ui/components/info-banner';
import { PageLoader } from '@weldsuite/ui/components/page-loader';
import { SettingsSection } from '@weldsuite/ui/components/settings-layout';
import { SoftBadge } from '@weldsuite/ui/components/soft-badge';
import { useCommerceChannel, type CommerceChannel } from '@/hooks/queries/use-commerce-channels-queries';
import { getTranslations } from '@/lib/i18n';
import {
  channelAudienceLabel,
  channelStatusLabel,
  channelStatusTone,
  channelTypeLabel,
  countryNames,
  isStorefront,
  paymentMethodLabel,
} from '@/app/weldcommerce/lib/channels';
import { ChannelDialog } from './channel-dialog';
import { ChannelKeysSection } from './channel-keys-section';
import { ChannelShippingSection } from './channel-shipping-section';

function Fact({ label, children }: Readonly<{ label: string; children: React.ReactNode }>) {
  return (
    <div className="min-w-0">
      <dt className="text-xs font-medium text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 break-words text-sm">{children}</dd>
    </div>
  );
}

function Summary({ channel }: Readonly<{ channel: CommerceChannel }>) {
  const t = getTranslations('commerce').channels.detail;
  const storefront = isStorefront(channel.type);
  return (
    <dl className="grid gap-4 sm:grid-cols-2">
      <Fact label={t.type}>{channelTypeLabel(channel.type)}</Fact>
      <Fact label={t.audience}>{channelAudienceLabel(channel.audience)}</Fact>
      <Fact label={t.currency}>{channel.currency}</Fact>
      <Fact label={t.vat}>{channel.pricesIncludeTax ? t.vatIncluded : t.vatExcluded}</Fact>
      {storefront && (
        <>
          <Fact label={t.countries}>{channel.sellingCountries.length > 0 ? countryNames(channel.sellingCountries) : t.none}</Fact>
          <Fact label={t.paymentMethods}>
            {channel.paymentMethods.length > 0 ? channel.paymentMethods.map(paymentMethodLabel).join(', ') : t.none}
          </Fact>
          <Fact label={t.guestCheckout}>{channel.guestCheckout ? t.yes : t.no}</Fact>
        </>
      )}
    </dl>
  );
}

export function ChannelDetail({
  channelId,
  onBack,
  canUpdate,
  canCreate,
  canDelete,
}: Readonly<{
  channelId: string;
  onBack: () => void;
  canUpdate: boolean;
  canCreate: boolean;
  canDelete: boolean;
}>) {
  const t = getTranslations('commerce').channels;
  const common = getTranslations('common');
  const query = useCommerceChannel(channelId);
  const [editing, setEditing] = useState(false);

  const back = (
    <Button type="button" variant="ghost" size="sm" className="-ml-2" onClick={onBack}>
      <ArrowLeft className="mr-1 h-4 w-4" aria-hidden="true" />
      {t.detail.back}
    </Button>
  );

  if (query.isPending) return <PageLoader fullScreen={false} />;
  if (query.isError || !query.data) {
    return (
      <div className="space-y-4">
        {back}
        <ErrorState message={t.detail.loadFailed} onRetry={() => void query.refetch()} />
      </div>
    );
  }

  const channel = query.data.data;
  return (
    <div className="min-w-0 space-y-8">
      <div className="space-y-3">
        {back}
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <h2 className="truncate text-xl font-semibold tracking-tight">{channel.name}</h2>
            <SoftBadge tone={channelStatusTone(channel.status)}>{channelStatusLabel(channel.status)}</SoftBadge>
          </div>
          {canUpdate && (
            <Button type="button" variant="outline" size="sm" onClick={() => setEditing(true)}>
              <Pencil className="mr-1 h-3.5 w-3.5" aria-hidden="true" />
              {common.actions.edit}
            </Button>
          )}
        </div>
      </div>

      <SettingsSection title={t.detail.summary}>
        <Summary channel={channel} />
      </SettingsSection>

      {isStorefront(channel.type) ? (
        <>
          <ChannelKeysSection channelId={channel.id} canUpdate={canUpdate} />
          <ChannelShippingSection channel={channel} canCreate={canCreate} canUpdate={canUpdate} canDelete={canDelete} />
        </>
      ) : (
        <InfoBanner variant="info">{t.detail.noStorefrontFeatures}</InfoBanner>
      )}

      {editing && <ChannelDialog open onOpenChange={(open) => !open && setEditing(false)} channel={channel} />}
    </div>
  );
}
