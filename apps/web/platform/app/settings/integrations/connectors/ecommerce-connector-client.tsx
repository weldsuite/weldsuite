import { useEffect, useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Globe, FileText, Plus, Settings } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { Badge } from '@weldsuite/ui/components/badge';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { IntegrationDetailLayout } from '@/components/settings';
import { PageLoader } from '@/components/page-loader';
import { toast } from 'sonner';
import { useI18n } from '@/lib/i18n/provider';
import { usePermissions } from '@weldsuite/permissions/react';
import {
  useConnectorCatalog,
  useDisconnectConnector,
  type ConnectorCatalogEntry,
  type ConnectorConnection,
} from '@/hooks/queries/use-connector-queries';
import {
  ConnectDialog,
  ConnectionDetails,
  consumeWooCommerceAuthReturn,
} from '@/app/weldconnect/connectors/connectors-client';

function BrandLogo({ slug, alt }: { slug: string; alt: string }) {
  return (
    <img
      src={`https://api.iconify.design/logos:${slug}.svg`}
      alt={alt}
      className="h-7 w-7"
      loading="lazy"
    />
  );
}

export function EcommerceConnectorSettingsPage({
  provider,
}: {
  provider: 'woocommerce' | 'shopify';
}) {
  const { t, format } = useI18n();
  const copy = t.settings.integrations[provider];
  const tc = t.weldconnect.connectors;
  const { canAny, isLoading: permissionsLoading } = usePermissions();
  const canConnect = canAny('integrations:create', 'weldconnect:integrations:create');
  const canManage = canAny('integrations:update', 'weldconnect:integrations:update');

  const queryClient = useQueryClient();
  const { data, isLoading } = useConnectorCatalog();
  const disconnect = useDisconnectConnector();
  const [pendingConnect, setPendingConnect] = useState<ConnectorCatalogEntry | null>(null);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [pendingDisconnect, setPendingDisconnect] = useState<ConnectorConnection | null>(null);

  const connector = useMemo(
    () => (data?.data ?? []).find((entry) => entry.provider === provider) ?? null,
    [data, provider],
  );
  const connections = connector?.connections ?? [];

  useEffect(() => {
    consumeWooCommerceAuthReturn(
      { authReturned: tc.authReturned, authDenied: tc.authDenied },
      () => {
        void queryClient.invalidateQueries({ queryKey: ['connectors'] });
      },
    );
  }, [queryClient, tc.authReturned, tc.authDenied]);

  const handleDisconnect = () => {
    if (!pendingDisconnect) return;
    disconnect.mutate(pendingDisconnect.id, {
      onSuccess: () => {
        toast.success(tc.disconnected);
        setPendingDisconnect(null);
        setDetailId(null);
      },
      onError: () => toast.error(tc.disconnectFailed),
    });
  };

  if (isLoading || permissionsLoading) {
    return <PageLoader fullScreen={false} />;
  }

  return (
    <>
      <IntegrationDetailLayout
        name={copy.title}
        description={copy.description}
        category="E-Commerce"
        icon={<BrandLogo slug={provider === 'woocommerce' ? 'woocommerce' : 'shopify'} alt={copy.title} />}
        connected={connections.length > 0}
        canManage={false}
        overview={copy.overview}
        resources={[
          {
            label: t.settings.integrations.documentation,
            href: provider === 'woocommerce'
              ? 'https://developer.woocommerce.com/docs/apis/rest-api/authentication/#auto-generating-api-keys-using-our-application-authentication-endpoint'
              : 'https://shopify.dev/docs/apps/build/authentication-authorization/access-tokens/generate-app-access-tokens-admin',
            icon: FileText,
          },
          {
            label: t.settings.integrations.website,
            href: provider === 'woocommerce' ? 'https://woocommerce.com' : 'https://www.shopify.com',
            icon: Globe,
          },
        ]}
      >
        <div className="space-y-4">
          <div className="flex items-center justify-between gap-3">
            <h2 className="text-xl font-semibold">{tc.title}</h2>
            {canConnect && connector ? (
              <Button size="sm" onClick={() => setPendingConnect(connector)}>
                <Plus className="mr-1.5 h-3.5 w-3.5" />
                {connections.length > 0 ? tc.addStore : tc.connect}
              </Button>
            ) : null}
          </div>
          <p className="text-muted-foreground text-sm">{tc.webhookHint}</p>

          {connections.length === 0 ? (
            <p className="text-muted-foreground text-sm">{tc.noStores}</p>
          ) : (
            <ul className="space-y-2">
              {connections.map((connection) => (
                <li key={connection.id} className="flex items-center justify-between gap-3 rounded-lg border px-3 py-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <p className="truncate text-sm font-medium">
                        {connection.displayName || connection.externalAccountId || connection.label}
                      </p>
                      <Badge variant="outline" className="text-xs">
                        {tc.status[connection.status] ?? connection.status}
                      </Badge>
                    </div>
                    {connection.externalAccountId ? (
                      <p className="text-muted-foreground truncate text-xs">{connection.externalAccountId}</p>
                    ) : null}
                  </div>
                  <Button size="sm" variant="outline" onClick={() => setDetailId(connection.id)}>
                    <Settings className="mr-1.5 h-3.5 w-3.5" />
                    {tc.viewDetails}
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </IntegrationDetailLayout>

      <ConnectDialog connector={pendingConnect} onOpenChange={(open) => !open && setPendingConnect(null)} />
      <ConnectionDetails
        connectionId={detailId}
        onOpenChange={(open) => !open && setDetailId(null)}
        onDisconnect={setPendingDisconnect}
        canManage={canManage}
      />
      <ConfirmDialog
        open={Boolean(pendingDisconnect)}
        onOpenChange={(open) => !open && setPendingDisconnect(null)}
        title={format(tc.disconnectTitle, { name: pendingDisconnect?.displayName || pendingDisconnect?.label || '' })}
        description={tc.disconnectDescription}
        confirmLabel={tc.disconnect}
        variant="destructive"
        loading={disconnect.isPending}
        onConfirm={handleDisconnect}
      />
    </>
  );
}
