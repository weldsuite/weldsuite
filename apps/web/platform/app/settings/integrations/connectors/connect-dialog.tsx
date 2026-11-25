import { useState, useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ChevronRight, Loader2 } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { Input } from '@weldsuite/ui/components/input';
import { Label } from '@weldsuite/ui/components/label';
import { Switch } from '@weldsuite/ui/components/switch';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@weldsuite/ui/components/collapsible';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@weldsuite/ui/components/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@weldsuite/ui/components/select';
import { toast } from 'sonner';
import { useI18n } from '@/lib/i18n/provider';
import { cn } from '@/lib/utils';
import { useWorkspaceId } from '@/contexts/workspace-context';
import { useCurrentAccountingEntity } from '@/hooks/use-current-accounting-entity';
import { useWorkspaceUrl } from '@/hooks/use-workspace-url';
import { accountingEntitiesQueryKey } from '@/hooks/use-current-entity-currency';
import { weldbooksApi } from '@/lib/api/weldbooks-client';
import {
  useAuthorizeConnector,
  useConnectConnector,
  useTestConnector,
  type ConnectorCatalogEntry,
  type ConnectorSyncDef,
} from '@/hooks/queries/use-connector-queries';
import { markOAuthFlow } from '@/lib/integrations-oauth-flow';

export { ConnectionDetails } from './connection-details';

function fieldInputType(fieldType: string): 'password' | 'url' | 'text' {
  if (fieldType === 'secret') return 'password';
  if (fieldType === 'url') return 'url';
  return 'text';
}

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

function settingEnabled(enabledSyncs: string[], sync: ConnectorSyncDef): boolean {
  return enabledSyncs.includes(sync.settingKey) || enabledSyncs.includes(sync.syncName);
}

