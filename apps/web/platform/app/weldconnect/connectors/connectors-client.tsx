import { useMemo, useState, useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  AlertCircle,
  CheckCircle2,
  Loader2,
  Plug,
  Search,
  Link as LinkIcon,
  ShoppingBag,
  Settings,
  BookOpen,
} from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { Input } from '@weldsuite/ui/components/input';
import { Label } from '@weldsuite/ui/components/label';
import { Switch } from '@weldsuite/ui/components/switch';
import { Badge } from '@weldsuite/ui/components/badge';
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@weldsuite/ui/components/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@weldsuite/ui/components/dialog';
import { toast } from 'sonner';
import { useI18n } from '@/lib/i18n/provider';
import { usePermissions } from '@weldsuite/permissions/react';
import { useBreadcrumbs } from '@/contexts/breadcrumb-context';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { Link } from '@/lib/router';
import {
  useConnectorCatalog,
  useDisconnectConnector,
  useAuthorizeConnector,
  useConnectConnector,
  useTestConnector,
  type ConnectorCatalogEntry,
  type ConnectorConnection,
  type ConnectorSyncDef,
} from '@/hooks/queries/use-connector-queries';
import { ConnectionDetails } from './connection-details';

export { ConnectionDetails };

const ICON_MAP: Record<string, React.ElementType> = {
  'shopping-bag': ShoppingBag,
  store: ShoppingBag,
  'book-open': BookOpen,
  plug: Plug,
};

function getIcon(key: string): React.ElementType {
  return ICON_MAP[key] ?? Plug;
}

const EMPTY_CATALOG: ConnectorCatalogEntry[] = [];

export function consumeWooCommerceAuthReturn(
  copy: { authReturned: string; authDenied: string },
  onSettled?: () => void,
): void {
  const params = new URLSearchParams(window.location.search);
  const success = params.get('success');
  if (success === null) return;
  if (success === '1') toast.success(copy.authReturned);
  else toast.error(copy.authDenied);
  window.history.replaceState({}, '', window.location.pathname + window.location.hash);
  onSettled?.();
}

const STATUS_CLASSES: Record<string, string> = {
  active: 'bg-green-50 text-green-700 dark:bg-green-900/20 dark:text-green-300 border-green-200 dark:border-green-800',
  pending: 'bg-amber-50 text-amber-700 dark:bg-amber-900/20 dark:text-amber-300 border-amber-200 dark:border-amber-800',
  auth_error: 'bg-red-50 text-red-700 dark:bg-red-900/20 dark:text-red-300 border-red-200 dark:border-red-800',
  sync_error: 'bg-red-50 text-red-700 dark:bg-red-900/20 dark:text-red-300 border-red-200 dark:border-red-800',
  paused: 'bg-muted text-muted-foreground border-border',
};

function formatDateTime(value: string | null | undefined, language: string): string | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toLocaleString(language);
}

function settingEnabled(enabledSyncs: string[], sync: ConnectorSyncDef): boolean {
  return enabledSyncs.includes(sync.settingKey) || enabledSyncs.includes(sync.syncName);
}

function SyncToggles({
  syncs,
  enabled,
  onChange,
  disabled,
}: {
  syncs: ConnectorSyncDef[];
  enabled: string[];
  onChange: (next: string[]) => void;
  disabled?: boolean;
}) {
  const { t } = useI18n();
  const ts = t.weldconnect.connectors.settings;

  const labels: Record<ConnectorSyncDef['settingKey'], { title: string; description: string }> = {
    products: { title: ts.products, description: ts.productsDescription },
    orders: { title: ts.orders, description: ts.ordersDescription },
    customers: { title: ts.customers, description: ts.customersDescription },
    contacts: { title: ts.contacts, description: ts.contactsDescription },
    invoices: { title: ts.invoices, description: ts.invoicesDescription },
    bills: { title: ts.bills, description: ts.billsDescription },
  };

  const uniqueSyncs = [...new Map(syncs.map((sync) => [sync.settingKey, sync])).values()];

  return (
    <div className="space-y-3">
      {uniqueSyncs.map((sync) => {
        const on = settingEnabled(enabled, sync);
        const copy = labels[sync.settingKey];
        return (
          <div key={sync.syncName} className="flex items-start justify-between gap-3 rounded-md border px-3 py-2">
            <div>
              <p className="text-sm font-medium">{copy.title}</p>
              <p className="text-muted-foreground text-xs">{copy.description}</p>
            </div>
            <Switch
              checked={on}
              disabled={disabled}
              onCheckedChange={(checked) => {
                const without = enabled.filter((value) => value !== sync.settingKey && value !== sync.syncName);
                onChange(checked ? [...without, sync.settingKey] : without);
              }}
            />
          </div>
        );
      })}
    </div>
  );
}

