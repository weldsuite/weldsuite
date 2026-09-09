/**
 * One WeldPass project: environment tabs and the secrets in the selected one.
 *
 * Values are masked until explicitly revealed, and a reveal is a separate
 * request — the list endpoint never carries plaintext, so nothing sensitive
 * sits in the query cache or a network log just because someone opened the page.
 */

import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import { Check, Copy, Download, Eye, EyeOff, History, Plus, Trash2, Upload } from 'lucide-react';
import { Badge } from '@weldsuite/ui/components/badge';
import { Button } from '@weldsuite/ui/components/button';
import { Card } from '@weldsuite/ui/components/card';
import { useTranslations } from '@weldsuite/i18n/client';
import { usePermissions } from '@weldsuite/permissions/react';
import type {
  WeldPassAutoSyncOutcome,
  WeldPassSecret,
} from '@weldsuite/app-api-client/domains/weldpass';
import { useParams } from '@/lib/router';
import {
  useDeleteWeldPassSecret,
  useExportWeldPassEnvironment,
  useWeldPassProject,
  useWeldPassSecrets,
} from '@/hooks/queries/use-weldpass-queries';
import { cn } from '@/lib/utils';
import {
  AutoSyncSummary,
  EmptyState,
  ErrorBanner,
  InlineSpinner,
  TimeAgo,
  errorMessage,
} from '../components/shared';
import { HistoryDialog, ImportDialog, SecretDialog, useRevealer } from '../components/secret-dialogs';

type Dialog =
  | { kind: 'create' }
  | { kind: 'edit'; secret: WeldPassSecret }
  | { kind: 'import' }
  | { kind: 'history'; secret: WeldPassSecret }
  | null;

