import { useEffect, useRef, useState } from 'react';
import { Download, GitBranch, Plus, RefreshCw, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { useCan } from '@weldsuite/permissions/react';
import { Button } from '@weldsuite/ui/components/button';
import { ConfirmDialog } from '@weldsuite/ui/components/confirm-dialog';
import { EmptyState } from '@weldsuite/ui/components/empty-state';
import { ErrorState } from '@weldsuite/ui/components/error-banner';
import { InfoBanner } from '@weldsuite/ui/components/info-banner';
import { ListTable, type ListTableAction, type ListTableColumn } from '@weldsuite/ui/components/list-table';
import { PageLoader } from '@weldsuite/ui/components/page-loader';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@weldsuite/ui/components/select';
import { Switch } from '@weldsuite/ui/components/switch';
import {
  MERGE_PROVIDERS,
  type MergeConnectionDto,
  type MergeIssueSyncMode,
  type MergeProvider,
  type MergeRepositoryDto,
} from '@weldsuite/app-api-client/schemas/weldmerge';
import {
  useConnectMergeGithub,
  useMergeConnections,
  useMergeRepositories,
  useMergeTeams,
  useRemoveMergeConnection,
  useRemoveMergeRepository,
  useSyncMergeRepository,
  useUpdateMergeRepository,
} from '@/hooks/queries/use-weldmerge-queries';
import { useConnectMergeGitlab, useImportMergeIssues } from '@/hooks/queries/use-weldmerge-sync-queries';
import { useI18n } from '@/lib/i18n/provider';
import { useRouter } from '@/lib/router';
import { ProviderLogo } from '../components/provider-logo';
import { fill, relativeTime } from '../lib/format';
import { ISSUE_SYNC_MODES_BY_PROVIDER, repositoryProjectLabel, supportsIssueSync } from '../lib/issue-sync';
import { AddRepositoriesDialog } from './add-repositories-dialog';
import { GitlabTokenDialog } from '../components/gitlab-token-dialog';
import { ProviderCard } from './provider-card';
import { useProviderConnect } from './use-provider-connect';

const NO_TEAM = '__none__';
const SETTINGS_PATH = '/weldmerge/settings';

/** The message for a refused GitHub installation (`?error=` from the setup route). */
export function installErrorMessage(
  code: string,
  messages: { stateExpired: string; installationUnverified: string; installationTaken: string; generic: string },
): string {
  const byCode: Record<string, string> = {
    state_expired: messages.stateExpired,
    installation_unverified: messages.installationUnverified,
    installation_taken: messages.installationTaken,
  };
  return byCode[code] ?? messages.generic;
}

/**
 * Git providers: a card per provider (GitHub through the App, GitLab, Bitbucket
 * and Azure DevOps through OAuth, self-managed GitLab with a token), their
 * connection status, and the repositories being followed with their pull
 * request and issue sync settings.
 *
 * Returning from the GitHub installation lands on `?installed=1`; the page then
 * adopts the connection once (a no-op when the setup route already recorded it).
 * A refused installation lands on `?error=<code>`, shown as a warning.
 */
export function ProvidersSection({
  installed,
  installError = null,
}: Readonly<{ installed: boolean; installError?: string | null }>) {
  const { t, language } = useI18n();
  const tm = t.weldmerge;
  const tg = tm.settings.providers;
  const tr = tm.settings.repositories;
  const ts = tm.sync.providers;
  const trs = tm.sync.repositories;
  const router = useRouter();
  const canManage = useCan('merge_connections:manage');

  const connections = useMergeConnections();
  const repositories = useMergeRepositories();
  const teams = useMergeTeams();
  const adoptGithub = useConnectMergeGithub();
  const connectGitlab = useConnectMergeGitlab();
  const { connect } = useProviderConnect();
  const removeConnection = useRemoveMergeConnection();
  const updateRepository = useUpdateMergeRepository();
  const syncRepository = useSyncMergeRepository();
  const importIssues = useImportMergeIssues();
  const removeRepository = useRemoveMergeRepository();

  const [starting, setStarting] = useState<MergeProvider | null>(null);
  const [addingTo, setAddingTo] = useState<string | null>(null);
  const [gitlabDialog, setGitlabDialog] = useState<{ open: boolean; host: string | null }>({ open: false, host: null });
  const [disconnecting, setDisconnecting] = useState<MergeConnectionDto | null>(null);
  const [removing, setRemoving] = useState<MergeRepositoryDto | null>(null);

  const all = connections.data ?? [];
  const activeConnections = all.filter((connection) => connection.status === 'active');

  const start = async (provider: MergeProvider, options: { reconnect?: boolean } = {}) => {
    setStarting(provider);
    try {
      await connect(provider, options);
    } finally {
      setStarting(null);
    }
  };

  const reconnect = (connection: MergeConnectionDto) => {
    if (connection.provider === 'gitlab' && connection.host) {
      setGitlabDialog({ open: true, host: connection.host });
      return;
    }
    void start(connection.provider, { reconnect: true });
  };

  // Back from GitHub: adopt the installation that now exists, once.
  const retried = useRef(false);
  useEffect(() => {
    if (!installed || retried.current || !canManage) return;
    retried.current = true;
    void (async () => {
      try {
        const result = await adoptGithub.mutateAsync();
        if (result.status === 'connected') toast.success(fill(ts.connected, { provider: tm.provider.github }));
        else toast.error(fill(ts.startFailed, { provider: tm.provider.github }));
      } catch {
        toast.error(fill(ts.startFailed, { provider: tm.provider.github }));
      } finally {
        router.replace(`${SETTINGS_PATH}?tab=providers`);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one retry per arrival
  }, [installed, canManage]);

  if (connections.isLoading || repositories.isLoading) return <PageLoader fullScreen={false} />;
  if (connections.isError || repositories.isError) {
    return (
      <ErrorState
        message={tm.loadFailed}
        retryLabel={tm.retry}
        onRetry={() => {
          void connections.refetch();
          void repositories.refetch();
        }}
      />
    );
  }

  const handleDisconnect = async () => {
    if (!disconnecting) return;
    try {
      await removeConnection.mutateAsync(disconnecting.id);
      setDisconnecting(null);
    } catch {
      toast.error(fill(ts.disconnectFailed, { provider: tm.provider[disconnecting.provider] }));
    }
  };

  const handleSync = async (repo: MergeRepositoryDto) => {
    toast.message(tr.refresh);
    try {
      const result = await syncRepository.mutateAsync(repo.id);
      toast.success(fill(tr.synced, { count: result.pullRequestsSynced, links: result.linksCreated }));
    } catch {
      toast.error(tr.syncFailed);
    }
  };

  const handleImport = async (repo: MergeRepositoryDto) => {
    toast.message(trs.importing);
    try {
      const result = await importIssues.mutateAsync(repo.id);
      toast.success(fill(trs.imported, { imported: result.imported, updated: result.updated, skipped: result.skipped }));
    } catch {
      toast.error(trs.importFailed);
    }
  };

  const patchRepository = (id: string, input: { teamId?: string | null; prSync?: boolean; issueSync?: MergeIssueSyncMode }) =>
    updateRepository.mutate({ id, input }, { onError: () => toast.error(tr.updateFailed) });

  const confirmRemoveRepository = async () => {
    if (!removing) return;
    try {
      await removeRepository.mutateAsync(removing.id);
      setRemoving(null);
    } catch {
      toast.error(tr.removeFailed);
    }
  };

  const columns: ListTableColumn<MergeRepositoryDto>[] = [
    {
      id: 'repository',
      header: tr.columns.repository,
      className: 'flex-1 min-w-[12rem]',
      cell: (repo) => {
        const project = repositoryProjectLabel(repo);
        return (
          <div className="min-w-0">
            <p className="truncate text-sm font-medium">{repo.fullName}</p>
            <p className="truncate text-xs text-muted-foreground">
              {project ? `${trs.project}: ${project} · ` : ''}
              {fill(tr.openCount, { count: repo.openPullRequestCount })}
            </p>
          </div>
        );
      },
    },
    {
      id: 'provider',
      header: tr.columns.provider,
      width: 'w-[8rem]',
      className: 'hidden md:flex',
      cell: (repo) => (
        <span className="flex items-center gap-1.5 text-sm">
          <ProviderLogo provider={repo.provider} />
          {tm.provider[repo.provider]}
        </span>
      ),
    },
    {
      id: 'team',
      header: tr.columns.team,
      width: 'w-[11rem]',
      cell: (repo) => (
        <Select
          value={repo.teamId ?? NO_TEAM}
          disabled={!canManage}
          onValueChange={(value) => patchRepository(repo.id, { teamId: value === NO_TEAM ? null : value })}
        >
          <SelectTrigger size="sm" className="w-full" aria-label={`${tr.columns.team}: ${repo.fullName}`}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={NO_TEAM}>{tr.noTeam}</SelectItem>
            {(teams.data ?? []).map((team) => (
              <SelectItem key={team.id} value={team.id}>
                {team.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ),
    },
    {
      id: 'issueSync',
      header: tr.columns.issueSync,
      width: 'w-[9rem]',
      className: 'hidden lg:flex',
      cell: (repo) =>
        supportsIssueSync(repo.provider) ? (
          <Select
            value={repo.issueSync}
            disabled={!canManage}
            onValueChange={(value) => patchRepository(repo.id, { issueSync: value as MergeIssueSyncMode })}
          >
            <SelectTrigger size="sm" className="w-full" aria-label={`${tr.columns.issueSync}: ${repo.fullName}`}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {ISSUE_SYNC_MODES_BY_PROVIDER[repo.provider].map((mode) => (
                <SelectItem key={mode} value={mode} title={trs.issueSyncHints[mode]}>
                  {trs.issueSyncModes[mode]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : (
          <span className="text-sm text-muted-foreground">{trs.issueSyncNotAvailable}</span>
        ),
    },
    {
      id: 'prSync',
      header: tr.columns.prSync,
      width: 'w-[6rem]',
      cell: (repo) => (
        <Switch
          checked={repo.prSync}
          disabled={!canManage}
          aria-label={`${tr.columns.prSync}: ${repo.fullName}`}
          onCheckedChange={(checked) => patchRepository(repo.id, { prSync: checked })}
        />
      ),
    },
    {
      id: 'lastSynced',
      header: tr.columns.lastSynced,
      width: 'w-[7rem]',
      className: 'hidden xl:flex',
      cell: (repo) => (
        <span className="text-xs text-muted-foreground">
          {repo.lastSyncedAt ? relativeTime(repo.lastSyncedAt, language, tm.justNow) : tr.never}
        </span>
      ),
    },
  ];

  const actions: ListTableAction<MergeRepositoryDto>[] = canManage
    ? [
        {
          id: 'sync',
          label: tr.refresh,
          icon: RefreshCw,
          onClick: (repo) => void handleSync(repo),
        },
        {
          id: 'import',
          label: trs.importIssues,
          icon: Download,
          hidden: (repo) => !supportsIssueSync(repo.provider),
          onClick: (repo) => void handleImport(repo),
        },
        { id: 'remove', label: t.common.actions.remove, icon: Trash2, variant: 'destructive', separatorAbove: true, onClick: setRemoving },
      ]
    : [];

  const soleActive = activeConnections.length === 1 ? activeConnections[0] : undefined;

  return (
    <div className="space-y-8">
      {installError && <InfoBanner variant="warning">{installErrorMessage(installError, ts.installErrors)}</InfoBanner>}
      <div className="space-y-4">
        <div className="space-y-1">
          <h2 className="text-base font-semibold">{tg.title}</h2>
          <p className="text-sm text-muted-foreground">{tg.description}</p>
        </div>

        <div className="grid gap-4 md:grid-cols-2">
          {MERGE_PROVIDERS.map((provider) => (
            <ProviderCard
              key={provider}
              provider={provider}
              connections={all.filter((connection) => connection.provider === provider)}
              canManage={canManage}
              busy={starting === provider}
              onConnect={(target) => void start(target)}
              onConnectSelfManaged={() => setGitlabDialog({ open: true, host: null })}
              onReconnect={reconnect}
              onDisconnect={setDisconnecting}
              onAddRepositories={(connection) => setAddingTo(connection.id)}
            />
          ))}
        </div>

        <InfoBanner variant="neutral">{tg.linkingNote}</InfoBanner>
      </div>

      <div className="space-y-3">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-base font-semibold">{tr.title}</h2>
          {canManage && soleActive && (
            <Button size="sm" variant="outline" onClick={() => setAddingTo(soleActive.id)}>
              <Plus />
              {tr.add}
            </Button>
          )}
        </div>
        {(repositories.data ?? []).length === 0 ? (
          <EmptyState icon={GitBranch} title={tr.empty} />
        ) : (
          <ListTable
            columns={columns}
            data={repositories.data ?? []}
            rowKey={(repo) => repo.id}
            actions={actions}
            dense
          />
        )}
      </div>

      <AddRepositoriesDialog
        open={addingTo !== null}
        onOpenChange={(open) => !open && setAddingTo(null)}
        connectionId={addingTo ?? undefined}
        teams={teams.data ?? []}
      />
      <GitlabTokenDialog
        open={gitlabDialog.open}
        onOpenChange={(open) => setGitlabDialog((current) => ({ ...current, open }))}
        mode="connection"
        defaultHost={gitlabDialog.host}
        onSubmit={(input) => connectGitlab.mutateAsync(input)}
      />
      <ConfirmDialog
        open={disconnecting !== null}
        onOpenChange={(open) => !open && setDisconnecting(null)}
        title={fill(ts.disconnectTitle, { provider: tm.provider[disconnecting?.provider ?? 'github'] })}
        description={fill(ts.disconnectDescription, { provider: tm.provider[disconnecting?.provider ?? 'github'] })}
        confirmLabel={ts.disconnect}
        variant="destructive"
        loading={removeConnection.isPending}
        onConfirm={handleDisconnect}
      />
      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(open) => !open && setRemoving(null)}
        title={tr.removeTitle}
        description={fill(tr.removeDescription, { name: removing?.fullName ?? '' })}
        confirmLabel={t.common.actions.remove}
        variant="destructive"
        loading={removeRepository.isPending}
        onConfirm={confirmRemoveRepository}
      />
    </div>
  );
}
