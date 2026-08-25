import { useState } from 'react';
import {
  EllipsisVertical,
  Link2Off,
  Loader2,
  Pause,
  Play,
  RefreshCw,
} from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { Badge } from '@weldsuite/ui/components/badge';
import { Switch } from '@weldsuite/ui/components/switch';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@weldsuite/ui/components/sheet';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@weldsuite/ui/components/tabs';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@weldsuite/ui/components/dropdown-menu';
import { toast } from 'sonner';
import { useI18n } from '@/lib/i18n/provider';
import {
  useConnectorConnection,
  useConnectorRecords,
  useConnectorSyncRuns,
  useSetConnectorPaused,
  useTriggerConnectorSync,
  useUpdateConnector,
  type ConnectorConnection,
  type ConnectorSyncDef,
  type ConnectorSyncedRecord,
  type ConnectorSyncRun,
} from '@/hooks/queries/use-connector-queries';

const STATUS_CLASSES: Record<string, string> = {
  active: 'bg-green-50 text-green-700 dark:bg-green-900/20 dark:text-green-300 border-green-200 dark:border-green-800',
  pending: 'bg-amber-50 text-amber-700 dark:bg-amber-900/20 dark:text-amber-300 border-amber-200 dark:border-amber-800',
  auth_error: 'bg-red-50 text-red-700 dark:bg-red-900/20 dark:text-red-300 border-red-200 dark:border-red-800',
  sync_error: 'bg-red-50 text-red-700 dark:bg-red-900/20 dark:text-red-300 border-red-200 dark:border-red-800',
  paused: 'bg-muted text-muted-foreground border-border',
  success: 'bg-green-50 text-green-700 dark:bg-green-900/20 dark:text-green-300 border-green-200 dark:border-green-800',
  error: 'bg-red-50 text-red-700 dark:bg-red-900/20 dark:text-red-300 border-red-200 dark:border-red-800',
  partial: 'bg-amber-50 text-amber-700 dark:bg-amber-900/20 dark:text-amber-300 border-amber-200 dark:border-amber-800',
  running: 'bg-blue-50 text-blue-700 dark:bg-blue-900/20 dark:text-blue-300 border-blue-200 dark:border-blue-800',
};

function settingEnabled(enabledSyncs: string[], sync: ConnectorSyncDef): boolean {
  return enabledSyncs.includes(sync.settingKey) || enabledSyncs.includes(sync.syncName);
}

function relativeTime(value: string | null | undefined, language: string): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const deltaSec = Math.round((date.getTime() - Date.now()) / 1000);
  const abs = Math.abs(deltaSec);
  const rtf = new Intl.RelativeTimeFormat(language, { numeric: 'auto' });
  if (abs < 60) return rtf.format(deltaSec, 'second');
  const minutes = Math.round(deltaSec / 60);
  if (Math.abs(minutes) < 60) return rtf.format(minutes, 'minute');
  const hours = Math.round(minutes / 60);
  if (Math.abs(hours) < 24) return rtf.format(hours, 'hour');
  return rtf.format(Math.round(hours / 24), 'day');
}

type RecordTypeKey = 'contacts' | 'invoices' | 'products' | 'bills' | 'receipts' | 'orders' | 'customers';

function recordTypeKey(record: ConnectorSyncedRecord): RecordTypeKey {
  const external = record.externalEntityType;
  if (external.includes('receipt')) return 'receipts';
  if (external.includes('invoice') && (external.includes('purchase') || external.includes('bill'))) return 'bills';
  if (external.includes('sales_invoice') || external.includes('invoice')) return 'invoices';
  if (external.includes('product')) return 'products';
  if (external.includes('order')) return 'orders';
  if (external.includes('customer')) return 'customers';
  if (external.includes('contact') || record.internalEntityType === 'party' || record.internalEntityType === 'person') {
    return 'contacts';
  }
  if (record.internalEntityType === 'bill') return 'bills';
  if (record.internalEntityType === 'invoice') return 'invoices';
  if (record.internalEntityType === 'product') return 'products';
  if (record.internalEntityType === 'order') return 'orders';
  return 'contacts';
}

function runLabel(run: ConnectorSyncRun, connection: ConnectorConnection, t: ReturnType<typeof useI18n>['t']): string {
  const tc = t.weldconnect.connectors;
  if (run.syncName.includes('receipt')) return tc.types.receipts;
  const sync = connection.syncs.find((item) => item.syncName === run.syncName || item.model === run.model);
  if (sync) return tc.settings[sync.settingKey];
  return run.model.replace(/^(Moneybird|Shopify|WooCommerce)/, '').replace(/([A-Z])/g, ' $1').trim();
}

