import * as React from 'react';
import { useTranslations } from '@weldsuite/i18n/client';
import { useRouter } from '@/lib/router';
import {
  Loader2,
  RefreshCw,
  Unplug,
  CheckCircle2,
  XCircle,
  Clock,
  Zap,
  Settings2,
  Plus,
  Globe,
  FileText,
} from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { cn } from '@/lib/utils';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { IntegrationDetailLayout } from '@/components/settings';
import { toast } from 'sonner';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@weldsuite/ui/components/select';
import { PageLoader } from '@/components/page-loader';
import {
  useIntegrationConnections,
  useDisconnectIntegration,
  useTriggerSync,
  useConnectProvider,
  useIntegrationSyncLogs,
  useUpdateConnectionSettings,
  type IntegrationConnection,
} from '@/hooks/queries/use-integration-queries';

const PROVIDER = 'hubspot';
const PROVIDER_LABEL = 'HubSpot';

type HubspotConnection = IntegrationConnection & { opportunitiesSynced?: number };

function formatDate(dateStr: string | null): string | null {
  if (!dateStr) return null;
  return new Date(dateStr).toLocaleString();
}

function formatDuration(ms: number | null): string {
  if (!ms) return '-';
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.round(ms / 60000)}m`;
}

function StatusBadge({ status }: { status: string }) {
  const t = useTranslations();
  const styles: Record<string, string> = {
    active: 'text-emerald-600 dark:text-emerald-400 bg-emerald-50 dark:bg-emerald-950/50',
    syncing: 'text-blue-600 dark:text-blue-400 bg-blue-50 dark:bg-blue-950/50',
    error: 'text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-950/50',
    inactive: 'text-muted-foreground bg-muted',
  };
  const labels: Record<string, string> = {
    active: t('sweep.settings.integrationConnectionCard.connected'),
    syncing: t('sweep.settings.integrationConnectionCard.syncing'),
    error: t('sweep.settings.integrationConnectionCard.error'),
    inactive: t('sweep.settings.integrationConnectionCard.disconnected'),
  };

  return (
    <span className={cn('text-xs font-medium px-2 py-0.5 rounded', styles[status] || styles.inactive)}>
      {labels[status] || t('sweep.settings.integrationConnectionCard.unknown')}
    </span>
  );
}

function ConnectionCard({
  connection,
  onSync,
  onDisconnect,
  onFieldMappings,
  isSyncing,
}: {
  connection: IntegrationConnection;
  onSync: () => void;
  onDisconnect: () => void;
  onFieldMappings: () => void;
  isSyncing: boolean;
}) {
  const t = useTranslations();
  const { data: logsResult } = useIntegrationSyncLogs(connection.id);
  const updateSettings = useUpdateConnectionSettings();
  const syncLogs = logsResult?.data?.slice(0, 5);
  const syncSettings = connection.syncSettings as { syncIntervalHours?: number } | null;
  const currentInterval = String(syncSettings?.syncIntervalHours || 6);

  return (
    <div className="bg-card border border-border rounded-xl p-4">
      {/* Header */}
      <div className="flex items-start gap-3 mb-4">
        <div className="w-10 h-10 rounded-[0.625rem] bg-muted flex items-center justify-center shrink-0">
          <Zap className="h-5 w-5" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5 mb-0.5">
            <h3 className="text-[0.9375rem] font-semibold text-foreground m-0">
              {connection.name || `${PROVIDER_LABEL} Connection`}
            </h3>
            <StatusBadge status={connection.status} />
          </div>
          <p className="text-xs text-muted-foreground m-0">
            {t('sweep.settings.integrationConnectionCard.connectedOn', { date: formatDate(connection.connectedAt) ?? t('sweep.settings.integrationConnectionCard.never') })}
          </p>
        </div>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-4 gap-3 mb-4">
        <div className="text-center">
          <p className="text-lg font-semibold">{connection.companiesSynced}</p>
          <p className="text-xs text-muted-foreground">{t('sweep.settings.crmSync.companies')}</p>
        </div>
        <div className="text-center">
          <p className="text-lg font-semibold">{connection.peopleSynced}</p>
          <p className="text-xs text-muted-foreground">{t('sweep.settings.crmSync.contacts')}</p>
        </div>
        <div className="text-center">
          <p className="text-lg font-semibold">{(connection as HubspotConnection).opportunitiesSynced || 0}</p>
          <p className="text-xs text-muted-foreground">{t('sweep.settings.crmSync.deals')}</p>
        </div>
        <div className="text-center">
          <p className="text-xs font-medium">{formatDate(connection.lastSyncAt) ?? t('sweep.settings.integrationConnectionCard.never')}</p>
          <p className="text-xs text-muted-foreground">{t('sweep.settings.crmSync.lastSync')}</p>
        </div>
      </div>

      {/* Error */}
      {connection.lastError && (
        <div className="bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-900 rounded-lg p-3 mb-4">
          <div className="flex items-start gap-2">
            <XCircle className="h-4 w-4 text-red-500 mt-0.5 shrink-0" />
            <p className="text-xs text-red-600 dark:text-red-400">{connection.lastError}</p>
          </div>
        </div>
      )}

      {/* Actions */}
      <div className="flex items-center gap-2 mb-4">
        <Button
          variant="outline"
          size="sm"
          onClick={onSync}
          disabled={isSyncing || connection.status === 'syncing'}
        >
          <RefreshCw className={cn('h-4 w-4 mr-2', connection.status === 'syncing' && 'animate-spin')} />
          {isSyncing || connection.status === 'syncing' ? t('sweep.settings.crmSync.syncing') : t('sweep.settings.crmSync.syncNow')}
        </Button>
        <Button variant="outline" size="sm" onClick={onFieldMappings}>
          <Settings2 className="h-4 w-4 mr-2" />
          {t('sweep.settings.crmSync.fieldMappings')}
        </Button>
        <div className="flex items-center gap-1.5 ml-auto">
          <span className="text-xs text-muted-foreground">{t('sweep.settings.integrationConnectionCard.autoSyncEvery')}</span>
          <Select
            value={currentInterval}
            onValueChange={(v) => {
              updateSettings.mutate({
                connectionId: connection.id,
                syncSettings: { syncIntervalHours: parseInt(v, 10) },
              });
            }}
          >
            <SelectTrigger className="h-7 w-[100px] text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="1">{t('sweep.settings.integrationConnectionCard.hours1')}</SelectItem>
              <SelectItem value="2">{t('sweep.settings.integrationConnectionCard.hoursN', { count: 2 })}</SelectItem>
              <SelectItem value="4">{t('sweep.settings.integrationConnectionCard.hoursN', { count: 4 })}</SelectItem>
              <SelectItem value="6">{t('sweep.settings.integrationConnectionCard.hoursN', { count: 6 })}</SelectItem>
              <SelectItem value="12">{t('sweep.settings.integrationConnectionCard.hoursN', { count: 12 })}</SelectItem>
              <SelectItem value="24">{t('sweep.settings.integrationConnectionCard.hoursN', { count: 24 })}</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <Button
          variant="outline"
          size="sm"
          className="text-red-600 hover:text-red-700 hover:bg-red-50 dark:hover:bg-red-950/30"
          onClick={onDisconnect}
        >
          <Unplug className="h-4 w-4 mr-2" />
          {t('sweep.settings.integrationConnectionCard.disconnect')}
        </Button>
      </div>

      {/* Sync logs */}
      {syncLogs && syncLogs.length > 0 && (
        <div>
          <h4 className="text-[0.7rem] font-semibold text-muted-foreground tracking-wider uppercase mb-2">
            {t('sweep.settings.integrationConnectionCard.recentActivity')}
          </h4>
          <div className="space-y-1.5">
            {syncLogs.map((log) => (
              <div key={log.id} className="flex items-center gap-2 text-xs">
                {log.status === 'completed' && <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500 shrink-0" />}
                {log.status === 'failed' && <XCircle className="h-3.5 w-3.5 text-red-500 shrink-0" />}
                {log.status === 'running' && <Loader2 className="h-3.5 w-3.5 text-blue-500 animate-spin shrink-0" />}
                {log.status === 'pending' && <Clock className="h-3.5 w-3.5 text-muted-foreground shrink-0" />}
                <span className="text-muted-foreground flex-1">
                  {log.triggeredBy === 'manual' ? t('sweep.settings.crmSync.manualSync') : log.triggeredBy === 'scheduled' ? t('sweep.settings.crmSync.scheduledSync') : t('sweep.settings.crmSync.sync')}
                </span>
                {log.status === 'completed' && (
                  <span className="text-muted-foreground">{t('sweep.settings.crmSync.createdUpdatedCount', { created: log.itemsCreated, updated: log.itemsUpdated })}</span>
                )}
                <span className="text-muted-foreground">{formatDuration(log.durationMs)}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

const hubspotIcon = (
  <img
    src="https://uxwing.com/wp-content/themes/uxwing/download/brands-and-social-media/hubspot-icon.svg"
    className="h-7 w-7"
    alt="HubSpot"
  />
);

export default function HubSpotSettingsPage() {
  const t = useTranslations();
  const router = useRouter();
  const [disconnectId, setDisconnectId] = React.useState<string | null>(null);

  const { data: connectionsResult, isLoading } = useIntegrationConnections();
  const connectMutation = useConnectProvider();
  const disconnectMutation = useDisconnectIntegration();
  const syncMutation = useTriggerSync();

  const connections = connectionsResult?.data
    ?.filter(c => c.provider === PROVIDER) || [];

  const handleConnect = async () => {
    const redirectUri = `${window.location.origin}/settings/integrations/${PROVIDER}/callback`;
    try {
      const result = await connectMutation.mutateAsync({ provider: PROVIDER, redirectUri });
      const authorizeUrl = result?.data?.authorizeUrl;
      if (authorizeUrl) {
        window.location.href = authorizeUrl;
      } else {
        toast.error(t('sweep.settings.integrationConnectionCard.connectStartFailed', { provider: PROVIDER_LABEL }));
      }
    } catch {
      toast.error(t('sweep.settings.integrationConnectionCard.connectStartFailed', { provider: PROVIDER_LABEL }));
    }
  };

  const handleDisconnect = async () => {
    if (!disconnectId) return;
    try {
      await disconnectMutation.mutateAsync(disconnectId);
      toast.success(t('sweep.settings.integrationConnectionCard.disconnectedToast', { provider: PROVIDER_LABEL }));
      setDisconnectId(null);
    } catch {
      toast.error(t('sweep.settings.integrationConnectionCard.disconnectFailed', { provider: PROVIDER_LABEL }));
    }
  };

  const handleSync = async (connectionId: string) => {
    try {
      await syncMutation.mutateAsync(connectionId);
      toast.success(t('sweep.settings.crmSync.syncStarted'));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('sweep.settings.crmSync.syncStartFailed'));
    }
  };

  if (isLoading) {
    return <PageLoader fullScreen={false} />;
  }

  const connected = connections.length > 0;

  // For the layout's single disconnect button: only act when exactly one connection exists.
  const handleLayoutDisconnect = () => {
    if (connections.length === 1) {
      setDisconnectId(connections[0].id);
    }
  };

  return (
    <>
      <IntegrationDetailLayout
        name={PROVIDER_LABEL}
        description={t('sweep.settings.integrationConnectionCard.crmIntegration')}
        category="CRM"
        icon={hubspotIcon}
        connected={connected}
        isWorking={connectMutation.isPending || disconnectMutation.isPending}
        connectLabel={connected ? t('sweep.settings.integrationConnectionCard.addConnection') : t('sweep.settings.integrationConnectionCard.connectProvider', { provider: PROVIDER_LABEL })}
        disconnectLabel={t('sweep.settings.integrationConnectionCard.disconnect')}
        onConnect={handleConnect}
        onDisconnect={connections.length === 1 ? handleLayoutDisconnect : undefined}
        canManage={!connected || connections.length === 1}
        provider={PROVIDER_LABEL}
        resources={[
          { label: t('sweep.settings.integrationConnectionCard.website'), href: 'https://hubspot.com', icon: Globe },
          { label: t('sweep.settings.integrationConnectionCard.documentation'), href: 'https://developers.hubspot.com', icon: FileText },
        ]}
        overview={t('sweep.settings.integrationConnectionCard.hubspotOverview', { provider: PROVIDER_LABEL })}
      >
        {/* "Add Connection" button shown when already connected (multiple connections supported) */}
        {connected && (
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="text-[0.7rem] font-semibold text-muted-foreground tracking-wider uppercase">
                {t('sweep.settings.integrationConnectionCard.connectionsHeading')}
              </h2>
              <Button size="sm" variant="outline" onClick={handleConnect} disabled={connectMutation.isPending}>
                {connectMutation.isPending ? (
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                ) : (
                  <Plus className="h-4 w-4 mr-2" />
                )}
                {t('sweep.settings.integrationConnectionCard.addConnection')}
              </Button>
            </div>
            {connections.map(conn => (
              <ConnectionCard
                key={conn.id}
                connection={conn}
                onSync={() => handleSync(conn.id)}
                onDisconnect={() => setDisconnectId(conn.id)}
                onFieldMappings={() => router.push(`/settings/integrations/crm-sync?id=${conn.id}`)}
                isSyncing={syncMutation.isPending}
              />
            ))}
          </div>
        )}
      </IntegrationDetailLayout>

      <ConfirmDialog
        open={!!disconnectId}
        onOpenChange={(open) => { if (!open) setDisconnectId(null); }}
        title={t('sweep.settings.integrationConnectionCard.disconnectProvider', { provider: PROVIDER_LABEL })}
        description={t('sweep.settings.integrationConnectionCard.disconnectDescription')}
        confirmLabel={t('sweep.settings.integrationConnectionCard.disconnect')}
        variant="destructive"
        loading={disconnectMutation.isPending}
        onConfirm={handleDisconnect}
      />
    </>
  );
}
