import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertCircle,
  CheckCircle2,
  Cloud,
  Database,
  Loader2,
  Pause,
  Play,
  Plug,
  RefreshCw,
  Search,
  Link2Off,
} from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { Input } from '@weldsuite/ui/components/input';
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
  useCreateNangoConnectSession,
  useDisconnectNangoConnection,
  useFinalizeNangoConnection,
  useNangoCatalog,
  useNangoConnection,
  useNangoSyncRuns,
  useSetNangoConnectionPaused,
  useTriggerNangoSync,
  type NangoConnection,
  type NangoConnector,
} from '@/hooks/queries/use-nango-queries';

// ---------------------------------------------------------------------------
// Icons — catalog entries carry an icon key, not a component
// ---------------------------------------------------------------------------

const ICON_MAP: Record<string, React.ElementType> = {
  cloud: Cloud,
  database: Database,
  plug: Plug,
};

function getIcon(key: string): React.ElementType {
  return ICON_MAP[key] ?? Plug;
}

const EMPTY_CATALOG: NangoConnector[] = [];

// ---------------------------------------------------------------------------
// Status presentation
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Connect flow
// ---------------------------------------------------------------------------

/** How long to wait for the auth webhook before giving up on the popup. */
const CONNECT_POLL_TIMEOUT_MS = 3 * 60 * 1000;
const CONNECT_POLL_INTERVAL_MS = 3000;

/**
 * Drives the hosted Nango Connect UI.
 *
 * The authorisation happens in a popup on Nango's domain, so completion
 * reaches us two ways: a `postMessage` from the Connect UI (fast path, calls
 * finalize) and the auth webhook landing server-side (authoritative). We poll
 * the catalog until one of them makes the connection live, which means a
 * blocked postMessage or a closed popup still resolves correctly.
 */
function useConnectFlow(onSettled: () => void) {
  const createSession = useCreateNangoConnectSession();
  const finalize = useFinalizeNangoConnection();
  const [connecting, setConnecting] = useState<string | null>(null);
  const pendingRef = useRef<{
    connectionId: string;
    providerConfigKey: string;
    /** Origin of the Connect UI — the only sender we accept a connection id from. */
    origin: string;
  } | null>(null);

  // Fast path — the Connect UI reports the new connection id.
  useEffect(() => {
    function onMessage(event: MessageEvent) {
      const pending = pendingRef.current;
      if (!pending) return;
      // Any page can postMessage to this window. Without this check a hostile
      // tab could hand us a connection id during a pending connect and have the
      // server bind it to this workspace. Derived from the session URL rather
      // than hardcoded, because NANGO_CONNECT_URL moves when Nango is self-hosted.
      if (event.origin !== pending.origin) return;
      const data = event.data as { connectionId?: string; payload?: { connectionId?: string } } | null;
      const nangoConnectionId = data?.connectionId ?? data?.payload?.connectionId;
      if (typeof nangoConnectionId !== 'string' || !nangoConnectionId) return;

      finalize.mutate(
        { connectionId: pending.connectionId, nangoConnectionId },
        // The poll below is the authoritative path; a failure here is not
        // fatal, the auth webhook still activates the connection.
        { onError: () => undefined },
      );
    }

    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [finalize]);

  const connect = useCallback(
    async (providerConfigKey: string, onPoll: () => Promise<boolean>) => {
      setConnecting(providerConfigKey);
      try {
        const session = await createSession.mutateAsync(providerConfigKey);
        pendingRef.current = {
          connectionId: session.connectionId,
          providerConfigKey,
          origin: new URL(session.connectUrl).origin,
        };

        const popup = window.open(session.connectUrl, 'nango-connect', 'width=520,height=720');
        if (!popup) {
          setConnecting(null);
          pendingRef.current = null;
          return { ok: false, reason: 'popup_blocked' as const };
        }

        const deadline = Date.now() + CONNECT_POLL_TIMEOUT_MS;
        while (Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, CONNECT_POLL_INTERVAL_MS));
          if (await onPoll()) {
            popup.close();
            return { ok: true as const };
          }
          if (popup.closed) {
            // One more check after the user closes the window — the webhook
            // may still be in flight.
            await new Promise((resolve) => setTimeout(resolve, CONNECT_POLL_INTERVAL_MS));
            return { ok: await onPoll() };
          }
        }
        return { ok: false, reason: 'timeout' as const };
      } catch (err) {
        // Without this the rejection escapes into a synchronous onClick and
        // becomes an unhandled promise rejection — the spinner clears and the
        // user is told nothing. Reported as a result so the caller can toast.
        console.error('[connectors] connect failed:', err);
        return { ok: false, reason: 'error' as const };
      } finally {
        setConnecting(null);
        pendingRef.current = null;
        onSettled();
      }
    },
    [createSession, onSettled],
  );

  return { connect, connecting };
}

// ---------------------------------------------------------------------------
// Connector card
// ---------------------------------------------------------------------------

