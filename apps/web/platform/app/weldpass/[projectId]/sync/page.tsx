/**
 * Deploy targets for a WeldPass project: the API tokens it pushes with, the
 * targets themselves, and what recent pushes did.
 */

import { useState } from 'react';
import { Plus, RefreshCw, Send, Trash2 } from 'lucide-react';
import { Badge } from '@weldsuite/ui/components/badge';
import { Button } from '@weldsuite/ui/components/button';
import { Card } from '@weldsuite/ui/components/card';
import { useTranslations } from '@weldsuite/i18n/client';
import { usePermissions } from '@weldsuite/permissions/react';
import type { WeldPassSyncTarget } from '@weldsuite/app-api-client/domains/weldpass';
import { useParams } from '@/lib/router';
import {
  useDeleteWeldPassCredential,
  useDeleteWeldPassSyncTarget,
  usePushWeldPassSyncTarget,
  useUpdateWeldPassSyncTarget,
  useWeldPassCredentials,
  useWeldPassProject,
  useWeldPassSyncRuns,
  useWeldPassSyncTargets,
} from '@/hooks/queries/use-weldpass-queries';
import {
  EmptyState,
  ErrorBanner,
  InlineSpinner,
  TimeAgo,
  errorMessage,
  statusTone,
} from '../../components/shared';
import { CredentialDialog, TargetDialog, describeConfig } from '../../components/sync-dialogs';

