import { useEffect, useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Factory, Globe, FileText, Plus, Settings } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { Badge } from '@weldsuite/ui/components/badge';
import { ConfirmDialog } from '@weldsuite/ui/components/confirm-dialog';
import { EmptyState } from '@weldsuite/ui/components/empty-state';
import { IntegrationDetailLayout } from '@/components/settings';
import { PageLoader } from '@weldsuite/ui/components/page-loader';
import { toast } from 'sonner';
import { useI18n } from '@/lib/i18n/provider';
import { usePermissions } from '@weldsuite/permissions/react';
import {
  useConnectorCatalog,
  useDisconnectConnector,
  type ConnectorCatalogEntry,
  type ConnectorConnection,
} from '@/hooks/queries/use-connector-queries';
import { ConnectDialog, ConnectionDetails, consumeWooCommerceAuthReturn } from './connect-dialog';

function BrandLogo({ slug, alt }: Readonly<{ slug: string; alt: string }>) {
  return (
    <img
      src={`https://api.iconify.design/logos:${slug}.svg`}
      alt={alt}
      className="h-7 w-7"
      loading="lazy"
    />
  );
}

/** The connectors in the connector catalog (`/api/connectors/catalog`), each with its Settings page. */
export const CONNECTOR_PROVIDERS = ['woocommerce', 'shopify', 'moneybird', 'stripe', 'picqer', 'odoo'] as const;
export type ConnectorProvider = (typeof CONNECTOR_PROVIDERS)[number];

export function isConnectorProvider(value: string): value is ConnectorProvider {
  return (CONNECTOR_PROVIDERS as readonly string[]).includes(value);
}

const PROVIDER_CATEGORY = {
  woocommerce: 'ecommerce',
  shopify: 'ecommerce',
  moneybird: 'accounting',
  stripe: 'accounting',
  picqer: 'warehouse',
  odoo: 'erp',
} as const satisfies Record<ConnectorProvider, string>;

const PROVIDER_DOCS_HREF: Record<ConnectorProvider, string> = {
  woocommerce:
    'https://developer.woocommerce.com/docs/apis/rest-api/authentication/#auto-generating-api-keys-using-our-application-authentication-endpoint',
  shopify:
    'https://shopify.dev/docs/apps/build/authentication-authorization/access-tokens/generate-app-access-tokens-admin',
  picqer: 'https://picqer.com/en/api',
  moneybird: 'https://developer.moneybird.com/authentication/',
  stripe: 'https://docs.stripe.com/connect/oauth-reference',
  odoo: 'https://www.odoo.com/documentation/latest/developer/reference/external_api.html',
};

const PROVIDER_WEBSITE_HREF: Record<ConnectorProvider, string> = {
  woocommerce: 'https://woocommerce.com',
  shopify: 'https://www.shopify.com',
  picqer: 'https://picqer.com',
  moneybird: 'https://www.moneybird.com',
  stripe: 'https://stripe.com',
  odoo: 'https://www.odoo.com',
};

function ProviderIcon({ provider, alt }: Readonly<{ provider: ConnectorProvider; alt: string }>) {
  if (provider === 'odoo') {
    return <Factory className="h-7 w-7 text-muted-foreground" aria-label={alt} />;
  }
  if (provider === 'moneybird' || provider === 'picqer' || provider === 'stripe') {
    return (
      <img
        src={`https://icons.duckduckgo.com/ip3/${provider}.com.ico`}
        alt={alt}
        className="h-7 w-7 rounded-[4px]"
      />
    );
  }
  return <BrandLogo slug={provider === 'woocommerce' ? 'woocommerce' : 'shopify'} alt={alt} />;
}

export function EcommerceConnectorSettingsPage({
  provider,
}: Readonly<{
  provider: ConnectorProvider;
}>) {
  const { t, format } = useI18n();
  const copy = t.settings.integrations[provider];
  const tc = t.settings.integrations.connectors;
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

  // The backend's catalog leaves out what this edition doesn't run (Odoo on Global).
  if (!connector) {
    return (
      <div className="mx-auto w-full max-w-4xl p-6">
        <EmptyState
          title={t.settings.integrations.list.noneOfferedTitle}
          description={t.settings.integrations.list.noneOfferedDescription}
        />
      </div>
    );
  }

  const category = t.settings.integrations.list.categories[PROVIDER_CATEGORY[provider]];
  const docsHref = PROVIDER_DOCS_HREF[provider];
  const websiteHref = PROVIDER_WEBSITE_HREF[provider];

  return (
    <>
      <IntegrationDetailLayout
        name={copy.title}
        description={copy.description}
        category={category}
        icon={<ProviderIcon provider={provider} alt={copy.title} />}
        connected={connections.length > 0}
        canManage={false}
        overview={copy.overview}
        resources={[
          {
            label: t.settings.integrations.documentation,
            href: docsHref,
            icon: FileText,
          },
          {
            label: t.settings.integrations.website,
            href: websiteHref,
            icon: Globe,
          },
        ]}
      >
        <div className="space-y-4">
          <div className="flex items-center justify-between gap-3">
            <h2 className="text-xl font-semibold">{tc.title}</h2>
            {canConnect ? (
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
