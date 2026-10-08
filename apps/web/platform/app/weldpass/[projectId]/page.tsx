/**
 * One WeldPass project: the secrets in the selected environment.
 *
 * Values are masked until explicitly revealed, and a reveal is a separate
 * request — the list endpoint never carries plaintext, so nothing sensitive
 * sits in the query cache or a network log just because someone opened the page.
 */

import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { Check, Copy, Download, Eye, EyeOff, History, KeyRound, SearchX, Upload } from 'lucide-react';
import { Badge } from '@weldsuite/ui/components/badge';
import { Button } from '@weldsuite/ui/components/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@weldsuite/ui/components/select';
import { useTranslations } from '@weldsuite/i18n/client';
import { usePermissions } from '@weldsuite/permissions/react';
import type {
  WeldPassAutoSyncOutcome,
  WeldPassEnvironment,
  WeldPassSecret,
} from '@weldsuite/app-api-client/domains/weldpass';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { PageLoader } from '@/components/page-loader';
import { PanelEntityList, type ColumnDef } from '@/components/panel-entity-list';
import { useParams } from '@/lib/router';
import {
  useDeleteWeldPassSecret,
  useExportWeldPassEnvironment,
  useWeldPassProject,
  useWeldPassSecrets,
} from '@/hooks/queries/use-weldpass-queries';
import { cn } from '@/lib/utils';
import { emptyIcon, TabBody } from '../components/page-kit';
import { AutoSyncSummary, ErrorBanner, TimeAgo, errorMessage } from '../components/shared';
import { HistoryDialog, ImportDialog, SecretDialog, useRevealer } from '../components/secret-dialogs';
import { ProjectPage } from './components/project-page';

