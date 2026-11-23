/**
 * WeldCommerce → Online store: one card per storefront channel. A channel
 * without a store offers to create one; a store shows whether it is
 * published, its visibility and address, and leads to the editor, its pages,
 * menus and redirects, or (for a shop built with the merchant's own code) to
 * its deployments. Domains, visibility and deployments are settings, in
 * Settings → Apps → WeldCommerce → Online store.
 */

import { useMemo, useState } from 'react';
import { ExternalLink, Store } from 'lucide-react';
import { Link as RouterLink } from '@tanstack/react-router';
import { usePermissionsMaybe } from '@weldsuite/permissions/react';
import { Button } from '@weldsuite/ui/components/button';
import { DashboardPage } from '@weldsuite/ui/components/page-layout';
import { EmptyState } from '@weldsuite/ui/components/empty-state';
import { ErrorState } from '@weldsuite/ui/components/error-banner';
import { FieldGrid } from '@weldsuite/ui/components/field-grid';
import { PageLoader } from '@weldsuite/ui/components/page-loader';
import { SectionCard } from '@weldsuite/ui/components/section-card';
import { SoftBadge, type SoftTone } from '@weldsuite/ui/components/soft-badge';
import { useCommerceChannels, type CommerceChannel } from '@/hooks/queries/use-commerce-channels-queries';
import { useOnlineStoreSites, type OnlineStoreSite, type SiteVisibility } from '@/hooks/queries/use-online-store-queries';
import { formatPanelDate } from '@/components/objects/_shared/simple-object-panel';
import { getTranslations } from '@/lib/i18n';
import { Link, useRouter } from '@/lib/router';
import { fill } from '../lib/text';
import { CreateStoreDialog } from './components/create-store-dialog';
import { PublishDialog } from './components/publish-dialog';
import { OnlineStoreSettingsLink } from './lib/settings-link';

const VISIBILITY_TONES: Record<SiteVisibility, SoftTone> = { live: 'success', password: 'warning', coming_soon: 'neutral' };

export interface StoreCardEntry {
  channelId: string;
  channelName: string;
  channelStatus: string;
  site: OnlineStoreSite | null;
}

/**
 * A card per native storefront channel that is not archived, and per site
 * whatever its channel (a member without channel access still sees the
 * stores), ordered by channel name.
 */
export function storeCards(channels: readonly CommerceChannel[], sites: readonly OnlineStoreSite[]): StoreCardEntry[] {
  const byChannel = new Map<string, StoreCardEntry>();
  for (const channel of channels) {
    if (channel.type !== 'storefront' || channel.status === 'archived') continue;
    byChannel.set(channel.id, { channelId: channel.id, channelName: channel.name, channelStatus: channel.status, site: null });
  }
  for (const site of sites) {
    const existing = byChannel.get(site.channelId);
    byChannel.set(site.channelId, {
      channelId: site.channelId,
      channelName: existing?.channelName ?? site.channelName,
      channelStatus: existing?.channelStatus ?? site.channelStatus,
      site,
    });
  }
  return [...byChannel.values()].sort((a, b) => a.channelName.localeCompare(b.channelName));
}

