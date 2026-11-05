import { useEffect, useRef, useState } from 'react';
import { GitBranch, Loader2, Plus, RefreshCw, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { useCan } from '@weldsuite/permissions/react';
import { Button } from '@weldsuite/ui/components/button';
import { ConfirmDialog } from '@weldsuite/ui/components/confirm-dialog';
import { EmptyState } from '@weldsuite/ui/components/empty-state';
import { ErrorState } from '@weldsuite/ui/components/error-banner';
import { InfoBanner } from '@weldsuite/ui/components/info-banner';
import { ListTable, type ListTableAction, type ListTableColumn } from '@weldsuite/ui/components/list-table';
import { PageLoader } from '@weldsuite/ui/components/page-loader';
import { SectionCard } from '@weldsuite/ui/components/section-card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@weldsuite/ui/components/select';
import { SoftBadge } from '@weldsuite/ui/components/soft-badge';
import { Switch } from '@weldsuite/ui/components/switch';
import type {
  MergeConnectionDto,
  MergeConnectionStatus,
  MergeProvider,
  MergeRepositoryDto,
} from '@weldsuite/app-api-client/schemas/weldmerge';
import { useGetInstallUrl } from '@/hooks/queries/use-github-queries';
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
import { useI18n } from '@/lib/i18n/provider';
import { useRouter } from '@/lib/router';
import { fill, relativeTime } from '../lib/format';
import { AddRepositoriesDialog } from './add-repositories-dialog';

const NO_TEAM = '__none__';
const COMING_SOON_PROVIDERS: readonly Exclude<MergeProvider, 'github'>[] = ['gitlab', 'bitbucket', 'azure_devops'];
const SETTINGS_PATH = '/weldmerge/settings';

function statusTone(status: MergeConnectionStatus): 'success' | 'warning' | 'danger' {
  if (status === 'active') return 'success';
  if (status === 'revoked') return 'danger';
  return 'warning';
}

/**
 * Git providers: the GitHub card (connect by adopting the workspace's GitHub
 * App installation, installing it first when there is none), the repositories
 * being followed, and the providers that are still to come.
 *
 * Returning from the GitHub installation lands on `?installed=1`; the page then
 * retries the connection once.
 */
export function ProvidersSection({ installed }: Readonly<{ installed: boolean }>) {
  const { t, language } = useI18n();
  const tm = t.weldmerge;
  const tg = tm.settings.providers;
  const tr = tm.settings.repositories;
  const router = useRouter();
  const canManage = useCan('merge_connections:manage');

  const connections = useMergeConnections();
  const repositories = useMergeRepositories();
  const teams = useMergeTeams();
  const connect = useConnectMergeGithub();
  const installUrl = useGetInstallUrl();
  const removeConnection = useRemoveMergeConnection();
  const updateRepository = useUpdateMergeRepository();
  const syncRepository = useSyncMergeRepository();
  const removeRepository = useRemoveMergeRepository();

  const [adding, setAdding] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const [removing, setRemoving] = useState<MergeRepositoryDto | null>(null);

  const github: MergeConnectionDto | undefined = (connections.data ?? []).find((c) => c.provider === 'github');

  const startConnect = async () => {
    try {
      const result = await connect.mutateAsync();
      if (result.status === 'connected') {
        toast.success(tg.github.connected);
        return;
      }
      // No GitHub App installation yet: install it, then come back here.
      const returnTo = `${window.location.origin}${SETTINGS_PATH}?installed=1`;
      const { data } = await installUrl.mutateAsync({ returnTo });
      toast.message(tg.github.installing);
      window.location.assign(data.url);
    } catch {
      toast.error(tg.github.connectFailed);
    }
  };

  // Back from GitHub: adopt the installation that now exists, once.
  const retried = useRef(false);
  useEffect(() => {
    if (!installed || retried.current || !canManage) return;
    retried.current = true;
    void (async () => {
      try {
        const result = await connect.mutateAsync();
        if (result.status === 'connected') toast.success(tg.github.connected);
        else toast.error(tg.github.connectFailed);
      } catch {
        toast.error(tg.github.connectFailed);
      } finally {
        router.replace(SETTINGS_PATH);
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
    if (!github) return;
    try {
      await removeConnection.mutateAsync(github.id);
      setDisconnecting(false);
    } catch {
      toast.error(tg.github.removeFailed);
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

  const patchRepository = (id: string, input: { teamId?: string | null; prSync?: boolean }) =>
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
      cell: (repo) => (
        <div className="min-w-0">
          <p className="truncate text-sm font-medium">{repo.fullName}</p>
          <p className="text-xs text-muted-foreground">{fill(tr.openCount, { count: repo.openPullRequestCount })}</p>
        </div>
      ),
    },
    {
      id: 'provider',
      header: tr.columns.provider,
      width: 'w-[6rem]',
      className: 'hidden md:flex',
      cell: (repo) => <span className="text-sm">{tm.provider[repo.provider]}</span>,
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
      width: 'w-[8rem]',
      className: 'hidden lg:flex',
      cell: () => <span className="text-sm text-muted-foreground">{tr.issueSyncOff}</span>,
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
        { id: 'remove', label: t.common.actions.remove, icon: Trash2, variant: 'destructive', separatorAbove: true, onClick: setRemoving },
      ]
    : [];

  return (
    <div className="space-y-8">
      <div className="space-y-4">
        <div className="space-y-1">
          <h2 className="text-base font-semibold">{tg.title}</h2>
          <p className="text-sm text-muted-foreground">{tg.description}</p>
        </div>

        <div className="grid gap-4 md:grid-cols-2">
          <SectionCard
            title={
              <span className="flex items-center gap-2">
                <GitBranch className="size-4" />
                {tm.provider.github}
              </span>
            }
            action={github ? <SoftBadge tone={statusTone(github.status)}>{tg.status[github.status]}</SoftBadge> : undefined}
          >
            <div className="space-y-4">
              <p className="text-sm text-muted-foreground">
                {github
                  ? fill(tg.github.accountLine, { account: github.accountLogin ?? tm.provider.github, count: github.repositoryCount })
                  : tg.github.description}
              </p>
              {canManage && (
                <div className="flex flex-wrap gap-2">
                  {github ? (
                    <>
                      <Button size="sm" onClick={() => setAdding(true)}>
                        <Plus />
                        {tr.add}
                      </Button>
                      <Button size="sm" variant="outline" onClick={() => setDisconnecting(true)}>
                        {tg.github.remove}
                      </Button>
                    </>
                  ) : (
                    <Button size="sm" onClick={() => void startConnect()} disabled={connect.isPending || installUrl.isPending}>
                      {(connect.isPending || installUrl.isPending) && <Loader2 className="animate-spin" />}
                      {connect.isPending ? tg.github.connecting : tg.github.connect}
                    </Button>
                  )}
                </div>
              )}
            </div>
          </SectionCard>

          {COMING_SOON_PROVIDERS.map((provider) => (
            <SectionCard
              key={provider}
              className="opacity-70"
              title={
                <span className="flex items-center gap-2">
                  <GitBranch className="size-4" />
                  {tm.provider[provider]}
                </span>
              }
              action={<SoftBadge tone="neutral">{tg.comingSoon}</SoftBadge>}
            >
              <p className="text-sm text-muted-foreground">{tg.comingSoonDescription[provider]}</p>
            </SectionCard>
          ))}
        </div>

        <InfoBanner variant="neutral">{tg.linkingNote}</InfoBanner>
      </div>

      <div className="space-y-3">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-base font-semibold">{tr.title}</h2>
          {canManage && github && (
            <Button size="sm" variant="outline" onClick={() => setAdding(true)}>
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

      <AddRepositoriesDialog open={adding} onOpenChange={setAdding} connectionId={github?.id} teams={teams.data ?? []} />
      <ConfirmDialog
        open={disconnecting}
        onOpenChange={setDisconnecting}
        title={tg.github.removeTitle}
        description={tg.github.removeDescription}
        confirmLabel={tg.github.remove}
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
