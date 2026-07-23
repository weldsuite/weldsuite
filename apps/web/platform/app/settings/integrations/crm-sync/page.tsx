import * as React from 'react';
import { useTranslations } from '@weldsuite/i18n/client';
import { useParams, useSearchParams, useRouter } from '@/lib/router';
import {
  RefreshCw,
  AlertTriangle,
  CheckCircle2,
  XCircle,
  Loader2,
  Clock,
  ChevronLeft,
  Settings2,
} from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';
import {
  useIntegrationConnection,
  useIntegrationSyncLogs,
  useTriggerSync,
  useSyncConflicts,
  useResolveConflict,
  type SyncLog,
} from '@/hooks/queries/use-integration-queries';
import { FieldMappingEditor } from '@/components/settings/field-mapping-editor';
import { PageLoader } from '@/components/page-loader';

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

export default function CrmSyncSettingsPage() {
  const t = useTranslations();
  const router = useRouter();
  const params = useParams();
  const searchParams = useSearchParams();
  const connectionId = searchParams.get('id') || params.id as string;
  const [activeSection, setActiveSection] = React.useState<'mappings' | 'logs' | 'conflicts'>('mappings');

  const { data: connectionRes, isLoading } = useIntegrationConnection(connectionId);
  const { data: logsRes } = useIntegrationSyncLogs(connectionId);
  const { data: conflictsRes } = useSyncConflicts(connectionId, { resolution: 'pending' });
  const triggerSync = useTriggerSync();
  const resolveConflict = useResolveConflict();

  const connection = connectionRes?.data;
  const logs = ((logsRes as any)?.data || []) as SyncLog[];
  const pendingConflicts = conflictsRes?.data || [];

  if (isLoading) {
    return <PageLoader fullScreen={false} />;
  }

  if (!connection) {
    return (
      <div className="flex justify-center flex-1 relative">
        <div className="w-full max-w-[1150px] p-6">
          <Button
            variant="ghost"
            onClick={() => router.push('/settings/integrations')}
            className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors mb-4"
          >
            <ChevronLeft className="h-4 w-4" />
            {t('sweep.settings.crmSync.backToIntegrations')}
          </Button>
          <p className="text-muted-foreground">{t('sweep.settings.crmSync.connectionNotFound')}</p>
        </div>
      </div>
    );
  }

  const handleSync = async () => {
    try {
      await triggerSync.mutateAsync(connectionId);
      toast.success(t('sweep.settings.crmSync.syncStarted'));
    } catch {
      toast.error(t('sweep.settings.crmSync.syncStartFailed'));
    }
  };

  const providerLabel = connection.provider.charAt(0).toUpperCase() + connection.provider.slice(1);

  const sidebarItems = [
    { id: 'mappings' as const, label: t('sweep.settings.crmSync.fieldMappings') },
    { id: 'logs' as const, label: t('sweep.settings.crmSync.syncLogs') },
    ...(pendingConflicts.length > 0 ? [{ id: 'conflicts' as const, label: t('sweep.settings.crmSync.conflictsCount', { count: pendingConflicts.length }) }] : []),
  ];

  return (
    <div className="flex justify-center flex-1 relative">
      <div className="w-full max-w-[1150px] flex relative">
        {/* Sidebar */}
        <div className="w-60 shrink-0 py-6 pl-8">
          <div className="sticky top-6">
            <Button
              variant="ghost"
              onClick={() => router.push(`/settings/integrations/${connection.provider}`)}
              className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors mb-6"
            >
              <ChevronLeft className="h-4 w-4" />
              {t('sweep.settings.crmSync.backTo', { name: providerLabel })}
            </Button>
            <div className="mb-6">
              <h1 className="text-[0.9375rem] font-semibold">{connection.name || providerLabel}</h1>
              <p className="text-xs text-muted-foreground">{t('sweep.settings.crmSync.syncSettings')}</p>
            </div>

            {/* Stats */}
            <div className="space-y-2 mb-6">
              <div className="flex justify-between text-xs">
                <span className="text-muted-foreground">{t('sweep.settings.crmSync.companies')}</span>
                <span className="font-medium">{connection.companiesSynced}</span>
              </div>
              <div className="flex justify-between text-xs">
                <span className="text-muted-foreground">{t('sweep.settings.crmSync.contacts')}</span>
                <span className="font-medium">{connection.peopleSynced}</span>
              </div>
              <div className="flex justify-between text-xs">
                <span className="text-muted-foreground">{t('sweep.settings.crmSync.deals')}</span>
                <span className="font-medium">{(connection as any).opportunitiesSynced || 0}</span>
              </div>
              <div className="flex justify-between text-xs">
                <span className="text-muted-foreground">{t('sweep.settings.crmSync.lastSync')}</span>
                <span className="font-medium">{formatDate(connection.lastSyncAt) ?? t('sweep.settings.crmSync.never')}</span>
              </div>
            </div>

            {/* Navigation */}
            <h2 className="text-[0.7rem] font-semibold text-muted-foreground tracking-wider mb-3 uppercase">
              {t('sweep.settings.crmSync.settingsHeading')}
            </h2>
            <div className="flex flex-col gap-1">
              {sidebarItems.map(item => (
                <Button
                  key={item.id}
                  variant="ghost"
                  onClick={() => setActiveSection(item.id)}
                  className={cn(
                    'py-2 px-3 text-left text-sm border-none rounded-lg cursor-pointer transition-all -mx-3',
                    activeSection === item.id
                      ? 'bg-accent text-foreground font-medium'
                      : 'text-muted-foreground hover:bg-accent hover:text-foreground'
                  )}
                >
                  {item.label}
                </Button>
              ))}
            </div>

            <Button
              variant="outline"
              size="sm"
              className="w-full mt-6"
              onClick={handleSync}
              disabled={connection.status === 'syncing' || triggerSync.isPending}
            >
              <RefreshCw className={cn('h-4 w-4 mr-2', connection.status === 'syncing' && 'animate-spin')} />
              {connection.status === 'syncing' ? t('sweep.settings.crmSync.syncing') : t('sweep.settings.crmSync.syncNow')}
            </Button>
          </div>
        </div>

        {/* Vertical Separator */}
        <div className="absolute left-[calc(240px+2rem)] top-0 bottom-0 w-px bg-border" />

        {/* Content */}
        <div className="flex-1 p-6 ml-8">
          {activeSection === 'mappings' && (
            <>
              <h2 className="text-[0.7rem] font-semibold text-muted-foreground tracking-wider uppercase mb-4">
                {t('sweep.settings.crmSync.fieldMappingsHeading')}
              </h2>
              <FieldMappingEditor connectionId={connectionId} />
            </>
          )}

          {activeSection === 'logs' && (
            <>
              <h2 className="text-[0.7rem] font-semibold text-muted-foreground tracking-wider uppercase mb-4">
                {t('sweep.settings.crmSync.syncLogsHeading')}
              </h2>
              {logs.length === 0 ? (
                <div className="bg-card border border-border rounded-xl p-8 text-center">
                  <p className="text-sm text-muted-foreground">{t('sweep.settings.crmSync.noSyncActivity')}</p>
                </div>
              ) : (
                <div className="bg-card border border-border rounded-xl overflow-hidden">
                  <div className="divide-y divide-border">
                    {logs.slice(0, 20).map(log => (
                      <div key={log.id} className="flex items-center gap-3 px-4 py-3 text-xs">
                        {log.status === 'completed' && <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500 shrink-0" />}
                        {log.status === 'failed' && <XCircle className="h-3.5 w-3.5 text-red-500 shrink-0" />}
                        {log.status === 'running' && <Loader2 className="h-3.5 w-3.5 text-blue-500 animate-spin shrink-0" />}
                        {log.status === 'pending' && <Clock className="h-3.5 w-3.5 text-muted-foreground shrink-0" />}
                        <span className="flex-1 text-muted-foreground">
                          {log.triggeredBy === 'manual' ? t('sweep.settings.crmSync.manualSync') : log.triggeredBy === 'scheduled' ? t('sweep.settings.crmSync.scheduledSync') : t('sweep.settings.crmSync.sync')}
                          {log.status === 'completed' && ` — ${t('sweep.settings.crmSync.createdUpdatedCount', { created: log.itemsCreated, updated: log.itemsUpdated })}`}
                          {log.status === 'failed' && log.errorMessage && ` — ${log.errorMessage}`}
                        </span>
                        <span className="text-muted-foreground">{formatDuration(log.durationMs)}</span>
                        <span className="text-muted-foreground w-[130px] text-right">{formatDate(log.startedAt) ?? t('sweep.settings.crmSync.never')}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </>
          )}

          {activeSection === 'conflicts' && pendingConflicts.length > 0 && (
            <>
              <h2 className="text-[0.7rem] font-semibold text-muted-foreground tracking-wider uppercase mb-4">
                {t('sweep.settings.crmSync.conflictsHeading')}
              </h2>
              <div className="bg-card border border-border rounded-xl overflow-hidden">
                <div className="divide-y divide-border">
                  {pendingConflicts.map(conflict => (
                    <div key={conflict.id} className="px-4 py-3">
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-3">
                          <span className="text-xs font-medium text-muted-foreground bg-muted px-2 py-0.5 rounded">
                            {conflict.entityType}
                          </span>
                          <span className="text-sm">{conflict.internalEntityId}</span>
                          {conflict.conflictFields && (
                            <span className="text-xs text-muted-foreground">
                              {conflict.conflictFields.join(', ')}
                            </span>
                          )}
                        </div>
                        <div className="flex items-center gap-2">
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => resolveConflict.mutate({ connectionId, conflictId: conflict.id, resolution: 'keep_internal' })}
                          >
                            {t('sweep.settings.crmSync.keepOurs')}
                          </Button>
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => resolveConflict.mutate({ connectionId, conflictId: conflict.id, resolution: 'keep_external' })}
                          >
                            {t('sweep.settings.crmSync.keepTheirs')}
                          </Button>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