function StoreCard({
  entry,
  canCreate,
  canManage,
  onCreate,
  onPublish,
}: Readonly<{ entry: StoreCardEntry; canCreate: boolean; canManage: boolean; onCreate: () => void; onPublish: (site: OnlineStoreSite) => void }>) {
  const t = getTranslations('commerce').onlineStore;
  const tc = t.card;
  const { site } = entry;

  if (!site) {
    return (
      <SectionCard title={entry.channelName} description={tc.noStore}>
        <div className="space-y-3">
          <p className="text-sm text-muted-foreground">{tc.noStoreDescription}</p>
          {canCreate && (
            <Button type="button" size="sm" onClick={onCreate}>
              {tc.create}
            </Button>
          )}
        </div>
      </SectionCard>
    );
  }

  const base = `/weldcommerce/online-store/${site.id}`;
  const builder = site.mode === 'builder';
  const status = site.publishedVersionNumber
    ? fill(tc.published, { number: site.publishedVersionNumber, date: formatPanelDate(site.publishedAt) ?? '' })
    : tc.notPublished;
  const address = site.primaryHost ? (
    <a
      href={`https://${site.primaryHost}`}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex items-center gap-1 font-medium text-primary underline-offset-4 hover:underline"
      aria-label={fill(tc.openShop, { address: site.primaryHost })}
    >
      {site.primaryHost}
      <ExternalLink className="size-3.5" aria-hidden="true" />
    </a>
  ) : (
    <span className="text-muted-foreground">
      {tc.noAddress} ·{' '}
      <OnlineStoreSettingsLink siteId={site.id} className="text-primary underline underline-offset-4">
        {tc.claimAddress}
      </OnlineStoreSettingsLink>
    </span>
  );

  return (
    <SectionCard title={entry.channelName} description={t.mode[site.mode]}>
      <div className="space-y-4">
        {entry.channelStatus === 'archived' && <p className="text-sm text-destructive">{tc.channelArchived}</p>}
        <FieldGrid
          fields={[
            {
              label: tc.status,
              value: (
                <span className="flex flex-wrap items-center gap-2">
                  <span>{status}</span>
                  {builder && site.hasUnpublishedChanges && <SoftBadge tone="warning">{tc.unpublishedChanges}</SoftBadge>}
                </span>
              ),
            },
            { label: tc.visibility, value: <SoftBadge tone={VISIBILITY_TONES[site.visibility]}>{t.visibility[site.visibility]}</SoftBadge> },
            { label: tc.address, value: address },
            { label: tc.language, value: t.locale[site.locale] ?? site.locale },
          ]}
        />
        <div className="flex flex-wrap gap-2">
          {builder && (
            <>
              <Button asChild size="sm">
                <Link href={`${base}/editor`} aria-label={fill(tc.editLabel, { channel: entry.channelName })}>
                  {tc.edit}
                </Link>
              </Button>
              <Button asChild size="sm" variant="outline">
                <Link href={`${base}/pages`}>{tc.pages}</Link>
              </Button>
              <Button asChild size="sm" variant="outline">
                <Link href={`${base}/menus`}>{tc.menus}</Link>
              </Button>
            </>
          )}
          <Button asChild size="sm" variant="outline">
            <Link href={`${base}/redirects`}>{tc.redirects}</Link>
          </Button>
          {builder && canManage && (
            <Button type="button" size="sm" variant="outline" onClick={() => onPublish(site)}>
              {tc.publish}
            </Button>
          )}
          {!builder && (
            <Button asChild size="sm" variant="outline">
              <OnlineStoreSettingsLink siteId={site.id}>{tc.deployments}</OnlineStoreSettingsLink>
            </Button>
          )}
        </div>
      </div>
    </SectionCard>
  );
}

export default function OnlineStorePage() {
  const t = getTranslations('commerce').onlineStore;
  const router = useRouter();
  const permissions = usePermissionsMaybe();
  const canRead = permissions?.can('websites:read') ?? false;
  const canCreate = permissions?.can('websites:create') ?? false;
  const canManage = permissions?.can('websites:manage') ?? false;
  const canReadChannels = permissions?.can('commerce_channels:read') ?? false;
  const sites = useOnlineStoreSites(canRead);
  const channels = useCommerceChannels({ type: 'storefront' }, canRead && canReadChannels);
  const [creating, setCreating] = useState<{ id: string; name: string } | null>(null);
  const [publishing, setPublishing] = useState<OnlineStoreSite | null>(null);

  const cards = useMemo(() => storeCards(channels.data?.data ?? [], sites.data?.data ?? []), [channels.data, sites.data]);

  const settingsLink = (
    <Button asChild variant="outline" size="sm">
      <OnlineStoreSettingsLink>{t.domainsLink}</OnlineStoreSettingsLink>
    </Button>
  );

  let body;
  if (permissions?.isLoading) body = <PageLoader fullScreen={false} />;
  else if (!canRead) body = <p className="text-sm text-muted-foreground">{t.noPermission}</p>;
  else if (sites.isPending || (canReadChannels && channels.isPending)) body = <PageLoader fullScreen={false} />;
  else if (sites.isError || (canReadChannels && channels.isError)) {
    body = (
      <ErrorState
        message={t.loadFailed}
        onRetry={() => {
          void sites.refetch();
          if (canReadChannels) void channels.refetch();
        }}
      />
    );
  } else if (cards.length === 0) {
    body = (
      <EmptyState
        icon={Store}
        title={t.empty}
        description={t.emptyDescription}
        action={
          <Button asChild size="sm">
            <RouterLink to="/settings/apps/weldcommerce" search={{ tab: 'channels' }}>
              {t.emptyAction}
            </RouterLink>
          </Button>
        }
      />
    );
  } else {
    body = (
      <div className="grid gap-4 @3xl:grid-cols-2">
        {cards.map((entry) => (
          <StoreCard
            key={entry.channelId}
            entry={entry}
            canCreate={canCreate}
            canManage={canManage}
            onCreate={() => setCreating({ id: entry.channelId, name: entry.channelName })}
            onPublish={setPublishing}
          />
        ))}
      </div>
    );
  }

  return (
    <DashboardPage title={t.title} description={t.description} actions={canRead ? settingsLink : undefined} className="@container">
      {body}
      {creating && (
        <CreateStoreDialog
          channel={creating}
          onOpenChange={(open) => {
            if (!open) setCreating(null);
          }}
          onCreated={(site) => {
            if (site.mode === 'builder') router.push(`/weldcommerce/online-store/${site.id}/editor`);
          }}
        />
      )}
      {publishing && (
        <PublishDialog
          open
          onOpenChange={(open) => {
            if (!open) setPublishing(null);
          }}
          siteId={publishing.id}
        />
      )}
    </DashboardPage>
  );
}
