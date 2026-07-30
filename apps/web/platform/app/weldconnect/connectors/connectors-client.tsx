import { useEffect, useMemo, useState } from 'react';
import {
  AlertCircle,
  CheckCircle2,
  Cloud,
  Database,
  Loader2,
  Pause,
  Play,
  Plug,
  Receipt,
  RefreshCw,
  Search,
  Link2Off,
} from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { Input } from '@weldsuite/ui/components/input';
import { Label } from '@weldsuite/ui/components/label';
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
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@weldsuite/ui/components/sheet';
import { Separator } from '@weldsuite/ui/components/separator';
import { toast } from 'sonner';
import { useI18n } from '@/lib/i18n/provider';
import { useBreadcrumbs } from '@/contexts/breadcrumb-context';
import { ConfirmDialog } from '@/components/confirm-dialog';
import {
  useConnectWithApiToken,
  useConnectorCatalog,
  useConnectorConnection,
  useConnectorSyncRuns,
  useDisconnectConnector,
  useSetConnectorPaused,
  useStartConnectorOAuth,
  useTriggerConnectorSync,
  type CatalogConnector,
  type ConnectorConnection,
} from '@/hooks/queries/use-connector-queries';

// ---------------------------------------------------------------------------
// Icons — catalog entries carry an icon key, not a component
// ---------------------------------------------------------------------------

const ICON_MAP: Record<string, React.ElementType> = {
  cloud: Cloud,
  database: Database,
  receipt: Receipt,
  plug: Plug,
};

function getIcon(key: string): React.ElementType {
  return ICON_MAP[key] ?? Plug;
}

const EMPTY_CATALOG: CatalogConnector[] = [];

/**
 * Where the provider sends the browser back to.
 *
 * app-api's public callback, not a platform route: the authorization code has to
 * be exchanged server-side with the client secret, so it must never land in the
 * SPA. The callback then redirects here with a result in the query string.
 */
function oauthCallbackUrl(): string {
  const base = import.meta.env.VITE_APP_API_URL ?? '';
  return `${base.replace(/\/+$/, '')}/public/connectors/oauth/callback`;
}

// ---------------------------------------------------------------------------
// Status presentation
// ---------------------------------------------------------------------------

const STATUS_CLASSES: Record<string, string> = {
  active:
    'bg-green-50 text-green-700 dark:bg-green-900/20 dark:text-green-300 border-green-200 dark:border-green-800',
  pending:
    'bg-amber-50 text-amber-700 dark:bg-amber-900/20 dark:text-amber-300 border-amber-200 dark:border-amber-800',
  auth_error:
    'bg-red-50 text-red-700 dark:bg-red-900/20 dark:text-red-300 border-red-200 dark:border-red-800',
  sync_error:
    'bg-red-50 text-red-700 dark:bg-red-900/20 dark:text-red-300 border-red-200 dark:border-red-800',
  paused: 'bg-muted text-muted-foreground border-border',
};

function formatDateTime(value: string | null | undefined, language: string): string | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toLocaleString(language);
}

function isLive(connection: ConnectorConnection | null): boolean {
  return connection !== null && connection.status !== 'pending';
}

// ---------------------------------------------------------------------------
// Connector card
// ---------------------------------------------------------------------------

interface ConnectorCardProps {
  connector: CatalogConnector;
  onConnect: (connector: CatalogConnector) => void;
  onOpenDetails: (connection: ConnectorConnection) => void;
  isConnecting: boolean;
}

