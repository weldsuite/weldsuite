import * as React from 'react';
import { useI18n } from '@/lib/i18n/provider';
import { useTranslations } from '@weldsuite/i18n/client';
import {
  Loader2,
  RefreshCw,
  CheckCircle2,
  XCircle,
  Clock,
  Globe,
  FileText,
} from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { IntegrationDetailLayout } from '@/components/settings';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@weldsuite/ui/components/table';
import { Tooltip, TooltipContent, TooltipTrigger } from '@weldsuite/ui/components/tooltip';
import { toast } from 'sonner';
import {
  useIntegrationConnections,
  useDisconnectIntegration,
  useTriggerSync,
  useConnectProvider,
  useIntegrationSyncLogs,
  type IntegrationConnection,
  type SyncLog,
} from '@/hooks/queries/use-integration-queries';
import { PageLoader } from '@/components/page-loader';

function formatDate(dateStr: string | null, neverLabel: string): string {
  if (!dateStr) return neverLabel;
  const d = new Date(dateStr);
  const isCurrentYear = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleString(undefined, {
    ...(isCurrentYear ? {} : { year: 'numeric' }),
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

function formatDateExact(dateStr: string | null): string {
  if (!dateStr) return '';
  const d = new Date(dateStr);
  return d.toLocaleString(undefined, {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    timeZoneName: 'short',
  });
}

const googleCalendarIcon = (
  <img
    src="https://api.iconify.design/logos:google-calendar.svg"
    className="h-6 w-6"
    alt="Google Calendar"
  />
);

export default function GoogleCalendarSettingsPage() {
  const { t } = useI18n();
  const st = useTranslations();
  const ts = t.settings.integrations.googleCalendar;
  const [disconnectOpen, setDisconnectOpen] = React.useState(false);

  const { data: connectionsResult, isLoading } = useIntegrationConnections();
  const connectMutation = useConnectProvider();
  const disconnectMutation = useDisconnectIntegration();
  const syncMutation = useTriggerSync();

  const connections = (connectionsResult as any)?.data as IntegrationConnection[] | undefined;
  const gcalConnection = connections?.find(c => c.provider === 'google_calendar');

  const { data: logsResult } = useIntegrationSyncLogs(gcalConnection?.id || '');
  const syncLogs = (logsResult as any)?.data as SyncLog[] | undefined;

  const handleConnect = async () => {
    const redirectUri = `${window.location.origin}/settings/integrations/google-calendar/callback`;
    try {
      const result = await connectMutation.mutateAsync({ provider: 'google_calendar', redirectUri });
      const authorizeUrl = (result as any)?.data?.authorizeUrl;
      if (authorizeUrl) {
        window.location.href = authorizeUrl;
      } else {
        toast.error(ts.messages.connectFailed);
      }
    } catch (err) {
      toast.error(ts.messages.connectFailed);
    }
  };

  const handleDisconnect = async () => {
    if (!gcalConnection) return;
    try {
      await disconnectMutation.mutateAsync(gcalConnection.id);
      toast.success(ts.messages.disconnected);
      setDisconnectOpen(false);
    } catch (err) {
      toast.error(ts.messages.disconnectFailed);
    }
  };

  const handleSync = async () => {
    if (!gcalConnection) return;
    try {
      await syncMutation.mutateAsync(gcalConnection.id);
      toast.success(ts.messages.syncStarted);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : ts.messages.syncFailed);
    }
  };

  if (isLoading) {
    return <PageLoader fullScreen={false} />;
  }

  const connected = !!gcalConnection;

  return (
    <>
      <IntegrationDetailLayout
        name={ts.title}
        description={ts.description}
        category="Calendar"
        icon={googleCalendarIcon}
        connected={connected}
        isWorking={connectMutation.isPending || disconnectMutation.isPending}
        connectLabel={ts.connectButton}
        disconnectLabel={t.settings.actions.disconnect}
        onConnect={handleConnect}
        onDisconnect={() => setDisconnectOpen(true)}
        provider="Google"
        resources={[
          { label: st('sweep.settings.integrationConnectionCard.website'), href: 'https://calendar.google.com', icon: Globe },
          { label: st('sweep.settings.integrationConnectionCard.documentation'), href: 'https://developers.google.com/calendar', icon: FileText },
        ]}
        overview={ts.connectDescription}
      >
        {connected && gcalConnection && (
          <div>
            <hr className="border-border/70 mb-10" />

            <div className="space-y-6">
            {/* Stats */}
            <div className="grid grid-cols-3 divide-x divide-border border border-border rounded-lg overflow-hidden">
              <div className="px-5 py-4">
                <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{ts.eventsSynced}</p>
                <p className="text-lg font-semibold mt-2 tabular-nums">{(gcalConnection as any).eventsSynced ?? 0}</p>
              </div>
              <div className="px-5 py-4">
                <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{ts.calendarsSynced}</p>
                <p className="text-lg font-semibold mt-2 tabular-nums">{(gcalConnection as any).calendarsSynced ?? 0}</p>
              </div>
              <div className="px-5 py-4">
                <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{ts.lastSync}</p>
                {gcalConnection.lastSyncAt ? (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <p className="text-sm font-medium mt-2 font-mono cursor-default w-fit">
                        {formatDate(gcalConnection.lastSyncAt, ts.never)}
                      </p>
                    </TooltipTrigger>
                    <TooltipContent>{formatDateExact(gcalConnection.lastSyncAt)}</TooltipContent>
                  </Tooltip>
                ) : (
                  <p className="text-sm font-medium mt-2 font-mono">{ts.never}</p>
                )}
              </div>
            </div>

            {/* Error banner */}
            {gcalConnection.lastError && (
              <div className="border border-red-200 dark:border-red-900 bg-red-50 dark:bg-red-950/30 rounded-lg p-4">
                <div className="flex items-start gap-2">
                  <XCircle className="h-4 w-4 text-red-500 mt-0.5 shrink-0" />
                  <div>
                    <p className="text-sm font-medium text-red-700 dark:text-red-400">{ts.lastSyncFailed}</p>
                    <p className="text-sm text-red-600 dark:text-red-400/80 mt-0.5">{gcalConnection.lastError}</p>
                  </div>
                </div>
              </div>
            )}

            {/* Actions */}
            <div className="flex items-center gap-3">
              <Button
                variant="outline"
                onClick={handleSync}
                disabled={syncMutation.isPending || gcalConnection.status === 'syncing'}
              >
                {syncMutation.isPending || gcalConnection.status === 'syncing' ? (
                  <>
                    <Loader2 className="size-3.5 animate-spin" />
                    {ts.syncingButton}
                  </>
                ) : (
                  <>
                    <RefreshCw className="size-3.5" />
                    {ts.syncNow}
                  </>
                )}
              </Button>
            </div>

            {/* Sync logs */}
            {syncLogs && syncLogs.length > 0 && (
              <div>
                <h3 className="text-sm font-medium mb-3">{ts.recentActivity}</h3>
                <div className="border border-border rounded-lg overflow-hidden">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead className="text-[13.5px]">{st('sweep.settings.integrationConnectionCard.type')}</TableHead>
                        <TableHead className="text-[13.5px]">{st('sweep.settings.integrationConnectionCard.result')}</TableHead>
                        <TableHead className="w-[180px] text-right text-[13.5px]">{st('sweep.settings.integrationConnectionCard.date')}</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {syncLogs.slice(0, 10).map((log) => (
                        <TableRow key={log.id}>
                          <TableCell>
                            <div className="flex items-center gap-2 min-w-0">
                              {log.status === 'completed' && <CheckCircle2 className="h-4 w-4 text-emerald-500 shrink-0" />}
                              {log.status === 'failed' && <XCircle className="h-4 w-4 text-red-500 shrink-0" />}
                              {log.status === 'running' && <Loader2 className="h-4 w-4 text-blue-500 animate-spin shrink-0" />}
                              {log.status === 'pending' && <Clock className="h-4 w-4 text-muted-foreground shrink-0" />}
                              <span className="truncate">
                                {log.triggeredBy === 'manual' ? ts.manualSync :
                                 log.triggeredBy === 'scheduled' ? ts.scheduledSync :
                                 log.triggeredBy === 'webhook' ? ts.webhookUpdate : ts.sync}
                              </span>
                            </div>
                          </TableCell>
                          <TableCell className="text-muted-foreground">
                            {log.status === 'completed' && (
                              <>
                                {ts.completedSummary.replace('{created}', String(log.itemsCreated)).replace('{updated}', String(log.itemsUpdated))}
                                {log.itemsFailed > 0 && `, ${ts.failedCount.replace('{failed}', String(log.itemsFailed))}`}
                              </>
                            )}
                            {log.status === 'failed' && log.errorMessage && (
                              <span className="text-red-500">{log.errorMessage}</span>
                            )}
                          </TableCell>
                          <TableCell className="text-muted-foreground text-right font-mono">
                            {log.createdAt ? (
                              <Tooltip>
                                <TooltipTrigger asChild>
                                  <span className="cursor-default">{formatDate(log.createdAt, ts.never)}</span>
                                </TooltipTrigger>
                                <TooltipContent>{formatDateExact(log.createdAt)}</TooltipContent>
                              </Tooltip>
                            ) : (
                              ts.never
                            )}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              </div>
            )}
            </div>
          </div>
        )}
      </IntegrationDetailLayout>

      {/* Disconnect confirmation */}
      <ConfirmDialog
        open={disconnectOpen}
        onOpenChange={setDisconnectOpen}
        title={ts.disconnectTitle}
        description={ts.disconnectDescription}
        confirmLabel={t.settings.actions.disconnect}
        variant="destructive"
        loading={disconnectMutation.isPending}
        onConfirm={handleDisconnect}
      />
    </>
  );
}