type Dialog =
  | { kind: 'create' }
  | { kind: 'edit'; secret: WeldPassSecret }
  | { kind: 'import' }
  | { kind: 'history'; secret: WeldPassSecret }
  | { kind: 'delete'; secret: WeldPassSecret }
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

  const [query, setQuery] = useState('');
  const [revealed, setRevealed] = useState<Record<string, string>>({});
  const [dialog, setDialog] = useState<Dialog>(null);
  const [autoSync, setAutoSync] = useState<WeldPassAutoSyncOutcome[]>([]);
  const [failure, setFailure] = useState<string | null>(null);

  // The toolbar sits above the tabs, outside the list, so the search is
  // applied here rather than by the list.
  const visibleSecrets = useMemo(() => {
    const all = secrets ?? [];
    const needle = query.trim().toLowerCase();
    if (!needle) return all;
    return all.filter((secret) =>
      [secret.key, secret.note].some((value) => value?.toLowerCase().includes(needle)),
    );
  }, [secrets, query]);
  const isSearchMiss = visibleSecrets.length === 0 && (secrets?.length ?? 0) > 0;

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
    setFailure(null);
    try {
      await deleteSecret.mutateAsync(secret.id);
    } catch (err) {
      setFailure(errorMessage(err, t('weldpass.secrets.deleteFailed')));
    } finally {
      setDialog(null);
    }
  }

  async function downloadEnv() {
    setFailure(null);
    try {
      const values = await exportEnvironment.mutateAsync();
      const body = Object.keys(values)
        .sort((a, b) => (a < b ? -1 : 1))
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

  if (isLoading) return <PageLoader fullScreen={false} />;
  if (!project) {
    return (
      <TabBody>
        <ErrorBanner error={errorMessage(error, t('weldpass.secrets.loadFailed'))} />
      </TabBody>
    );
  }

  const columns: ColumnDef<WeldPassSecret>[] = [
    {
      id: 'key',
      header: t('weldpass.secrets.key'),
      width: 'w-[280px]',
      render: (secret) => (
        <span className="block min-w-0">
          <span className="block truncate font-mono text-xs">{secret.key}</span>
          {secret.note && (
            <span className="block truncate text-xs text-muted-foreground">{secret.note}</span>
          )}
        </span>
      ),
    },
    {
      id: 'value',
      header: t('weldpass.secrets.value'),
      width: 'flex-1',
      render: (secret) => <SecretValue secret={secret} value={revealed[secret.id]} />,
    },
    {
      id: 'updated',
      header: t('weldpass.secrets.updatedColumn'),
      width: 'w-[150px]',
      render: (secret) => (
        <span className="text-xs">
          <TimeAgo value={secret.updatedAt} />
          <span className="ml-1 text-muted-foreground">· v{secret.version}</span>
        </span>
      ),
    },
    {
      id: 'actions',
      header: '',
      width: 'w-[108px]',
      render: (secret) => (
        <SecretActions
          value={revealed[secret.id]}
          canReveal={canReveal}
          onReveal={() => void toggleReveal(secret)}
          onHistory={() => setDialog({ kind: 'history', secret })}
        />
      ),
    },
  ];

  const environmentSelect = (className?: string) => (
    <EnvironmentSelect
      environments={project.environments}
      value={environmentId}
      className={className}
      label={t('weldpass.secrets.environment')}
      onChange={(id) =>
        void navigate({ to: '/weldpass/$projectId', params: { projectId }, search: { env: id } })
      }
    />
  );

  return (
    <ProjectPage
      projectId={projectId}
      section="secrets"
      toolbar={{
        search: query,
        onSearchChange: setQuery,
        searchPlaceholder: t('weldpass.secrets.searchPlaceholder'),
        // The left of the toolbar is hidden on small screens, so the
        // environment switch is repeated on the right there.
        leftActionButtons: (
          <>
            {environmentSelect()}
            {environment?.isProduction && (
              <Badge variant="outline">{t('weldpass.secrets.production')}</Badge>
            )}
          </>
        ),
        actionButtons: (
          <>
            {environmentSelect('md:hidden')}
            {canWrite && (
              <Button
                variant="outline"
                size="sm"
                className="h-8"
                onClick={() => setDialog({ kind: 'import' })}
              >
                <Upload className="h-4 w-4 md:mr-1.5" />
                <span className="hidden md:inline">{t('weldpass.secrets.importEnv')}</span>
              </Button>
            )}
            {canReveal && (
              <Button
                variant="outline"
                size="sm"
                className="h-8"
                disabled={exportEnvironment.isPending}
                onClick={() => void downloadEnv()}
              >
                <Download className="h-4 w-4 md:mr-1.5" />
                <span className="hidden md:inline">{t('weldpass.secrets.export')}</span>
              </Button>
            )}
          </>
        ),
        createButton: canWrite
          ? { label: t('weldpass.secrets.addSecret'), onClick: () => setDialog({ kind: 'create' }) }
          : undefined,
      }}
    >
      {(failure || autoSync.length > 0) && (
        <div className="space-y-2 border-b px-4 py-3">
          <ErrorBanner error={failure} onDismiss={() => setFailure(null)} />
          <AutoSyncSummary outcomes={autoSync} onDismiss={() => setAutoSync([])} />
        </div>
      )}

      <PanelEntityList<WeldPassSecret>
        items={visibleSecrets}
        isLoading={secretsLoading}
        columns={columns}
        hideTopBar
        onRowClick={canUpdate ? (secret) => setDialog({ kind: 'edit', secret }) : undefined}
        onEdit={canUpdate ? (secret) => setDialog({ kind: 'edit', secret }) : undefined}
        onDelete={canDelete ? (secret) => setDialog({ kind: 'delete', secret }) : undefined}
        emptyState={
          isSearchMiss
            ? {
                icon: emptyIcon(SearchX),
                title: t('weldpass.secrets.noResultsTitle'),
                description: t('weldpass.secrets.noResultsDescription'),
              }
            : {
                icon: emptyIcon(KeyRound),
                title: t('weldpass.secrets.emptyTitle'),
                description: t('weldpass.secrets.emptyDescription'),
                action: canWrite
                  ? {
                      label: t('weldpass.secrets.importEnv'),
                      onClick: () => setDialog({ kind: 'import' }),
                    }
                  : undefined,
              }
        }
      />

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

      {dialog?.kind === 'delete' && (
        <ConfirmDialog
          open
          onOpenChange={(open) => !open && setDialog(null)}
          title={t('weldpass.secrets.deleteTitle', { key: dialog.secret.key })}
          description={t('weldpass.secrets.deleteDescription')}
          confirmLabel={t('weldpass.secrets.delete')}
          cancelLabel={t('weldpass.secrets.form.cancel')}
          variant="destructive"
          loading={deleteSecret.isPending}
          onConfirm={() => removeSecret(dialog.secret)}
        />
      )}
    </ProjectPage>
  );
}

function EnvironmentSelect({
  environments,
  value,
  label,
  className,
  onChange,
}: Readonly<{
  environments: WeldPassEnvironment[];
  value: string;
  label: string;
  className?: string;
  onChange: (environmentId: string) => void;
}>) {
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger
        aria-label={label}
        // The default size sets its own height, which outranks an `h-8` class.
        size="sm"
        className={cn('w-[180px] text-sm shadow-none', className)}
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {environments.map((environment) => (
          <SelectItem key={environment.id} value={environment.id}>
            {environment.name}
            {environment.secretCount !== undefined && (
              <span className="ml-1.5 text-muted-foreground">{environment.secretCount}</span>
            )}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function SecretValue({
  secret,
  value,
}: Readonly<{ secret: WeldPassSecret; value: string | undefined }>) {
  if (value !== undefined) {
    return <span className="block break-all font-mono text-xs">{value}</span>;
  }
  return (
    <span className="block truncate font-mono text-xs text-muted-foreground">
      {'•'.repeat(Math.min(secret.valueLength, 24))}
      {secret.valueHint && <span className="ml-1 opacity-70">{secret.valueHint}</span>}
    </span>
  );
}

/**
 * Reveal, copy and history, inline on the row. The row itself is clickable
 * (it opens the edit dialog), so these stop the click from reaching it.
 */
function SecretActions({
  value,
  canReveal,
  onReveal,
  onHistory,
}: Readonly<{
  value: string | undefined;
  canReveal: boolean;
  onReveal: () => void;
  onHistory: () => void;
}>) {
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
    // The buttons inside handle the keyboard; this only keeps a click on them
    // from also opening the row.
    <div className="flex items-center justify-end gap-0.5" onClick={(event) => event.stopPropagation()}>
      {isRevealed && (
        <Button
          variant="ghost"
          size="sm"
          className="h-7 w-7 p-0"
          onClick={() => void copy()}
          aria-label={t('weldpass.secrets.copy')}
          title={t('weldpass.secrets.copy')}
        >
          {copied ? <Check className="h-4 w-4 text-emerald-500" /> : <Copy className="h-4 w-4" />}
        </Button>
      )}
      {canReveal && (
        <Button
          variant="ghost"
          size="sm"
          className="h-7 w-7 p-0"
          onClick={onReveal}
          aria-label={isRevealed ? t('weldpass.secrets.hide') : t('weldpass.secrets.reveal')}
          title={isRevealed ? t('weldpass.secrets.hide') : t('weldpass.secrets.reveal')}
        >
          {isRevealed ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
        </Button>
      )}
      <Button
        variant="ghost"
        size="sm"
        className="h-7 w-7 p-0"
        onClick={onHistory}
        aria-label={t('weldpass.secrets.history')}
        title={t('weldpass.secrets.history')}
      >
        <History className="h-4 w-4" />
      </Button>
    </div>
  );
}