interface ConnectorCardProps {
  connector: NangoConnector;
  onConnect: (providerConfigKey: string) => void;
  onOpenDetails: (connection: NangoConnection) => void;
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
                <Badge variant="outline" className={`shrink-0 text-xs ${STATUS_CLASSES[status] ?? ''}`}>
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
          {tc.syncsLabel}: {connector.syncs.map((s) => s.model).join(', ')}
        </p>
        {connection?.isConnected ? (
          <p>
            {tc.lastSync}: {lastSync ?? tc.lastSyncNever}
          </p>
        ) : null}
        {connection?.lastError ? (
          <p className="text-red-600 dark:text-red-400">{connection.lastError}</p>
        ) : null}
      </CardContent>

      <CardFooter className="gap-2 pt-0">
        {connection?.isConnected ? (
          <Button variant="outline" size="sm" onClick={() => onOpenDetails(connection)}>
            {tc.viewDetails}
          </Button>
        ) : null}
        <Button
          size="sm"
          variant={connection?.isConnected ? 'ghost' : 'default'}
          disabled={isConnecting}
          onClick={() => onConnect(connector.providerConfigKey)}
        >
          {isConnecting ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : null}
          {connection?.isConnected ? tc.reconnect : tc.connect}
        </Button>
      </CardFooter>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Detail panel — sync health + run history
// ---------------------------------------------------------------------------

interface ConnectionDetailsProps {
  connectionId: string | null;
  onOpenChange: (open: boolean) => void;
  onDisconnect: (connection: NangoConnection) => void;
}

function ConnectionDetails({ connectionId, onOpenChange, onDisconnect }: ConnectionDetailsProps) {
  const { t, language, format } = useI18n();
  const tc = t.weldconnect.connectors;
  const { data, isLoading } = useNangoConnection(connectionId, { pollWhileRunning: true });
  const { data: runsData } = useNangoSyncRuns(connectionId);
  const triggerSync = useTriggerNangoSync();
  const setPaused = useSetNangoConnectionPaused();

  const connection = data?.data;
  const runs = runsData?.data ?? [];

  const handleSync = (full: boolean) => {
    if (!connectionId) return;
    triggerSync.mutate(
      { connectionId, full },
      {
        onSuccess: () => toast.success(tc.syncStarted),
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
          <SheetTitle>{connection?.label ?? tc.title}</SheetTitle>
          <SheetDescription>
            {connection?.connectedAt
              ? format(tc.connectedOn, { date: formatDateTime(connection.connectedAt, language) ?? '' })
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
                <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
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

            <div>
              <h3 className="mb-2 text-sm font-medium">{tc.health.title}</h3>
              {connection.syncs.length === 0 ? (
                <p className="text-muted-foreground text-sm">{tc.health.empty}</p>
              ) : (
                <ul className="space-y-2">
                  {connection.syncs.map((sync) => (
                    <li
                      key={sync.name}
                      className="flex items-center justify-between rounded-md border px-3 py-2 text-sm"
                    >
                      <span className="font-mono text-xs">{sync.name}</span>
                      <span className="text-muted-foreground text-xs">
                        {sync.status}
                        {sync.finishedAt
                          ? ` · ${formatDateTime(sync.finishedAt, language)}`
                          : ''}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
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
                        <span className="font-mono text-xs">{run.model}</span>
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
                        {run.recordsCreated} {tc.runs.created} · {run.recordsModified} {tc.runs.updated} ·{' '}
                        {run.recordsSkipped} {tc.runs.skipped}
                        {run.recordsFailed > 0 ? ` · ${run.recordsFailed} ${tc.runs.failed}` : ''}
                      </p>
                      <p className="text-muted-foreground mt-0.5 text-xs">
                        {formatDateTime(run.startedAt, language)} · {tc.runs.trigger}: {run.trigger}
                      </p>
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
  const [pendingDisconnect, setPendingDisconnect] = useState<NangoConnection | null>(null);

  const { data, isLoading, refetch } = useNangoCatalog();
  const disconnect = useDisconnectNangoConnection();
  const { connect, connecting } = useConnectFlow(() => {
    void refetch();
  });

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

  const handleConnect = async (providerConfigKey: string) => {
    const result = await connect(providerConfigKey, async () => {
      const fresh = await refetch();
      return Boolean(
        fresh.data?.data.find((c) => c.providerConfigKey === providerConfigKey)?.connection?.isConnected,
      );
    });

    if (result.ok) {
      toast.success(tc.connected);
    } else if (result.reason === 'popup_blocked') {
      toast.error(tc.connectWindowBlocked);
    } else if (result.reason === 'error') {
      toast.error(tc.connectFailed);
    }
    // A timeout is not an error worth shouting about — the auth webhook may
    // still land, and the card reflects the truth on the next refetch.
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
              key={connector.providerConfigKey}
              connector={connector}
              onConnect={handleConnect}
              onOpenDetails={(connection) => setDetailId(connection.id)}
              isConnecting={connecting === connector.providerConfigKey}
            />
          ))}
        </div>
      )}

      <ConnectionDetails
        connectionId={detailId}
        onOpenChange={(open) => !open && setDetailId(null)}
        onDisconnect={setPendingDisconnect}
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
  );
}