export default function WeldPassSyncPage() {
  const t = useTranslations();
  const { can } = usePermissions();
  const { projectId } = useParams() as { projectId: string };

  const { data: project, isLoading } = useWeldPassProject(projectId);
  const { data: targets } = useWeldPassSyncTargets(projectId);
  const { data: credentials } = useWeldPassCredentials(projectId);
  const { data: runs, refetch: refetchRuns } = useWeldPassSyncRuns(projectId);

  const push = usePushWeldPassSyncTarget(projectId);
  const updateTarget = useUpdateWeldPassSyncTarget(projectId);
  const deleteTarget = useDeleteWeldPassSyncTarget(projectId);
  const deleteCredential = useDeleteWeldPassCredential(projectId);

  const [failure, setFailure] = useState<string | null>(null);
  const [dialog, setDialog] = useState<'credential' | 'target' | null>(null);
  const [pushing, setPushing] = useState<string | null>(null);

  const canManage = can('secrets:manage');
  const canSync = can('secrets:sync') || canManage;

  async function pushTarget(target: WeldPassSyncTarget) {
    setPushing(target.id);
    setFailure(null);
    try {
      const res = await push.mutateAsync(target.id);
      if (res.data.run.status === 'failed') {
        setFailure(res.data.run.error ?? t('weldpass.syncPage.pushFailed'));
      }
    } catch (err) {
      setFailure(errorMessage(err, t('weldpass.syncPage.pushFailed')));
    } finally {
      setPushing(null);
    }
  }

  if (isLoading || !project) return <InlineSpinner />;

  const environmentName = (id: string) =>
    project.environments.find((environment) => environment.id === id)?.name ?? id;

  return (
    <div className="mx-auto w-full max-w-4xl space-y-6 p-6">
      <header>
        <h1 className="text-lg font-semibold">{t('weldpass.sync')}</h1>
        <p className="text-sm text-muted-foreground">
          {t('weldpass.syncPage.subtitle', { project: project.name })}
        </p>
      </header>

      <ErrorBanner error={failure} onDismiss={() => setFailure(null)} />

      <section className="space-y-2">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-medium">{t('weldpass.syncPage.targets')}</h2>
          {canManage && (
            <Button
              size="sm"
              disabled={!credentials || credentials.length === 0}
              onClick={() => setDialog('target')}
            >
              <Plus className="mr-1.5 h-4 w-4" />
              {t('weldpass.syncPage.addTarget')}
            </Button>
          )}
        </div>

        {!targets || targets.length === 0 ? (
          <EmptyState
            title={t('weldpass.syncPage.noTargetsTitle')}
            description={
              !credentials || credentials.length === 0
                ? t('weldpass.syncPage.noTargetsNeedToken')
                : t('weldpass.syncPage.noTargetsDescription')
            }
          />
        ) : (
          targets.map((target) => (
            <Card key={target.id} className="space-y-2 p-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-sm font-medium">{target.name}</p>
                  <p className="text-xs text-muted-foreground">
                    {t(`weldpass.providers.${target.provider}`)} ·{' '}
                    {environmentName(target.environmentId)} · {describeConfig(target.config)}
                  </p>
                </div>
                <div className="flex items-center gap-1">
                  {canSync && (
                    <Button
                      size="sm"
                      disabled={pushing === target.id}
                      onClick={() => void pushTarget(target)}
                    >
                      <Send className="mr-1.5 h-3.5 w-3.5" />
                      {t('weldpass.syncPage.push')}
                    </Button>
                  )}
                  {canManage && (
                    <Button
                      variant="ghost"
                      size="sm"
                      aria-label={t('weldpass.syncPage.remove')}
                      onClick={async () => {
                        if (!confirm(t('weldpass.syncPage.removeConfirm', { name: target.name })))
                          return;
                        await deleteTarget.mutateAsync(target.id);
                      }}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  )}
                </div>
              </div>

              <div className="flex flex-wrap items-center gap-2 text-xs">
                <Badge variant={statusTone(target.status)}>{target.status}</Badge>
                {target.lastSyncedAt && (
                  <span className="text-muted-foreground">
                    {t('weldpass.syncPage.pushedCount', { count: target.lastSyncedCount })}{' '}
                    <TimeAgo value={target.lastSyncedAt} />
                  </span>
                )}
                {canManage && (
                  <button
                    className="text-muted-foreground underline-offset-2 hover:underline"
                    onClick={async () => {
                      setFailure(null);
                      try {
                        await updateTarget.mutateAsync({
                          targetId: target.id,
                          autoSync: !target.autoSync,
                        });
                      } catch (err) {
                        setFailure(errorMessage(err, t('weldpass.syncPage.updateFailed')));
                      }
                    }}
                  >
                    {target.autoSync
                      ? t('weldpass.syncPage.autoSyncOn')
                      : t('weldpass.syncPage.autoSyncOff')}
                  </button>
                )}
                {target.prune && (
                  <Badge variant="outline">{t('weldpass.syncPage.prunes')}</Badge>
                )}
              </div>

              {target.lastError && <ErrorBanner error={target.lastError} />}
              {target.redeployNotice && (
                <p className="text-xs text-muted-foreground">{target.redeployNotice}</p>
              )}
            </Card>
          ))
        )}
      </section>

      {canManage && (
        <section className="space-y-2">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-medium">{t('weldpass.syncPage.tokens')}</h2>
            <Button variant="outline" size="sm" onClick={() => setDialog('credential')}>
              <Plus className="mr-1.5 h-4 w-4" />
              {t('weldpass.syncPage.addToken')}
            </Button>
          </div>

          {!credentials || credentials.length === 0 ? (
            <EmptyState
              title={t('weldpass.syncPage.noTokensTitle')}
              description={t('weldpass.syncPage.noTokensDescription')}
            />
          ) : (
            credentials.map((credential) => (
              <Card key={credential.id} className="flex items-center justify-between gap-3 p-3">
                <div className="min-w-0">
                  <p className="text-sm">{credential.name}</p>
                  <p className="text-xs text-muted-foreground">
                    {t(`weldpass.providers.${credential.provider}`)}
                    {credential.metadata.accountId && ` · ${credential.metadata.accountId}`}
                    {credential.metadata.teamId && ` · ${credential.metadata.teamId}`}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  {credential.lastVerifyError ? (
                    <Badge variant="destructive">{t('weldpass.syncPage.tokenFailed')}</Badge>
                  ) : credential.lastVerifiedAt ? (
                    <Badge>{t('weldpass.syncPage.tokenVerified')}</Badge>
                  ) : (
                    <Badge variant="secondary">{t('weldpass.syncPage.tokenUnverified')}</Badge>
                  )}
                  <Button
                    variant="ghost"
                    size="sm"
                    aria-label={t('weldpass.syncPage.remove')}
                    onClick={async () => {
                      if (
                        !confirm(
                          t('weldpass.syncPage.deleteTokenConfirm', { name: credential.name }),
                        )
                      )
                        return;
                      await deleteCredential.mutateAsync(credential.id);
                    }}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              </Card>
            ))
          )}
        </section>
      )}

      <section className="space-y-2">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-medium">{t('weldpass.syncPage.recentPushes')}</h2>
          <Button variant="ghost" size="sm" onClick={() => void refetchRuns()}>
            <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
            {t('weldpass.syncPage.refresh')}
          </Button>
        </div>

        {!runs || runs.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('weldpass.syncPage.nothingPushed')}</p>
        ) : (
          <Card>
            {runs.map((run) => (
              <div
                key={run.id}
                className="flex flex-wrap items-center justify-between gap-2 border-b px-4 py-2 text-xs last:border-0"
              >
                <div className="flex items-center gap-2">
                  <Badge variant={statusTone(run.status)}>{run.status}</Badge>
                  <span>
                    {targets?.find((target) => target.id === run.targetId)?.name ??
                      t('weldpass.syncPage.removedTarget')}
                  </span>
                  <span className="text-muted-foreground">({run.trigger})</span>
                </div>
                <div className="flex items-center gap-3 text-muted-foreground">
                  <span>
                    {t('weldpass.syncPage.runSummary', { pushed: run.pushed })}
                    {run.removed > 0 && t('weldpass.syncPage.runRemoved', { count: run.removed })}
                    {run.failed > 0 && t('weldpass.syncPage.runFailed', { count: run.failed })}
                  </span>
                  <TimeAgo value={run.startedAt} />
                </div>
                {run.error && <p className="w-full text-destructive">{run.error}</p>}
              </div>
            ))}
          </Card>
        )}
      </section>

      {dialog === 'credential' && (
        <CredentialDialog projectId={projectId} onClose={() => setDialog(null)} />
      )}

      {dialog === 'target' && credentials && (
        <TargetDialog
          projectId={projectId}
          environments={project.environments}
          credentials={credentials}
          onClose={() => setDialog(null)}
        />
      )}
    </div>
  );
}
