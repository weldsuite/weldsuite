/**
 * Deploy targets for a WeldPass project: the API tokens it pushes with, the
 * targets themselves, and what recent pushes did.
 */

import { useState } from 'react';
import { Plus, RefreshCw, Send, Trash2 } from 'lucide-react';
import { Badge } from '@weldsuite/ui/components/badge';
import { Button } from '@weldsuite/ui/components/button';
import { useTranslations } from '@weldsuite/i18n/client';
import { usePermissions } from '@weldsuite/permissions/react';
import type { WeldPassSyncTarget } from '@weldsuite/app-api-client/domains/weldpass';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { PageLoader } from '@/components/page-loader';
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
import { EmptyText, SectionCard, TabBody } from '../../components/page-kit';
import { ErrorBanner, TimeAgo, errorMessage, statusTone } from '../../components/shared';
import { CredentialDialog, TargetDialog, describeConfig } from '../../components/sync-dialogs';
import { ProjectPage } from '../components/project-page';

/** A target or API token waiting on its "are you sure". */
type Removal = { kind: 'target' | 'credential'; id: string; name: string } | null;

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
  const [removing, setRemoving] = useState<Removal>(null);

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

  async function toggleAutoSync(target: WeldPassSyncTarget) {
    setFailure(null);
    try {
      await updateTarget.mutateAsync({ targetId: target.id, autoSync: !target.autoSync });
    } catch (err) {
      setFailure(errorMessage(err, t('weldpass.syncPage.updateFailed')));
    }
  }

  async function confirmRemove() {
    if (!removing) return;
    setFailure(null);
    try {
      if (removing.kind === 'target') await deleteTarget.mutateAsync(removing.id);
      else await deleteCredential.mutateAsync(removing.id);
    } catch (err) {
      setFailure(errorMessage(err, t('weldpass.syncPage.removeFailed')));
    } finally {
      setRemoving(null);
    }
  }

  if (isLoading || !project) return <PageLoader fullScreen={false} />;

  const environmentName = (id: string) =>
    project.environments.find((environment) => environment.id === id)?.name ?? id;
  const hasCredentials = Boolean(credentials && credentials.length > 0);

  return (
    <ProjectPage projectId={projectId} section="sync">
      <TabBody className="mx-auto w-full max-w-4xl">
        <ErrorBanner error={failure} onDismiss={() => setFailure(null)} />

        <SectionCard
          title={t('weldpass.syncPage.targets')}
          description={t('weldpass.syncPage.subtitle', { project: project.name })}
          contentClassName="p-0"
          action={
            canManage && (
              <Button size="sm" disabled={!hasCredentials} onClick={() => setDialog('target')}>
                <Plus className="mr-1.5 h-4 w-4" />
                {t('weldpass.syncPage.addTarget')}
              </Button>
            )
          }
        >
          {!targets || targets.length === 0 ? (
            <EmptyText>
              <span className="block font-medium text-foreground">
                {t('weldpass.syncPage.noTargetsTitle')}
              </span>
              {hasCredentials
                ? t('weldpass.syncPage.noTargetsDescription')
                : t('weldpass.syncPage.noTargetsNeedToken')}
            </EmptyText>
          ) : (
            targets.map((target) => (
              <div key={target.id} className="space-y-2 border-t px-6 py-4">
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
                        variant="outline"
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
                        onClick={() =>
                          setRemoving({ kind: 'target', id: target.id, name: target.name })
                        }
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
                      onClick={() => void toggleAutoSync(target)}
                    >
                      {target.autoSync
                        ? t('weldpass.syncPage.autoSyncOn')
                        : t('weldpass.syncPage.autoSyncOff')}
                    </button>
                  )}
                  {target.prune && <Badge variant="outline">{t('weldpass.syncPage.prunes')}</Badge>}
                </div>

                {target.lastError && <ErrorBanner error={target.lastError} />}
                {target.redeployNotice && (
                  <p className="text-xs text-muted-foreground">{target.redeployNotice}</p>
                )}
              </div>
            ))
          )}
        </SectionCard>

        {canManage && (
          <SectionCard
            title={t('weldpass.syncPage.tokens')}
            contentClassName="p-0"
            action={
              <Button variant="outline" size="sm" onClick={() => setDialog('credential')}>
                <Plus className="mr-1.5 h-4 w-4" />
                {t('weldpass.syncPage.addToken')}
              </Button>
            }
          >
            {!credentials || credentials.length === 0 ? (
              <EmptyText>
                <span className="block font-medium text-foreground">
                  {t('weldpass.syncPage.noTokensTitle')}
                </span>
                {t('weldpass.syncPage.noTokensDescription')}
              </EmptyText>
            ) : (
              credentials.map((credential) => (
                <div
                  key={credential.id}
                  className="flex items-center justify-between gap-3 border-t px-6 py-3"
                >
                  <div className="min-w-0">
                    <p className="text-sm">{credential.name}</p>
                    <p className="text-xs text-muted-foreground">
                      {t(`weldpass.providers.${credential.provider}`)}
                      {credential.metadata.accountId && ` · ${credential.metadata.accountId}`}
                      {credential.metadata.teamId && ` · ${credential.metadata.teamId}`}
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    {credential.lastVerifyError && (
                      <Badge variant="destructive">{t('weldpass.syncPage.tokenFailed')}</Badge>
                    )}
                    {!credential.lastVerifyError && credential.lastVerifiedAt && (
                      <Badge>{t('weldpass.syncPage.tokenVerified')}</Badge>
                    )}
                    {!credential.lastVerifyError && !credential.lastVerifiedAt && (
                      <Badge variant="secondary">{t('weldpass.syncPage.tokenUnverified')}</Badge>
                    )}
                    <Button
                      variant="ghost"
                      size="sm"
                      aria-label={t('weldpass.syncPage.remove')}
                      onClick={() =>
                        setRemoving({
                          kind: 'credential',
                          id: credential.id,
                          name: credential.name,
                        })
                      }
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                </div>
              ))
            )}
          </SectionCard>
        )}

        <SectionCard
          title={t('weldpass.syncPage.recentPushes')}
          contentClassName="p-0"
          action={
            <Button variant="ghost" size="sm" onClick={() => void refetchRuns()}>
              <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
              {t('weldpass.syncPage.refresh')}
            </Button>
          }
        >
          {!runs || runs.length === 0 ? (
            <EmptyText>{t('weldpass.syncPage.nothingPushed')}</EmptyText>
          ) : (
            runs.map((run) => (
              <div
                key={run.id}
                className="flex flex-wrap items-center justify-between gap-2 border-t px-6 py-2.5 text-xs"
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
            ))
          )}
        </SectionCard>
      </TabBody>

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

      {removing && (
        <ConfirmDialog
          open
          onOpenChange={(open) => !open && setRemoving(null)}
          title={t(
            removing.kind === 'target'
              ? 'weldpass.syncPage.removeTitle'
              : 'weldpass.syncPage.deleteTokenTitle',
            { name: removing.name },
          )}
          description={t(
            removing.kind === 'target'
              ? 'weldpass.syncPage.removeDescription'
              : 'weldpass.syncPage.deleteTokenDescription',
          )}
          confirmLabel={t('weldpass.syncPage.remove')}
          cancelLabel={t('weldpass.secrets.form.cancel')}
          variant="destructive"
          loading={deleteTarget.isPending || deleteCredential.isPending}
          onConfirm={confirmRemove}
        />
      )}
    </ProjectPage>
  );
}