function SyncToggles({
  syncs,
  enabled,
  onChange,
  disabled,
}: Readonly<{
  syncs: ConnectorSyncDef[];
  enabled: string[];
  onChange: (next: string[]) => void;
  disabled?: boolean;
}>) {
  const { t } = useI18n();
  const ts = t.settings.integrations.connectors.settings;

  const labels: Record<string, { title: string; description: string }> = {
    products: { title: ts.products, description: ts.productsDescription },
    orders: { title: ts.orders, description: ts.ordersDescription },
    customers: { title: ts.customers, description: ts.customersDescription },
    contacts: { title: ts.contacts, description: ts.contactsDescription },
    invoices: { title: ts.invoices, description: ts.invoicesDescription },
    bills: { title: ts.bills, description: ts.billsDescription },
    bankAccounts: { title: ts.bankAccounts, description: ts.bankAccountsDescription },
    bankTransactions: { title: ts.bankTransactions, description: ts.bankTransactionsDescription },
    inventory: { title: ts.inventory, description: ts.inventoryDescription },
    warehouses: { title: ts.warehouses, description: ts.warehousesDescription },
    locations: { title: ts.locations, description: ts.locationsDescription },
    picklists: { title: ts.picklists, description: ts.picklistsDescription },
    shipments: { title: ts.shipments, description: ts.shipmentsDescription },
    suppliers: { title: ts.suppliers, description: ts.suppliersDescription },
    purchaseOrders: { title: ts.purchaseOrders, description: ts.purchaseOrdersDescription },
    returns: { title: ts.returns, description: ts.returnsDescription },
    stockCounts: { title: ts.stockCounts, description: ts.stockCountsDescription },
    movements: { title: ts.movements, description: ts.movementsDescription },
    productSuppliers: { title: ts.productSuppliers, description: ts.productSuppliersDescription },
    sales: { title: ts.sales, description: ts.salesDescription },
  };

  const uniqueSyncs = [...new Map(syncs.map((sync) => [sync.settingKey, sync])).values()];

  return (
    <div className="space-y-3">
      {uniqueSyncs.map((sync) => {
        const on = settingEnabled(enabled, sync);
        const copy = labels[sync.settingKey] ?? {
          title: sync.settingKey,
          description: '',
        };
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

interface AccountingEntityOption {
  id: string;
  name: string;
  isDefault?: boolean | null;
  isActive?: boolean | null;
}

function useAccountingEntityOptions() {
  const workspaceId = useWorkspaceId();
  const { entityId: currentEntityId } = useCurrentAccountingEntity();
  const { data: entities = [] } = useQuery<AccountingEntityOption[]>({
    queryKey: accountingEntitiesQueryKey(workspaceId),
    queryFn: async () => {
      const res = await weldbooksApi.get<{ data: AccountingEntityOption[] } | AccountingEntityOption[]>(
        '/accounting-entities',
      );
      return Array.isArray(res) ? res : res.data ?? [];
    },
  });
  const active = entities.filter((entity) => entity.isActive !== false);
  return { entities: active, currentEntityId };
}

function defaultSyncKeys(connector: ConnectorCatalogEntry | null): string[] {
  if (!connector) return ['products', 'orders', 'customers'];
  return [...new Set(connector.syncs.map((sync) => sync.settingKey))];
}

function defaultImportStartDate(): string {
  return `${new Date().getFullYear()}-01-01`;
}

type ConnectorsTranslations = ReturnType<typeof useI18n>['t']['settings']['integrations']['connectors'];

/** Stripe's button says where it goes; the others just "Connect". */
function connectButtonLabel(tc: ConnectorsTranslations, connector: ConnectorCatalogEntry | null): string {
  return connector?.provider === 'stripe' ? tc.connectWithStripe : tc.connect;
}

/** Accounting connectors import into a WeldBooks entity. */
const ENTITY_PROVIDERS = new Set(['moneybird', 'stripe']);

/**
 * Send the browser to the provider's grant screen (WooCommerce, Moneybird,
 * Stripe). Moneybird and Stripe return to `/settings/integrations/callback`,
 * which reads the flow recorded here to know it is a connector's.
 */
function authorizeRedirectCallbacks(tc: ConnectorsTranslations) {
  return {
    onSuccess: (result: { data: { authorizeUrl?: string } }) => {
      const url = result.data.authorizeUrl;
      if (!url) {
        toast.error(tc.connectFailed);
        return;
      }
      markOAuthFlow({ kind: 'connector', returnTo: window.location.pathname });
      window.location.assign(url);
    },
    onError: (err: unknown) => toast.error(err instanceof Error ? err.message : tc.connectFailed),
  };
}

interface StripeImportStartFieldProps {
  tc: ConnectorsTranslations;
  value: string;
  onChange: (value: string) => void;
}

/** Stripe's import start date, and what "Connect with Stripe" will ask for. */
function StripeImportStartField({ tc, value, onChange }: Readonly<StripeImportStartFieldProps>) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor="connect-import-start-date">{tc.settings.importStartDateLabel}</Label>
      <p className="text-muted-foreground text-xs">{tc.settings.importStartDateDescription}</p>
      <Input
        id="connect-import-start-date"
        type="date"
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
      <p className="text-muted-foreground pt-1 text-xs">{tc.settings.stripeFullAccessNote}</p>
    </div>
  );
}

interface StripeApiKeySectionProps {
  tc: ConnectorsTranslations;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  apiKey: string;
  onApiKeyChange: (value: string) => void;
  onConnect: () => void;
  pending: boolean;
  blocked: boolean;
}

/** "Advanced: connect with an API key", for Stripe accounts OAuth can't reach. */
function StripeApiKeySection({
  tc,
  open,
  onOpenChange,
  apiKey,
  onApiKeyChange,
  onConnect,
  pending,
  blocked,
}: Readonly<StripeApiKeySectionProps>) {
  return (
    <Collapsible open={open} onOpenChange={onOpenChange}>
      <CollapsibleTrigger asChild>
        <Button type="button" variant="ghost" size="sm" className="text-muted-foreground -ml-2 gap-1.5">
          <ChevronRight className={cn('h-3.5 w-3.5 transition-transform', open && 'rotate-90')} />
          {tc.settings.stripeApiKeyToggle}
        </Button>
      </CollapsibleTrigger>
      <CollapsibleContent className="space-y-3 pt-3">
        <p className="text-muted-foreground text-xs">{tc.settings.stripeApiKeyHint}</p>
        <div className="space-y-1.5">
          <Label htmlFor="connect-stripe-api-key">{tc.settings.stripeApiKeyLabel}</Label>
          <Input
            id="connect-stripe-api-key"
            type="password"
            autoComplete="off"
            placeholder={tc.settings.stripeApiKeyPlaceholder}
            value={apiKey}
            onChange={(event) => onApiKeyChange(event.target.value)}
          />
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={onConnect}
          disabled={pending || !apiKey.trim() || blocked}
        >
          {pending ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : null}
          {tc.settings.stripeApiKeyConnect}
        </Button>
      </CollapsibleContent>
    </Collapsible>
  );
}

export function ConnectDialog({ connector, onOpenChange }: Readonly<ConnectDialogProps>) {
  const { t } = useI18n();
  const tc = t.settings.integrations.connectors;
  const connect = useConnectConnector();
  const authorize = useAuthorizeConnector();
  const test = useTestConnector();
  const workspaceUrl = useWorkspaceUrl();
  const [credentials, setCredentials] = useState<Record<string, string>>({});
  const [enabledSyncs, setEnabledSyncs] = useState<string[]>(defaultSyncKeys(connector));
  const { entities, currentEntityId } = useAccountingEntityOptions();
  const [entityId, setEntityId] = useState<string>('');
  const [importStartDate, setImportStartDate] = useState<string>(defaultImportStartDate());
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [apiKey, setApiKey] = useState('');

  const fields = connector?.auth.fields ?? [];
  const isAppAuth = connector?.auth.kind === 'app_auth';
  const isOAuth2 = connector?.auth.kind === 'oauth2';
  const isStripe = connector?.provider === 'stripe';
  const needsEntity = ENTITY_PROVIDERS.has(connector?.provider ?? '');
  const entityBlocked = needsEntity && (!entityId || entities.length === 0);
  const startDateMissing = isStripe && !importStartDate;
  const busy = connect.isPending || authorize.isPending;
  let connectDescription = tc.settings.connectDescription;
  if (isOAuth2) connectDescription = tc.settings.connectDescriptionOAuth;
  else if (isAppAuth) connectDescription = tc.settings.connectDescriptionAppAuth;

  useEffect(() => {
    if (connector) setEnabledSyncs(defaultSyncKeys(connector));
  }, [connector]);

  useEffect(() => {
    if (!needsEntity) {
      setEntityId('');
      return;
    }
    const preferred =
      (currentEntityId && entities.some((entity) => entity.id === currentEntityId) ? currentEntityId : null)
      ?? entities.find((entity) => entity.isDefault)?.id
      ?? entities[0]?.id
      ?? '';
    setEntityId(preferred);
  }, [needsEntity, entities, currentEntityId, connector?.provider]);

  const handleOpenChange = (open: boolean) => {
    if (!open) {
      setCredentials({});
      setEnabledSyncs(defaultSyncKeys(connector));
      setEntityId('');
      setImportStartDate(defaultImportStartDate());
      setAdvancedOpen(false);
      setApiKey('');
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

  /** The entity (and for Stripe the start date) a connect needs; toasts and returns false when missing. */
  const readyToConnect = (): boolean => {
    if (needsEntity && !entityId) {
      toast.error(entities.length === 0 ? tc.settings.entityMissing : tc.settings.entityRequired);
      return false;
    }
    if (startDateMissing) {
      toast.error(tc.settings.importStartDateRequired);
      return false;
    }
    return true;
  };

  const handleStripeApiKeyConnect = () => {
    if (!connector || !readyToConnect()) return;
    const trimmedKey = apiKey.trim();
    if (!trimmedKey) {
      toast.error(tc.settings.stripeApiKeyRequired);
      return;
    }
    connect.mutate(
      {
        provider: 'stripe',
        credentials: { apiKey: trimmedKey },
        enabledSyncs,
        entityId,
        settings: { importStartDate },
      },
      {
        onSuccess: () => {
          toast.success(tc.connected);
          handleOpenChange(false);
        },
        onError: (err) => toast.error(err instanceof Error ? err.message : tc.connectFailed),
      },
    );
  };

  const handleConnect = () => {
    if (!connector || !readyToConnect()) return;
    const returnUrl = workspaceUrl(window.location.pathname);
    if (isAppAuth) {
      const storeUrl = credentials.storeUrl?.trim();
      if (!storeUrl) {
        toast.error(tc.enterStoreUrl);
        return;
      }
      authorize.mutate({ provider: 'woocommerce', storeUrl, enabledSyncs, returnUrl }, authorizeRedirectCallbacks(tc));
      return;
    }
    if (isOAuth2) {
      authorize.mutate(
        {
          provider: connector.provider as 'moneybird' | 'stripe',
          enabledSyncs,
          entityId,
          ...(isStripe ? { importStartDate } : {}),
          returnUrl,
        },
        authorizeRedirectCallbacks(tc),
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
            {connectDescription}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {fields.map((field) => (
            <div key={field.key} className="space-y-1.5">
              <Label htmlFor={`connect-${field.key}`}>{field.label}</Label>
              <Input
                id={`connect-${field.key}`}
                type={fieldInputType(field.type)}
                placeholder={field.placeholder}
                autoComplete="off"
                value={credentials[field.key] ?? ''}
                onChange={(event) => setCredentials((prev) => ({ ...prev, [field.key]: event.target.value }))}
              />
            </div>
          ))}

          {needsEntity ? (
            <div className="space-y-1.5">
              <Label htmlFor="connect-entity">{tc.settings.entityLabel}</Label>
              <p className="text-muted-foreground text-xs">{tc.settings.entityDescription}</p>
              {entities.length === 0 ? (
                <p className="text-destructive text-xs">{tc.settings.entityMissing}</p>
              ) : (
                <Select value={entityId} onValueChange={setEntityId}>
                  <SelectTrigger id="connect-entity">
                    <SelectValue placeholder={tc.settings.entityPlaceholder} />
                  </SelectTrigger>
                  <SelectContent>
                    {entities.map((entity) => (
                      <SelectItem key={entity.id} value={entity.id}>
                        {entity.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </div>
          ) : null}

          {isStripe ? <StripeImportStartField tc={tc} value={importStartDate} onChange={setImportStartDate} /> : null}

          <div>
            <h3 className="mb-2 text-sm font-medium">{tc.settings.title}</h3>
            <p className="text-muted-foreground mb-3 text-xs">{tc.settings.description}</p>
            <SyncToggles syncs={connector?.syncs ?? []} enabled={enabledSyncs} onChange={setEnabledSyncs} />
          </div>

          {isStripe ? (
            <StripeApiKeySection
              tc={tc}
              open={advancedOpen}
              onOpenChange={setAdvancedOpen}
              apiKey={apiKey}
              onApiKeyChange={setApiKey}
              onConnect={handleStripeApiKeyConnect}
              pending={connect.isPending}
              blocked={entityBlocked}
            />
          ) : null}
        </div>

        <DialogFooter className={isAppAuth || isOAuth2 ? 'gap-2' : 'gap-2 sm:justify-between'}>
          {isAppAuth || isOAuth2 ? null : (
            <Button variant="outline" onClick={handleTest} disabled={test.isPending || busy}>
              {test.isPending ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : null}
              {tc.testConnection}
            </Button>
          )}
          <Button
            onClick={handleConnect}
            disabled={busy || entityBlocked || startDateMissing}
          >
            {busy ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : null}
            {connectButtonLabel(tc, connector)}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