export default function WeldPassProjectPage() {
  const t = useTranslations();
  const { can } = usePermissions();
  const { projectId } = useParams() as { projectId: string };
  const navigate = useNavigate();
  const search = useSearch({ strict: false }) as { env?: string };

  const { data: project, isLoading, error } = useWeldPassProject(projectId);

  const environmentId = search.env ?? project?.environments[0]?.id ?? '';
  const environment = useMemo(
    () => project?.environments.find((e) => e.id === environmentId) ?? null,
    [project, environmentId],
  );

  const { data: secrets, isLoading: secretsLoading } = useWeldPassSecrets(
    projectId,
    environmentId || undefined,
  );

  const reveal = useRevealer(projectId, environmentId);
  const deleteSecret = useDeleteWeldPassSecret(projectId, environmentId);
  const exportEnvironment = useExportWeldPassEnvironment(projectId, environmentId);

  const [revealed, setRevealed] = useState<Record<string, string>>({});
  const [dialog, setDialog] = useState<Dialog>(null);
  const [autoSync, setAutoSync] = useState<WeldPassAutoSyncOutcome[]>([]);
  const [failure, setFailure] = useState<string | null>(null);

  // Switching environments must not carry revealed values across.
  useEffect(() => {
    setRevealed({});
  }, [environmentId]);

  const canWrite = can('secrets:create') || can('secrets:manage');
  const canUpdate = can('secrets:update') || can('secrets:manage');
  const canDelete = can('secrets:delete') || can('secrets:manage');
  const canReveal = can('secrets:reveal');

  async function toggleReveal(secret: WeldPassSecret) {
    if (revealed[secret.id] !== undefined) {
      setRevealed((current) => {
        const next = { ...current };
        delete next[secret.id];
        return next;
      });
      return;
    }
    setFailure(null);
    try {
      const result = await reveal.mutateAsync(secret.id);
      setRevealed((current) => ({ ...current, [secret.id]: result.value }));
    } catch (err) {
      setFailure(errorMessage(err, t('weldpass.secrets.revealFailed')));
    }
  }

  async function removeSecret(secret: WeldPassSecret) {
    if (!confirm(t('weldpass.secrets.deleteConfirm', { key: secret.key }))) return;
    setFailure(null);
    try {
      await deleteSecret.mutateAsync(secret.id);
    } catch (err) {
      setFailure(errorMessage(err, t('weldpass.secrets.deleteFailed')));
    }
  }

  async function downloadEnv() {
    setFailure(null);
    try {
      const values = await exportEnvironment.mutateAsync();
      const body = Object.keys(values)
        .sort()
        .map((key) => `${key}=${JSON.stringify(values[key])}`)
        .join('\n');
      const url = URL.createObjectURL(new Blob([body], { type: 'text/plain' }));
      const link = document.createElement('a');
      link.href = url;
      link.download = `${project?.slug ?? 'vault'}.${environment?.slug ?? 'env'}.env`;
      link.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      setFailure(errorMessage(err, t('weldpass.secrets.exportFailed')));
    }
  }

  if (isLoading) return <InlineSpinner />;
  if (!project) {
    return (
      <div className="p-6">
        <ErrorBanner error={errorMessage(error, t('weldpass.secrets.loadFailed'))} />
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-5xl space-y-4 p-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold">{project.name}</h1>
          {project.description && (
            <p className="text-sm text-muted-foreground">{project.description}</p>
          )}
        </div>
        <div className="flex gap-2">
          <Link to="/weldpass/$projectId/sync" params={{ projectId }}>
            <Button variant="outline" size="sm">
              {t('weldpass.sync')}
            </Button>
          </Link>
          <Link to="/weldpass/$projectId/audit" params={{ projectId }}>
            <Button variant="outline" size="sm">
              {t('weldpass.auditLog')}
            </Button>
          </Link>
        </div>
      </header>

      <div className="flex flex-wrap items-center gap-1 border-b pb-2">
        {project.environments.map((env) => (
          <button
            key={env.id}
            onClick={() =>
              navigate({
                to: '/weldpass/$projectId',
                params: { projectId },
                search: { env: env.id },
              })
            }
            className={cn(
              'rounded-md px-3 py-1.5 text-sm transition-colors',
              env.id === environmentId
                ? 'bg-secondary font-medium text-foreground'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {env.name}
            {env.isProduction && <span className="ml-1.5 text-amber-500">●</span>}
          </button>
        ))}
      </div>

      <ErrorBanner error={failure} onDismiss={() => setFailure(null)} />
      <AutoSyncSummary outcomes={autoSync} onDismiss={() => setAutoSync([])} />

      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground">
          {secrets
            ? secrets.length === 1
              ? t('weldpass.secrets.countOne')
              : t('weldpass.secrets.count', { count: secrets.length })
            : ' '}
          {environment?.isProduction && (
            <Badge variant="outline" className="ml-2">
              {t('weldpass.secrets.production')}
            </Badge>
          )}
        </p>
        <div className="flex flex-wrap gap-2">
          {canWrite && (
            <Button variant="outline" size="sm" onClick={() => setDialog({ kind: 'import' })}>
              <Upload className="mr-1.5 h-4 w-4" />
              {t('weldpass.secrets.importEnv')}
            </Button>
          )}
          {canReveal && (
            <Button
              variant="outline"
              size="sm"
              disabled={exportEnvironment.isPending}
              onClick={() => void downloadEnv()}
            >
              <Download className="mr-1.5 h-4 w-4" />
              {t('weldpass.secrets.export')}
            </Button>
          )}
          {canWrite && (
            <Button size="sm" onClick={() => setDialog({ kind: 'create' })}>
              <Plus className="mr-1.5 h-4 w-4" />
              {t('weldpass.secrets.addSecret')}
            </Button>
          )}
        </div>
      </div>

      {secretsLoading ? (
        <InlineSpinner />
      ) : !secrets || secrets.length === 0 ? (
        <EmptyState
          title={t('weldpass.secrets.emptyTitle')}
          description={t('weldpass.secrets.emptyDescription')}
          action={
            canWrite ? (
              <Button onClick={() => setDialog({ kind: 'import' })}>
                {t('weldpass.secrets.importEnv')}
              </Button>
            ) : undefined
          }
        />
      ) : (
        <Card className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left text-xs text-muted-foreground">
                <th className="px-4 py-2 font-medium">{t('weldpass.secrets.key')}</th>
                <th className="px-4 py-2 font-medium">{t('weldpass.secrets.value')}</th>
                <th className="px-4 py-2 font-medium">{t('weldpass.secrets.updatedColumn')}</th>
                <th className="w-px px-4 py-2" />
              </tr>
            </thead>
            <tbody>
              {secrets.map((secret) => (
                <SecretRow
                  key={secret.id}
                  secret={secret}
                  value={revealed[secret.id]}
                  canReveal={canReveal}
                  canUpdate={canUpdate}
                  canDelete={canDelete}
                  onReveal={() => void toggleReveal(secret)}
                  onEdit={() => setDialog({ kind: 'edit', secret })}
                  onHistory={() => setDialog({ kind: 'history', secret })}
                  onDelete={() => void removeSecret(secret)}
                />
              ))}
            </tbody>
          </table>
        </Card>
      )}

      {dialog?.kind === 'create' && (
        <SecretDialog
          projectId={projectId}
          environmentId={environmentId}
          onClose={() => setDialog(null)}
          onSaved={(outcomes) => {
            setDialog(null);
            setAutoSync(outcomes);
          }}
        />
      )}

      {dialog?.kind === 'edit' && (
        <SecretDialog
          projectId={projectId}
          environmentId={environmentId}
          secret={dialog.secret}
          onClose={() => setDialog(null)}
          onSaved={(outcomes) => {
            setDialog(null);
            setAutoSync(outcomes);
          }}
        />
      )}

      {dialog?.kind === 'import' && (
        <ImportDialog
          projectId={projectId}
          environmentId={environmentId}
          onClose={() => setDialog(null)}
          onImported={(result) => {
            setDialog(null);
            setAutoSync(result.autoSync);
          }}
        />
      )}

      {dialog?.kind === 'history' && (
        <HistoryDialog
          projectId={projectId}
          environmentId={environmentId}
          secret={dialog.secret}
          onClose={() => setDialog(null)}
          onRestored={() => setDialog(null)}
        />
      )}
    </div>
  );
}

function SecretRow({
  secret,
  value,
  canReveal,
  canUpdate,
  canDelete,
  onReveal,
  onEdit,
  onHistory,
  onDelete,
}: {
  secret: WeldPassSecret;
  value: string | undefined;
  canReveal: boolean;
  canUpdate: boolean;
  canDelete: boolean;
  onReveal: () => void;
  onEdit: () => void;
  onHistory: () => void;
  onDelete: () => void;
}) {
  const t = useTranslations();
  const [copied, setCopied] = useState(false);
  const isRevealed = value !== undefined;

  async function copy() {
    if (!isRevealed) return;
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard access can be denied; the value is on screen either way.
    }
  }

  return (
    <tr className="border-b last:border-0">
      <td className="px-4 py-2 font-mono text-xs">{secret.key}</td>
      <td className="px-4 py-2">
        {isRevealed ? (
          <span className="break-all font-mono text-xs">{value}</span>
        ) : (
          <span className="font-mono text-xs text-muted-foreground">
            {'•'.repeat(Math.min(secret.valueLength, 24))}
            {secret.valueHint && <span className="ml-1 opacity-70">{secret.valueHint}</span>}
          </span>
        )}
        {secret.note && <p className="mt-0.5 text-xs text-muted-foreground">{secret.note}</p>}
      </td>
      <td className="px-4 py-2 text-xs">
        <TimeAgo value={secret.updatedAt} />
        <span className="ml-1 text-muted-foreground">· v{secret.version}</span>
      </td>
      <td className="px-4 py-2">
        <div className="flex items-center justify-end gap-0.5">
          {canReveal && (
            <Button
              variant="ghost"
              size="sm"
              onClick={onReveal}
              aria-label={isRevealed ? t('weldpass.secrets.hide') : t('weldpass.secrets.reveal')}
            >
              {isRevealed ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
            </Button>
          )}
          {isRevealed && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => void copy()}
              aria-label={t('weldpass.secrets.copy')}
            >
              {copied ? (
                <Check className="h-4 w-4 text-emerald-500" />
              ) : (
                <Copy className="h-4 w-4" />
              )}
            </Button>
          )}
          <Button
            variant="ghost"
            size="sm"
            onClick={onHistory}
            aria-label={t('weldpass.secrets.history')}
          >
            <History className="h-4 w-4" />
          </Button>
          {canUpdate && (
            <Button variant="ghost" size="sm" onClick={onEdit}>
              {t('weldpass.secrets.edit')}
            </Button>
          )}
          {canDelete && (
            <Button
              variant="ghost"
              size="sm"
              onClick={onDelete}
              aria-label={t('weldpass.secrets.delete')}
            >
              <Trash2 className="h-4 w-4" />
            </Button>
          )}
        </div>
      </td>
    </tr>
  );
}
