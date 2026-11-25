/**
 * The frame of an online store's Pages, Menus and Redirects screens: a back
 * button to the online store, the title with the store's name, and the
 * permission and loading states they share.
 */

import type { ReactNode } from 'react';
import { usePermissionsMaybe } from '@weldsuite/permissions/react';
import { DetailHeader, DetailPage } from '@weldsuite/ui/components/page-layout';
import { PageLoader } from '@weldsuite/ui/components/page-loader';
import { useOnlineStoreSites, type OnlineStoreSite } from '@/hooks/queries/use-online-store-queries';
import { getTranslations } from '@/lib/i18n';
import { useParams, useRouter } from '@/lib/router';

export interface StorePermissions {
  canRead: boolean;
  canCreate: boolean;
  canUpdate: boolean;
  canDelete: boolean;
  canManage: boolean;
}

export function useStorePermissions(): StorePermissions & { loading: boolean } {
  const permissions = usePermissionsMaybe();
  const can = (permission: string) => permissions?.can(permission) ?? false;
  return {
    loading: permissions?.isLoading ?? false,
    canRead: can('websites:read'),
    canCreate: can('websites:create'),
    canUpdate: can('websites:update'),
    canDelete: can('websites:delete'),
    canManage: can('websites:manage'),
  };
}

export function StoreSubpage({
  title,
  description,
  actions,
  children,
}: Readonly<{
  title: string;
  /** Gets the store's name (its channel) in `{store}`. */
  description: string;
  actions?: (site: OnlineStoreSite) => ReactNode;
  children: (site: OnlineStoreSite, permissions: StorePermissions) => ReactNode;
}>) {
  const t = getTranslations('commerce').onlineStore;
  const { siteId } = useParams<{ siteId: string }>();
  const router = useRouter();
  const permissions = useStorePermissions();
  const sites = useOnlineStoreSites(permissions.canRead);
  const site = sites.data?.data.find((candidate) => candidate.id === siteId);

  let body: ReactNode;
  if (permissions.loading || (permissions.canRead && sites.isPending)) body = <PageLoader fullScreen={false} />;
  else if (!permissions.canRead) body = <p className="text-sm text-muted-foreground">{t.noPermission}</p>;
  else if (!site) body = <p className="text-sm text-muted-foreground">{sites.isError ? t.loadFailed : t.editor.loadFailed}</p>;
  else body = children(site, permissions);

  return (
    <DetailPage className="mx-auto max-w-5xl">
      <DetailHeader
        title={title}
        subtitle={site ? description.replace('{store}', site.channelName) : undefined}
        onBack={() => router.push('/weldcommerce/online-store')}
        backLabel={t.pages.back}
        actions={site && actions ? actions(site) : undefined}
      />
      {body}
    </DetailPage>
  );
}