function triggerLabel(trigger: string, t: ReturnType<typeof useI18n>['t']): string {
  const labels = t.weldconnect.connectors.runs;
  if (trigger === 'initial') return labels.initial;
  if (trigger === 'manual') return labels.manual;
  if (trigger === 'webhook') return labels.webhook;
  if (trigger === 'schedule') return labels.schedule;
  return trigger;
}

interface ConnectionDetailsProps {
  connectionId: string | null;
  onOpenChange: (open: boolean) => void;
  onDisconnect: (connection: ConnectorConnection) => void;
  canManage: boolean;
}

export function ConnectionDetails({ connectionId, onOpenChange, onDisconnect, canManage }: ConnectionDetailsProps) {
  const { t, language, format } = useI18n();
  const tc = t.weldconnect.connectors;
  const { data, isLoading } = useConnectorConnection(connectionId, { pollWhileRunning: true });
  const running = data?.data?.lastSyncStatus === 'running';
  const { data: runsData } = useConnectorSyncRuns(connectionId, { pollWhileRunning: running });
  const { data: recordsData } = useConnectorRecords(connectionId, { pollWhileRunning: running });
  const triggerSync = useTriggerConnectorSync();
  const setPaused = useSetConnectorPaused();
  const update = useUpdateConnector();

  const connection = data?.data;
  const runs = runsData?.data ?? [];
  const records = recordsData?.data ?? [];
  const [enabledSyncs, setEnabledSyncs] = useState<string[] | null>(null);
  const currentSyncs = enabledSyncs ?? connection?.enabledSyncs ?? [];

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

  const handleSaveSettings = () => {
    if (!connectionId) return;
    update.mutate(
      { connectionId, enabledSyncs: currentSyncs },
      {
        onSuccess: () => {
          toast.success(tc.settings.saved);
          setEnabledSyncs(null);
        },
        onError: () => toast.error(tc.settings.saveFailed),
      },
    );
  };

  const lastSync = relativeTime(connection?.lastSyncAt, language);
  const types = t.weldconnect.connectors.types;

  return (
    <Sheet
      open={Boolean(connectionId)}
      onOpenChange={(open) => {
        if (!open) setEnabledSyncs(null);
        onOpenChange(open);
      }}
    >
      <SheetContent className="flex w-full flex-col gap-0 overflow-hidden p-0 sm:max-w-xl">
        <SheetHeader className="space-y-1 border-b p-6 pr-12">
          <div className="flex items-center gap-2">
            <SheetTitle className="truncate text-base font-semibold">
              {connection?.displayName ?? connection?.label ?? tc.title}
            </SheetTitle>
            {connection ? (
              <Badge variant="outline" className={`shrink-0 text-[11px] ${STATUS_CLASSES[connection.status] ?? ''}`}>
                {tc.status[connection.status] ?? connection.status}
              </Badge>
            ) : null}
          </div>
          <SheetDescription className="text-muted-foreground text-xs">
            {[
              connection?.externalAccountId,
              format(tc.recordsSynced, { count: connection?.recordsSynced ?? 0 }),
              lastSync ? `${tc.lastSync} ${lastSync}` : tc.lastSyncNever,
            ]
              .filter(Boolean)
              .join(' · ')}
          </SheetDescription>
        </SheetHeader>

        {isLoading || !connection ? (
          <div className="flex flex-1 items-center justify-center py-16">
            <Loader2 className="text-muted-foreground h-5 w-5 animate-spin" />
          </div>
        ) : (
          <>
            <div className="flex items-center gap-2 border-b px-6 py-3">
              <Button size="sm" onClick={() => handleSync(false)} disabled={triggerSync.isPending || !canManage}>
                {triggerSync.isPending ? (
                  <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                ) : (
                  <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
                )}
                {tc.syncNow}
              </Button>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button size="sm" variant="outline" disabled={!canManage} aria-label={tc.moreActions}>
                    <EllipsisVertical className="h-4 w-4" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start">
                  <DropdownMenuItem onClick={() => handleSync(true)} disabled={triggerSync.isPending}>
                    <RefreshCw className="mr-2 h-3.5 w-3.5" />
                    {tc.fullResync}
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => handlePause(connection.status !== 'paused')} disabled={setPaused.isPending}>
                    {connection.status === 'paused' ? (
                      <Play className="mr-2 h-3.5 w-3.5" />
                    ) : (
                      <Pause className="mr-2 h-3.5 w-3.5" />
                    )}
                    {connection.status === 'paused' ? tc.resume : tc.pause}
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    className="text-destructive focus:text-destructive"
                    onClick={() => onDisconnect(connection)}
                  >
                    <Link2Off className="mr-2 h-3.5 w-3.5" />
                    {tc.disconnect}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>

            {connection.lastError && (connection.status === 'sync_error' || connection.status === 'auth_error') ? (
              <p className="border-b bg-red-50 px-6 py-2.5 text-xs text-red-700 dark:bg-red-950/40 dark:text-red-300">
                {connection.lastError}
              </p>
            ) : null}

            <Tabs defaultValue="records" className="flex min-h-0 flex-1 flex-col gap-0">
              <div className="px-6 pt-3">
                <TabsList className="grid w-full grid-cols-3">
                  <TabsTrigger value="records">{tc.records.title}</TabsTrigger>
                  <TabsTrigger value="activity">{tc.runs.title}</TabsTrigger>
                  <TabsTrigger value="settings">{tc.settings.title}</TabsTrigger>
                </TabsList>
              </div>

              <TabsContent value="records" className="mt-0 min-h-0 flex-1 overflow-y-auto px-6 py-4">
                {records.length === 0 ? (
                  <p className="text-muted-foreground py-10 text-center text-sm">{tc.records.empty}</p>
                ) : (
                  <ul className="divide-y">
                    {records.map((record) => (
                      <li key={record.id} className="flex items-center justify-between gap-3 py-2.5">
                        <div className="min-w-0">
                          <p className="truncate text-sm font-medium">{record.label}</p>
                          <p className="text-muted-foreground truncate text-[11px]">
                            {types[recordTypeKey(record)]}
                            {record.lastSyncedAt ? ` · ${relativeTime(record.lastSyncedAt, language)}` : ''}
                          </p>
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
                {records.length > 0 ? (
                  <p className="text-muted-foreground mt-3 text-[11px]">
                    {format(tc.records.showingRecent, { count: records.length })}
                  </p>
                ) : null}
              </TabsContent>

              <TabsContent value="activity" className="mt-0 min-h-0 flex-1 overflow-y-auto px-6 py-4">
                {runs.length === 0 ? (
                  <p className="text-muted-foreground py-10 text-center text-sm">{tc.runs.empty}</p>
                ) : (
                  <ul className="space-y-3">
                    {runs.map((run) => (
                      <li key={run.id} className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <p className="text-sm font-medium">{runLabel(run, connection, t)}</p>
                          <p className="text-muted-foreground mt-0.5 text-[11px]">
                            {run.recordsCreated} {tc.runs.created} · {run.recordsModified} {tc.runs.updated}
                            {run.recordsSkipped > 0 ? ` · ${run.recordsSkipped} ${tc.runs.skipped}` : ''}
                            {run.recordsFailed > 0 ? ` · ${run.recordsFailed} ${tc.runs.failed}` : ''}
                          </p>
                          <p className="text-muted-foreground mt-0.5 text-[11px]">
                            {relativeTime(run.startedAt, language)} · {triggerLabel(run.trigger, t)}
                          </p>
                          {run.error ? (
                            <p className="mt-1 text-[11px] text-red-600 dark:text-red-400">{run.error}</p>
                          ) : null}
                        </div>
                        <Badge
                          variant="outline"
                          className={`shrink-0 text-[11px] ${STATUS_CLASSES[run.status] ?? ''}`}
                        >
                          {tc.health[run.status as keyof typeof tc.health] ?? run.status}
                        </Badge>
                      </li>
                    ))}
                  </ul>
                )}
              </TabsContent>

              <TabsContent value="settings" className="mt-0 min-h-0 flex-1 overflow-y-auto px-6 py-4">
                <div className="divide-y rounded-lg border">
                  {[...new Map(connection.syncs.map((sync) => [sync.settingKey, sync])).values()].map((sync) => {
                    const on = settingEnabled(currentSyncs, sync);
                    return (
                      <div key={sync.settingKey} className="flex items-center justify-between gap-3 px-3 py-2.5">
                        <p className="text-sm">{tc.settings[sync.settingKey]}</p>
                        <Switch
                          checked={on}
                          disabled={!canManage}
                          onCheckedChange={(checked) => {
                            const without = currentSyncs.filter(
                              (value) => value !== sync.settingKey && value !== sync.syncName,
                            );
                            setEnabledSyncs(checked ? [...without, sync.settingKey] : without);
                          }}
                        />
                      </div>
                    );
                  })}
                </div>
                {canManage ? (
                  <Button
                    size="sm"
                    className="mt-4"
                    onClick={handleSaveSettings}
                    disabled={update.isPending || enabledSyncs === null}
                  >
                    {update.isPending ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : null}
                    {tc.settings.save}
                  </Button>
                ) : null}
                <p className="text-muted-foreground mt-4 text-[11px] leading-relaxed">{tc.webhookHint}</p>
              </TabsContent>
            </Tabs>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}
