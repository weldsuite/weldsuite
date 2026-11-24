/**
 * The Online store tab of Settings → Apps → WeldCommerce (`?tab=online-store`):
 * per store, its addresses (the free address and custom domains with the DNS
 * records to create), its visibility, its language and how it is built, and,
 * for a store built with the merchant's own code, its deployments. The store
 * is chosen with `?site=` when the workspace has more than one. Needs
 * `websites:read`; the sections check their own write permissions.
 */

import { Store } from 'lucide-react';
import { usePermissionsMaybe } from '@weldsuite/permissions/react';
import { Button } from '@weldsuite/ui/components/button';
import { EmptyState } from '@weldsuite/ui/components/empty-state';
import { ErrorState } from '@weldsuite/ui/components/error-banner';
import { PageLoader } from '@weldsuite/ui/components/page-loader';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@weldsuite/ui/components/select';
import { useOnlineStoreSites } from '@/hooks/queries/use-online-store-queries';
import { getTranslations } from '@/lib/i18n';
import { Link } from '@/lib/router';
import { OnlineStoreDeploymentsSection } from './online-store-deployments-section';
import { OnlineStoreGeneralSection } from './online-store-general-section';
import { OnlineStoreHostsSection } from './online-store-hosts-section';
import { OnlineStoreVisibilitySection } from './online-store-visibility-section';

export function OnlineStoreTab({ siteId, onSelectSite }: Readonly<{ siteId?: string; onSelectSite: (siteId: string) => void }>) {
  const t = getTranslations('commerce').onlineStore;
  const ts = t.settingsTab;
  const permissions = usePermissionsMaybe();
  const can = (permission: string) => permissions?.can(permission) ?? false;
  const canRead = can('websites:read');
  const sites = useOnlineStoreSites(canRead);

  if (!canRead) return <p className="text-sm text-muted-foreground">{ts.noPermission}</p>;
  if (sites.isPending) return <PageLoader fullScreen={false} />;
  if (sites.isError) return <ErrorState message={ts.loadFailed} onRetry={() => void sites.refetch()} />;

  const rows = [...(sites.data.data ?? [])].sort((a, b) => a.channelName.localeCompare(b.channelName));
  if (rows.length === 0) {
    return (
      <EmptyState
        icon={Store}
        title={ts.empty}
        description={ts.emptyDescription}
        action={
          <Button asChild size="sm">
            <Link href="/weldcommerce/online-store">{ts.emptyAction}</Link>
          </Button>
        }
      />
    );
  }
  const site = rows.find((candidate) => candidate.id === siteId) ?? rows[0]!;

  return (
    <div className="min-w-0 space-y-8">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-base font-semibold">{ts.title}</h2>
          <p className="text-sm text-muted-foreground">{ts.description}</p>
        </div>
        {rows.length > 1 && (
          <Select value={site.id} onValueChange={onSelectSite}>
            <SelectTrigger className="w-64" aria-label={ts.store}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {rows.map((candidate) => (
                <SelectItem key={candidate.id} value={candidate.id}>
                  {candidate.channelName}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </div>
      {/* Keyed by store: each one's forms start from its own values. */}
      <div key={site.id} className="space-y-10">
        <OnlineStoreHostsSection site={site} canManage={can('websites:manage')} />
        <OnlineStoreVisibilitySection site={site} canManage={can('websites:manage')} />
        <OnlineStoreGeneralSection site={site} canUpdate={can('websites:update')} />
        {site.mode === 'static' && <OnlineStoreDeploymentsSection site={site} canManage={can('websites:manage')} canDelete={can('websites:delete')} />}
      </div>
    </div>
  );
}