interface ConnectDialogProps {
  connector: ConnectorCatalogEntry | null;
  onOpenChange: (open: boolean) => void;
}

function defaultSyncKeys(connector: ConnectorCatalogEntry | null): string[] {
  if (!connector) return ['products', 'orders', 'customers'];
  return [...new Set(connector.syncs.map((sync) => sync.settingKey))];
}

export function ConnectDialog({ connector, onOpenChange }: ConnectDialogProps) {
  const { t } = useI18n();
  const tc = t.weldconnect.connectors;
  const connect = useConnectConnector();
  const authorize = useAuthorizeConnector();
  const test = useTestConnector();
  const [credentials, setCredentials] = useState<Record<string, string>>({});
  const [enabledSyncs, setEnabledSyncs] = useState<string[]>(defaultSyncKeys(connector));

  const fields = connector?.auth.fields ?? [];
  const isAppAuth = connector?.auth.kind === 'app_auth';
  const isOAuth2 = connector?.auth.kind === 'oauth2';
  const busy = connect.isPending || authorize.isPending;

  useEffect(() => {
    if (connector) setEnabledSyncs(defaultSyncKeys(connector));
  }, [connector]);

  const handleOpenChange = (open: boolean) => {
    if (!open) {
      setCredentials({});
      setEnabledSyncs(defaultSyncKeys(connector));
    }
    onOpenChange(open);
  };

  const handleTest = () => {
    if (!connector) return;
    test.mutate(
      { provider: connector.provider, credentials },
      {
        onSuccess: () => toast.success(tc.testSuccess),
        onError: (err) => toast.error(err instanceof Error ? err.message : tc.testFailed),
      },
    );
  };

  const handleConnect = () => {
    if (!connector) return;
    if (isAppAuth) {
      const storeUrl = credentials.storeUrl?.trim();
      if (!storeUrl) {
        toast.error(tc.enterStoreUrl);
        return;
      }
      authorize.mutate(
        {
          provider: 'woocommerce',
          storeUrl,
          enabledSyncs,
          returnUrl: `${window.location.origin}${window.location.pathname}`,
        },
        {
          onSuccess: (result) => {
            const url = result.data.authorizeUrl;
            if (!url) {
              toast.error(tc.connectFailed);
              return;
            }
            window.location.assign(url);
          },
          onError: (err) => toast.error(err instanceof Error ? err.message : tc.connectFailed),
        },
      );
      return;
    }
    if (isOAuth2) {
      authorize.mutate(
        {
          provider: 'moneybird',
          enabledSyncs,
          returnUrl: `${window.location.origin}${window.location.pathname}`,
        },
        {
          onSuccess: (result) => {
            const url = result.data.authorizeUrl;
            if (!url) {
              toast.error(tc.connectFailed);
              return;
            }
            window.location.assign(url);
          },
          onError: (err) => toast.error(err instanceof Error ? err.message : tc.connectFailed),
        },
      );
      return;
    }
    connect.mutate(
      { provider: connector.provider, credentials, enabledSyncs },
      {
        onSuccess: () => {
          toast.success(tc.connected);
          handleOpenChange(false);
        },
        onError: (err) => toast.error(err instanceof Error ? err.message : tc.connectFailed),
      },
    );
  };

  return (
    <Dialog open={Boolean(connector)} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{connector ? `${tc.connect} ${connector.label}` : tc.connect}</DialogTitle>
          <DialogDescription>
            {isOAuth2
              ? tc.settings.connectDescriptionOAuth
              : isAppAuth
                ? tc.settings.connectDescriptionAppAuth
                : tc.settings.connectDescription}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {fields.map((field) => (
            <div key={field.key} className="space-y-1.5">
              <Label htmlFor={`connect-${field.key}`}>{field.label}</Label>
              <Input
                id={`connect-${field.key}`}
                type={field.type === 'secret' ? 'password' : field.type === 'url' ? 'url' : 'text'}
                placeholder={field.placeholder}
                autoComplete="off"
                value={credentials[field.key] ?? ''}
                onChange={(event) => setCredentials((prev) => ({ ...prev, [field.key]: event.target.value }))}
              />
            </div>
          ))}

          <div>
            <h3 className="mb-2 text-sm font-medium">{tc.settings.title}</h3>
            <p className="text-muted-foreground mb-3 text-xs">{tc.settings.description}</p>
            <SyncToggles syncs={connector?.syncs ?? []} enabled={enabledSyncs} onChange={setEnabledSyncs} />
          </div>
        </div>

        <DialogFooter className={isAppAuth || isOAuth2 ? 'gap-2' : 'gap-2 sm:justify-between'}>
          {isAppAuth || isOAuth2 ? null : (
            <Button variant="outline" onClick={handleTest} disabled={test.isPending || busy}>
              {test.isPending ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : null}
              {tc.testConnection}
            </Button>
          )}
          <Button onClick={handleConnect} disabled={busy}>
            {busy ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : null}
            {tc.connect}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

interface ConnectorCardProps {
  connector: ConnectorCatalogEntry;
  onConnect: (connector: ConnectorCatalogEntry) => void;
  onOpenDetails: (connection: ConnectorConnection) => void;
  canConnect: boolean;
}

function ConnectorCard({ connector, onConnect, onOpenDetails, canConnect }: ConnectorCardProps) {
  const { t, language } = useI18n();
  const tc = t.weldconnect.connectors;
  const Icon = getIcon(connector.icon);
  const connections = connector.connections ?? [];
  const live = connections.filter((row) => row.isConnected);
  const primary = live[0] ?? null;
  const status = live.length > 1 ? 'active' : primary?.status ?? null;
  const lastSync = formatDateTime(primary?.lastSyncAt, language);

  return (
    <Card className="flex flex-col border-border/50 transition-shadow duration-200 hover:shadow-md">
      <CardHeader className="pb-3">
        <div className="flex items-start gap-3">
          <div className="bg-muted flex-shrink-0 rounded-lg p-2.5">
            <Icon className="text-foreground/80 h-5 w-5" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-start justify-between gap-2">
              <CardTitle className="text-base leading-snug">{connector.label}</CardTitle>
              {status ? (
                <Badge variant="outline" className={`shrink-0 text-xs ${STATUS_CLASSES[status] ?? ''}`}>
                  {status === 'active' ? (
                    <CheckCircle2 className="mr-1 h-3 w-3" />
                  ) : status === 'auth_error' || status === 'sync_error' ? (
                    <AlertCircle className="mr-1 h-3 w-3" />
                  ) : null}
                  {live.length > 1
                    ? tc.storeCount.replace('{count}', String(live.length))
                    : tc.status[status]}
                </Badge>
              ) : null}
            </div>
            <CardDescription className="mt-1.5 text-sm">{connector.description}</CardDescription>
          </div>
        </div>
      </CardHeader>

      <CardContent className="text-muted-foreground flex-1 space-y-1 pb-3 text-xs">
        <p>
          {tc.syncsLabel}: {connector.syncs.map((s) => s.settingKey).join(', ')}
        </p>
        {live.length === 0 ? (
          <p>{tc.noStores}</p>
        ) : (
          live.map((connection) => (
            <button
              key={connection.id}
              type="button"
              className="hover:text-foreground block w-full truncate text-left"
              onClick={() => onOpenDetails(connection)}
            >
              {connection.displayName || connection.externalAccountId || connection.label}
            </button>
          ))
        )}
        {primary?.isConnected ? (
          <p>
            {tc.lastSync}: {lastSync ?? tc.lastSyncNever}
          </p>
        ) : null}
      </CardContent>

      <CardFooter className="gap-2 pt-0">
        {primary ? (
          <Button variant="outline" size="sm" onClick={() => onOpenDetails(primary)}>
            <Settings className="mr-1.5 h-3.5 w-3.5" />
            {tc.viewDetails}
          </Button>
        ) : null}
        <Button size="sm" disabled={!canConnect} onClick={() => onConnect(connector)}>
          {live.length > 0 ? tc.addStore : tc.connect}
        </Button>
      </CardFooter>
    </Card>
  );
}

export function ConnectorsClient() {
  const { t, format } = useI18n();
  const tc = t.weldconnect.connectors;
  const { canAny, isLoading: permissionsLoading } = usePermissions();
  const canView = canAny('integrations:read', 'weldconnect:integrations:read');
  const canConnect = canAny('integrations:create', 'weldconnect:integrations:create');
  const canManage = canAny('integrations:update', 'weldconnect:integrations:update');

  const [search, setSearch] = useState('');
  const [detailId, setDetailId] = useState<string | null>(null);
  const [pendingConnect, setPendingConnect] = useState<ConnectorCatalogEntry | null>(null);
  const [pendingDisconnect, setPendingDisconnect] = useState<ConnectorConnection | null>(null);

  const queryClient = useQueryClient();
  const { data, isLoading } = useConnectorCatalog();
  const disconnect = useDisconnectConnector();

  useEffect(() => {
    consumeWooCommerceAuthReturn(
      { authReturned: tc.authReturned, authDenied: tc.authDenied },
      () => {
        void queryClient.invalidateQueries({ queryKey: ['connectors'] });
      },
    );
  }, [queryClient, tc.authReturned, tc.authDenied]);

  useBreadcrumbs([
    { label: t.weldconnect.title, href: '/weldconnect' },
    { label: tc.title },
  ]);

  const connectors = data?.data ?? EMPTY_CATALOG;

  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return connectors;
    return connectors.filter(
      (connector) =>
        connector.label.toLowerCase().includes(query) ||
        connector.description.toLowerCase().includes(query) ||
        connector.provider.toLowerCase().includes(query),
    );
  }, [connectors, search]);

  const isSearchEmpty = connectors.length > 0 && filtered.length === 0;
  const isCatalogEmpty = !isLoading && connectors.length === 0;

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

  return (
    <div className="min-h-screen bg-background">
      <div className="container mx-auto max-w-[1600px] space-y-6 px-4 py-6 md:space-y-8 md:p-8">
        <div>
          <h1 className="text-2xl font-bold tracking-tight md:text-3xl">{tc.title}</h1>
          <p className="text-muted-foreground mt-1 text-sm md:text-base">{tc.description}</p>
        </div>

        {!permissionsLoading && !canView ? (
          <div className="flex items-center gap-3 rounded-lg border border-amber-200 bg-amber-50 p-4 dark:border-amber-800 dark:bg-amber-900/10">
            <AlertCircle className="h-5 w-5 shrink-0 text-amber-600" />
            <p className="text-sm text-amber-800 dark:text-amber-200">{t.weldconnect.integrations.permissionDenied}</p>
          </div>
        ) : (
          <>
            <div className="relative max-w-sm">
              <Search className="text-muted-foreground absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2" />
              <Input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder={tc.searchPlaceholder}
                className="pl-9"
              />
            </div>

            {isLoading ? (
              <div className="flex justify-center py-16">
                <Loader2 className="text-muted-foreground h-6 w-6 animate-spin" />
              </div>
            ) : isCatalogEmpty ? (
              <div className="flex flex-col items-center rounded-lg border border-dashed py-16 text-center">
                <ShoppingBag className="text-muted-foreground/40 mb-4 h-12 w-12" />
                <p className="max-w-md text-sm font-medium">{tc.emptyCatalog}</p>
                <p className="text-muted-foreground mt-2 max-w-md text-xs">{tc.emptyCatalogHint}</p>
                <Button variant="outline" size="sm" className="mt-4" asChild>
                  <Link href="/weldconnect/integrations">
                    <LinkIcon className="mr-1.5 h-3.5 w-3.5" />
                    {t.weldconnect.breadcrumbs.integrations}
                  </Link>
                </Button>
              </div>
            ) : isSearchEmpty ? (
              <p className="text-muted-foreground py-16 text-center text-sm">{tc.empty}</p>
            ) : (
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {filtered.map((connector) => (
                  <ConnectorCard
                    key={connector.provider}
                    connector={connector}
                    onConnect={setPendingConnect}
                    onOpenDetails={(connection) => setDetailId(connection.id)}
                    canConnect={canConnect}
                  />
                ))}
              </div>
            )}
          </>
        )}

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
          title={format(tc.disconnectTitle, { name: pendingDisconnect?.label ?? '' })}
          description={tc.disconnectDescription}
          confirmLabel={tc.disconnect}
          variant="destructive"
          loading={disconnect.isPending}
          onConfirm={handleDisconnect}
        />
      </div>
    </div>
  );
}