function ConnectorCard({ connector, onConnect, onOpenDetails, isConnecting }: ConnectorCardProps) {
  const { t, language } = useI18n();
  const tc = t.weldconnect.connectors;
  const Icon = getIcon(connector.icon);
  const connection = connector.connection;
  const status = connection?.status ?? null;
  const lastSync = formatDateTime(connection?.lastSyncAt, language);

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
                <Badge
                  variant="outline"
                  className={`shrink-0 text-xs ${STATUS_CLASSES[status] ?? ''}`}
                >
                  {status === 'active' ? (
                    <CheckCircle2 className="mr-1 h-3 w-3" />
                  ) : status === 'auth_error' || status === 'sync_error' ? (
                    <AlertCircle className="mr-1 h-3 w-3" />
                  ) : null}
                  {tc.status[status]}
                </Badge>
              ) : null}
            </div>
            <CardDescription className="mt-1.5 text-sm">{connector.description}</CardDescription>
          </div>
        </div>
      </CardHeader>

      <CardContent className="text-muted-foreground flex-1 space-y-1 pb-3 text-xs">
        <p>
          {tc.entitiesLabel}:{' '}
          {connector.entities
            .map((entity) => tc.entities[entity as keyof typeof tc.entities] ?? entity)
            .join(', ')}
        </p>
        {isLive(connection) ? (
          <p>
            {tc.lastSync}: {lastSync ?? tc.lastSyncNever}
          </p>
        ) : null}
        {/* Polling-only connectors sweep on a schedule; say so rather than let
            someone wait for a change to appear instantly. */}
        {!connector.supportsWebhooks ? <p>{tc.scheduledOnly}</p> : null}
        {connection?.lastError ? (
          <p className="text-red-600 dark:text-red-400">{connection.lastError}</p>
        ) : null}
      </CardContent>

      <CardFooter className="gap-2 pt-0">
        {isLive(connection) && connection ? (
          <Button variant="outline" size="sm" onClick={() => onOpenDetails(connection)}>
            {tc.viewDetails}
          </Button>
        ) : null}
        <Button
          size="sm"
          variant={isLive(connection) ? 'ghost' : 'default'}
          disabled={isConnecting}
          onClick={() => onConnect(connector)}
        >
          {isConnecting ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : null}
          {isLive(connection) ? tc.reconnect : tc.connect}
        </Button>
      </CardFooter>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// API token dialog
// ---------------------------------------------------------------------------

interface ApiTokenDialogProps {
  connector: CatalogConnector | null;
  onOpenChange: (open: boolean) => void;
  onConnected: () => void;
}

/**
 * Paste-a-token connect.
 *
 * The submit resolves only once the provider has confirmed the token, so a wrong
 * paste surfaces here rather than as an empty sync hours later.
 */
function ApiTokenDialog({ connector, onOpenChange, onConnected }: ApiTokenDialogProps) {
  const { t } = useI18n();
  const tc = t.weldconnect.connectors;
  const connectWithToken = useConnectWithApiToken();
  const [token, setToken] = useState('');

  // Never leave a credential in component state after the dialog closes.
  useEffect(() => {
    if (!connector) setToken('');
  }, [connector]);

  const handleSubmit = () => {
    if (!connector || token.trim() === '') return;
    connectWithToken.mutate(
      { connectorId: connector.id, apiToken: token.trim() },
      {
        onSuccess: () => {
          setToken('');
          onOpenChange(false);
          onConnected();
          toast.success(tc.connected);
        },
        onError: () => toast.error(tc.apiTokenRejected),
      },
    );
  };

  return (
    <Dialog open={Boolean(connector)} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{tc.apiTokenTitle}</DialogTitle>
          <DialogDescription>{tc.apiTokenDescription}</DialogDescription>
        </DialogHeader>

        <div className="space-y-2">
          <Label htmlFor="connector-api-token">{tc.apiTokenLabel}</Label>
          <Input
            id="connector-api-token"
            type="password"
            autoComplete="off"
            value={token}
            onChange={(event) => setToken(event.target.value)}
            placeholder={tc.apiTokenPlaceholder}
          />
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t.common.actions.cancel}
          </Button>
          <Button
            onClick={handleSubmit}
            disabled={token.trim() === '' || connectWithToken.isPending}
          >
            {connectWithToken.isPending ? (
              <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
            ) : null}
            {tc.connect}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Auth mode chooser
// ---------------------------------------------------------------------------

interface AuthModeDialogProps {
  connector: CatalogConnector | null;
  onOpenChange: (open: boolean) => void;
  onChoose: (connector: CatalogConnector, mode: 'oauth2' | 'api_token') => void;
}

/** Only shown when a connector genuinely offers both. */
function AuthModeDialog({ connector, onOpenChange, onChoose }: AuthModeDialogProps) {
  const { t } = useI18n();
  const tc = t.weldconnect.connectors;

  return (
    <Dialog open={Boolean(connector)} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{tc.chooseAuthTitle}</DialogTitle>
          <DialogDescription>{tc.chooseAuthDescription}</DialogDescription>
        </DialogHeader>

        <div className="space-y-2">
          <Button
            className="w-full justify-start"
            onClick={() => connector && onChoose(connector, 'oauth2')}
          >
            {tc.connectWithOAuth}
          </Button>
          <Button
            variant="outline"
            className="w-full justify-start"
            onClick={() => connector && onChoose(connector, 'api_token')}
          >
            {tc.connectWithApiToken}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Detail panel — run history
// ---------------------------------------------------------------------------

interface ConnectionDetailsProps {
  connectionId: string | null;
  fallbackLabel: string;
  onOpenChange: (open: boolean) => void;
  onDisconnect: (connection: ConnectorConnection) => void;
}

function ConnectionDetails({
  connectionId,
  fallbackLabel,
  onOpenChange,
  onDisconnect,
}: ConnectionDetailsProps) {
  const { t, language, format } = useI18n();
  const tc = t.weldconnect.connectors;
  const { data, isLoading } = useConnectorConnection(connectionId, { pollWhilePending: true });
  const { data: runsData } = useConnectorSyncRuns(connectionId);
  const triggerSync = useTriggerConnectorSync();
  const setPaused = useSetConnectorPaused();

  const connection = data?.data;
  const runs = runsData?.data ?? [];

  const handleSync = (fullResync: boolean) => {
    if (!connectionId) return;
    triggerSync.mutate(
      { connectionId, fullResync },
      {
        onSuccess: (result) => {
          const summaries = result.data ?? [];
          const failed = summaries.filter((s) => s.status === 'error');
          if (failed.length > 0) {
            toast.error(failed[0]?.error ?? tc.syncFailed);
            return;
          }
          const created = summaries.reduce((sum, s) => sum + s.created, 0);
          const modified = summaries.reduce((sum, s) => sum + s.modified, 0);
          toast.success(format(tc.syncFinished, { created, modified }));
        },
        onError: () => toast.error(tc.syncFailed),
      },
    );
  };

  const handlePause = (paused: boolean) => {
    if (!connectionId) return;
    setPaused.mutate(
      { connectionId, paused },
      {
        onSuccess: () => toast.success(paused ? tc.pausedToast : tc.resumedToast),
        onError: () => toast.error(paused ? tc.pauseFailed : tc.resumeFailed),
      },
    );
  };

  return (
    <Sheet open={Boolean(connectionId)} onOpenChange={onOpenChange}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-lg">
        <SheetHeader>
          <SheetTitle>{connection?.displayName ?? fallbackLabel}</SheetTitle>
          <SheetDescription>
            {connection?.connectedAt
              ? format(tc.connectedOn, {
                  date: formatDateTime(connection.connectedAt, language) ?? '',
                })
              : tc.description}
          </SheetDescription>
        </SheetHeader>

        {isLoading || !connection ? (
          <div className="flex justify-center py-10">
            <Loader2 className="text-muted-foreground h-5 w-5 animate-spin" />
          </div>
        ) : (
          <div className="mt-6 space-y-6">
            <div className="flex flex-wrap gap-2">
              <Button size="sm" onClick={() => handleSync(false)} disabled={triggerSync.isPending}>
                {triggerSync.isPending ? (
                  <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                ) : (
                  <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
                )}
                {tc.syncNow}
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => handleSync(true)}
                disabled={triggerSync.isPending}
              >
                {tc.fullResync}
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => handlePause(connection.status !== 'paused')}
                disabled={setPaused.isPending}
              >
                {connection.status === 'paused' ? (
                  <Play className="mr-1.5 h-3.5 w-3.5" />
                ) : (
                  <Pause className="mr-1.5 h-3.5 w-3.5" />
                )}
                {connection.status === 'paused' ? tc.resume : tc.pause}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => onDisconnect(connection)}>
                <Link2Off className="mr-1.5 h-3.5 w-3.5" />
                {tc.disconnect}
              </Button>
            </div>

            {connection.lastError ? (
              <div className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700 dark:border-red-800 dark:bg-red-900/20 dark:text-red-300">
                {connection.lastError}
              </div>
            ) : null}

            <div className="text-muted-foreground space-y-1 text-sm">
              <p>{format(tc.recordsSynced, { count: connection.recordsSynced })}</p>
              {connection.externalAccountId ? (
                <p className="font-mono text-xs">{connection.externalAccountId}</p>
              ) : null}
            </div>

            <Separator />

            <div>
              <h3 className="mb-2 text-sm font-medium">{tc.runs.title}</h3>
              {runs.length === 0 ? (
                <p className="text-muted-foreground text-sm">{tc.runs.empty}</p>
              ) : (
                <ul className="space-y-2">
                  {runs.map((run) => (
                    <li key={run.id} className="rounded-md border px-3 py-2 text-sm">
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-mono text-xs">
                          {tc.entities[run.entityType as keyof typeof tc.entities] ?? run.entityType}
                        </span>
                        <Badge
                          variant="outline"
                          className={`text-xs ${
                            run.status === 'error'
                              ? STATUS_CLASSES.sync_error
                              : run.status === 'success'
                                ? STATUS_CLASSES.active
                                : STATUS_CLASSES.pending
                          }`}
                        >
                          {tc.health[run.status as keyof typeof tc.health] ?? run.status}
                        </Badge>
                      </div>
                      <p className="text-muted-foreground mt-1 text-xs">
                        {run.recordsCreated} {tc.runs.created} · {run.recordsModified}{' '}
                        {tc.runs.updated} · {run.recordsSkipped} {tc.runs.skipped}
                        {run.recordsFailed > 0 ? ` · ${run.recordsFailed} ${tc.runs.failed}` : ''}
                      </p>
                      <p className="text-muted-foreground mt-0.5 text-xs">
                        {formatDateTime(run.startedAt, language)} · {tc.runs.trigger}: {run.trigger}
                      </p>
                      {/* A truncated run is not a failure but it did not finish —
                          without saying so, a partial import looks complete. */}
                      {run.truncated ? (
                        <p className="text-muted-foreground mt-0.5 text-xs">{tc.runs.truncated}</p>
                      ) : null}
                      {run.error ? (
                        <p className="mt-1 text-xs text-red-600 dark:text-red-400">{run.error}</p>
                      ) : null}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export function ConnectorsClient() {
  const { t, format } = useI18n();
  const tc = t.weldconnect.connectors;

  const [search, setSearch] = useState('');
  const [detailId, setDetailId] = useState<string | null>(null);
  const [detailLabel, setDetailLabel] = useState('');
  const [pendingDisconnect, setPendingDisconnect] = useState<ConnectorConnection | null>(null);
  const [authModeFor, setAuthModeFor] = useState<CatalogConnector | null>(null);
  const [apiTokenFor, setApiTokenFor] = useState<CatalogConnector | null>(null);
  const [connectingId, setConnectingId] = useState<string | null>(null);

  const { data, isLoading, refetch } = useConnectorCatalog();
  const disconnect = useDisconnectConnector();
  const startOAuth = useStartConnectorOAuth();

  useBreadcrumbs([{ label: t.weldconnect.title, href: '/weldconnect' }, { label: tc.title }]);

  /**
   * Report the outcome of a returning OAuth redirect.
   *
   * The callback cannot toast — it is a server route — so it puts the result in
   * the query string and this reads it once, then strips it so a refresh does not
   * replay the message.
   */
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const connected = params.get('connectorConnected');
    const failed = params.get('connectorError');
    if (!connected && !failed) return;

    if (connected) {
      toast.success(tc.connected);
      void refetch();
    } else if (failed === 'declined') {
      // The tenant cancelled on the provider's consent screen. Not an error.
      toast.info(tc.connectDeclined);
    } else {
      toast.error(tc.connectFailed);
    }

    params.delete('connectorConnected');
    params.delete('connectorError');
    const query = params.toString();
    window.history.replaceState(
      {},
      '',
      `${window.location.pathname}${query ? `?${query}` : ''}`,
    );
  }, [refetch, tc.connected, tc.connectDeclined, tc.connectFailed]);

  const connectors = data?.data ?? EMPTY_CATALOG;

  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return connectors;
    return connectors.filter(
      (connector) =>
        connector.label.toLowerCase().includes(query) ||
        connector.description.toLowerCase().includes(query) ||
        connector.id.toLowerCase().includes(query),
    );
  }, [connectors, search]);

  const beginOAuth = (connector: CatalogConnector) => {
    setConnectingId(connector.id);
    startOAuth.mutate(
      { connectorId: connector.id, redirectUri: oauthCallbackUrl() },
      {
        // Full-page navigation, not a popup: the code must reach app-api rather
        // than this SPA, and a redirect cannot be blocked the way a popup can.
        onSuccess: (result) => {
          window.location.assign(result.authorizeUrl);
        },
        onError: () => {
          setConnectingId(null);
          toast.error(tc.connectFailed);
        },
      },
    );
  };

  const handleConnect = (connector: CatalogConnector) => {
    const modes = connector.authModes;
    if (modes.length > 1) {
      setAuthModeFor(connector);
      return;
    }
    if (modes[0] === 'api_token') {
      setApiTokenFor(connector);
      return;
    }
    beginOAuth(connector);
  };

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
    <div className="space-y-6 p-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{tc.title}</h1>
        <p className="text-muted-foreground mt-1 text-sm">{tc.description}</p>
      </div>

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
      ) : filtered.length === 0 ? (
        <p className="text-muted-foreground py-16 text-center text-sm">{tc.empty}</p>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {filtered.map((connector) => (
            <ConnectorCard
              key={connector.id}
              connector={connector}
              onConnect={handleConnect}
              onOpenDetails={(connection) => {
                setDetailId(connection.id);
                setDetailLabel(connector.label);
              }}
              isConnecting={connectingId === connector.id}
            />
          ))}
        </div>
      )}

      <AuthModeDialog
        connector={authModeFor}
        onOpenChange={(open) => !open && setAuthModeFor(null)}
        onChoose={(connector, mode) => {
          setAuthModeFor(null);
          if (mode === 'api_token') setApiTokenFor(connector);
          else beginOAuth(connector);
        }}
      />

      <ApiTokenDialog
        connector={apiTokenFor}
        onOpenChange={(open) => !open && setApiTokenFor(null)}
        onConnected={() => void refetch()}
      />

      <ConnectionDetails
        connectionId={detailId}
        fallbackLabel={detailLabel || tc.title}
        onOpenChange={(open) => !open && setDetailId(null)}
        onDisconnect={setPendingDisconnect}
      />

      <ConfirmDialog
        open={Boolean(pendingDisconnect)}
        onOpenChange={(open) => !open && setPendingDisconnect(null)}
        title={format(tc.disconnectTitle, { name: pendingDisconnect?.displayName ?? '' })}
        description={tc.disconnectDescription}
        confirmLabel={tc.disconnect}
        variant="destructive"
        loading={disconnect.isPending}
        onConfirm={handleDisconnect}
      />
    </div>
  );
}
