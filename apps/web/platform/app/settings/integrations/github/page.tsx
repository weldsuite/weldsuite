import * as React from 'react';
import { useRouter } from '@/lib/router';
import { useSearchParams } from '@/lib/router';
import {
  Loader2,
  Unplug,
  RefreshCw,
  ExternalLink,
  Github,
  Globe,
  FileText,
} from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { Switch } from '@weldsuite/ui/components/switch';
import { cn } from '@/lib/utils';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { IntegrationDetailLayout } from '@/components/settings';
import { toast } from 'sonner';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@weldsuite/ui/components/select';
import { usePermissions } from '@weldsuite/permissions/react';
import {
  useGithubConnection,
  useLinkedRepos,
  useGetInstallUrl,
  useDisconnectGithub,
  useUpdateRepoLink,
  useUnlinkRepo,
  useGithubSync,
  useDiscoverableInstallations,
  useRecoverInstallation,
} from '@/hooks/queries/use-github-queries';
import { getTranslations } from '@/lib/i18n';
import type { GithubConnection, GithubRepoLink } from '@weldsuite/core-api-client/schemas/github';
import type { DiscoverableInstallation } from '@weldsuite/core-api-client/schemas/github';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@weldsuite/ui/components/dialog';
import { PageLoader } from '@/components/page-loader';

function formatRelativeTime(dateStr: string | null): string {
  if (!dateStr) return 'Never';
  const date = new Date(dateStr);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  if (diffMins < 1) return 'Just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  const diffHours = Math.floor(diffMins / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  const diffDays = Math.floor(diffHours / 24);
  if (diffDays < 7) return `${diffDays}d ago`;
  return date.toLocaleDateString();
}

function StatusBadge({ status }: { status: GithubConnection['status'] }) {
  const t = getTranslations('settings');
  const github = t.integrations.github;

  const styles: Record<GithubConnection['status'], string> = {
    active: 'text-emerald-600 dark:text-emerald-400 bg-emerald-50 dark:bg-emerald-950/50',
    suspended: 'text-amber-600 dark:text-amber-400 bg-amber-50 dark:bg-amber-950/50',
    revoked: 'text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-950/50',
  };

  const labels: Record<GithubConnection['status'], string> = {
    active: github.status.active,
    suspended: github.status.suspended,
    revoked: github.status.revoked,
  };

  return (
    <span className={cn('text-xs font-medium px-2 py-0.5 rounded', styles[status])}>
      {labels[status]}
    </span>
  );
}

function LinkedReposTable({
  repos,
  canManage,
}: {
  repos: GithubRepoLink[];
  canManage: boolean;
}) {
  const t = getTranslations('settings');
  const github = t.integrations.github;

  const [unlinkTarget, setUnlinkTarget] = React.useState<string | null>(null);
  const [syncingIds, setSyncingIds] = React.useState<Set<string>>(new Set());

  const syncMutation = useGithubSync();
  const unlinkMutation = useUnlinkRepo();

  const handleSync = async (linkId: string) => {
    setSyncingIds((prev) => new Set(prev).add(linkId));
    try {
      await syncMutation.mutateAsync(linkId);
      toast.success(github.syncNow);
    } catch {
      toast.error(github.syncFailed);
    } finally {
      setSyncingIds((prev) => {
        const next = new Set(prev);
        next.delete(linkId);
        return next;
      });
    }
  };

  const handleUnlink = async () => {
    if (!unlinkTarget) return;
    try {
      await unlinkMutation.mutateAsync(unlinkTarget);
      toast.success(github.unlinked);
      setUnlinkTarget(null);
    } catch {
      toast.error(github.unlinkFailed);
    }
  };

  if (repos.length === 0) {
    return (
      <div className="bg-card border border-border rounded-xl p-6 text-center">
        <p className="text-sm text-muted-foreground">{github.linkedRepos.empty}</p>
      </div>
    );
  }

  return (
    <>
      <div className="bg-card border border-border rounded-xl overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border bg-muted/40">
              <th className="text-left px-4 py-2.5 text-xs font-semibold text-muted-foreground tracking-wider uppercase">
                {github.linkedRepos.columns.repo}
              </th>
              <th className="text-left px-4 py-2.5 text-xs font-semibold text-muted-foreground tracking-wider uppercase">
                {github.linkedRepos.columns.direction}
              </th>
              <th className="text-left px-4 py-2.5 text-xs font-semibold text-muted-foreground tracking-wider uppercase">
                {github.linkedRepos.columns.syncIssues}
              </th>
              <th className="text-left px-4 py-2.5 text-xs font-semibold text-muted-foreground tracking-wider uppercase">
                {github.linkedRepos.columns.lastSynced}
              </th>
              {canManage && (
                <th className="text-right px-4 py-2.5 text-xs font-semibold text-muted-foreground tracking-wider uppercase">
                  {github.linkedRepos.columns.actions}
                </th>
              )}
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {repos.map((repo) => (
              <RepoRow
                key={repo.id}
                repo={repo}
                canManage={canManage}
                isSyncing={syncingIds.has(repo.id)}
                onSync={() => handleSync(repo.id)}
                onUnlink={() => setUnlinkTarget(repo.id)}
              />
            ))}
          </tbody>
        </table>
      </div>

      <ConfirmDialog
        open={!!unlinkTarget}
        onOpenChange={(open) => { if (!open) setUnlinkTarget(null); }}
        title={github.unlinkConfirm.title}
        description={github.unlinkConfirm.description}
        confirmLabel={github.unlink}
        variant="destructive"
        loading={unlinkMutation.isPending}
        onConfirm={handleUnlink}
      />
    </>
  );
}

function RepoRow({
  repo,
  canManage,
  isSyncing,
  onSync,
  onUnlink,
}: {
  repo: GithubRepoLink;
  canManage: boolean;
  isSyncing: boolean;
  onSync: () => void;
  onUnlink: () => void;
}) {
  const t = getTranslations('settings');
  const github = t.integrations.github;
  const updateMutation = useUpdateRepoLink(repo.id);

  const handleDirectionChange = (value: GithubRepoLink['syncDirection']) => {
    updateMutation.mutate({ syncDirection: value });
  };

  const handleSyncIssuesToggle = (checked: boolean) => {
    updateMutation.mutate({ syncIssues: checked });
  };

  return (
    <tr className="hover:bg-muted/30 transition-colors">
      {/* Repo */}
      <td className="px-4 py-3">
        <a
          href={`https://github.com/${repo.repoFullName}`}
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center gap-1.5 text-sm font-medium text-foreground hover:text-primary transition-colors group"
        >
          {repo.repoFullName}
          <ExternalLink className="h-3 w-3 opacity-0 group-hover:opacity-100 transition-opacity" />
        </a>
        {repo.projectId && (
          <a
            href={`/weldflow/project/${repo.projectId}`}
            className="text-xs text-muted-foreground hover:text-foreground transition-colors mt-0.5 block"
          >
            {github.linkedRepos.columns.project}
          </a>
        )}
      </td>

      {/* Sync direction */}
      <td className="px-4 py-3">
        {canManage ? (
          <Select
            value={repo.syncDirection}
            onValueChange={handleDirectionChange}
            disabled={updateMutation.isPending}
          >
            <SelectTrigger className="h-7 w-[130px] text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="inbound">{github.syncDirection.inbound}</SelectItem>
              <SelectItem value="outbound">{github.syncDirection.outbound}</SelectItem>
              <SelectItem value="bidirectional">{github.syncDirection.bidirectional}</SelectItem>
            </SelectContent>
          </Select>
        ) : (
          <span className="text-xs text-muted-foreground">
            {github.syncDirection[repo.syncDirection]}
          </span>
        )}
      </td>

      {/* Sync issues */}
      <td className="px-4 py-3">
        <Switch
          checked={repo.syncIssues}
          onCheckedChange={handleSyncIssuesToggle}
          disabled={!canManage || updateMutation.isPending}
        />
      </td>

      {/* Last synced */}
      <td className="px-4 py-3">
        <span className="text-xs text-muted-foreground">
          {formatRelativeTime(repo.lastSyncedAt)}
        </span>
      </td>

      {/* Actions */}
      {canManage && (
        <td className="px-4 py-3 text-right">
          <div className="flex items-center justify-end gap-1.5">
            <Button
              variant="ghost"
              size="sm"
              onClick={onSync}
              disabled={isSyncing}
              className="h-7 w-7 p-0"
              title={github.syncNow}
            >
              <RefreshCw className={cn('h-3.5 w-3.5', isSyncing && 'animate-spin')} />
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={onUnlink}
              className="h-7 px-2 text-red-600 hover:text-red-700 hover:bg-red-50 dark:hover:bg-red-950/30 text-xs"
            >
              {github.unlink}
            </Button>
          </div>
        </td>
      )}
    </tr>
  );
}

function RecoverDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const t = getTranslations('settings');
  const github = t.integrations.github;

  const { data: result, isLoading } = useDiscoverableInstallations(open);
  const recoverMutation = useRecoverInstallation();
  const [recoveringId, setRecoveringId] = React.useState<number | null>(null);

  const installations = ((result as any)?.data ?? []) as DiscoverableInstallation[];

  const handleRecover = async (item: DiscoverableInstallation) => {
    setRecoveringId(item.id);
    try {
      await recoverMutation.mutateAsync({ installationId: item.id });
      toast.success(github.installedSuccess);
      onOpenChange(false);
    } catch {
      toast.error(github.recoverDialog.errorGeneric);
    } finally {
      setRecoveringId(null);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{github.recoverDialog.title}</DialogTitle>
          <DialogDescription>{github.recoverDialog.description}</DialogDescription>
        </DialogHeader>

        <div className="mt-2">
          {isLoading ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
          ) : installations.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-6">
              {github.recoverDialog.noInstallations}
            </p>
          ) : (
            <ul className="divide-y divide-border rounded-lg border border-border overflow-hidden">
              {installations.map((item) => {
                const isPending = recoveringId === item.id;
                return (
                  <li key={item.id}>
                    <Button
                      type="button"
                      variant="ghost"
                      className="w-full flex items-center justify-between px-4 py-3 text-left hover:bg-muted/50 transition-colors disabled:opacity-60"
                      onClick={() => handleRecover(item)}
                      disabled={recoveringId !== null}
                    >
                      <div className="flex items-center gap-2 min-w-0">
                        <Github className="h-4 w-4 shrink-0 text-muted-foreground" />
                        <span className="text-sm font-medium truncate">@{item.accountLogin}</span>
                        <span className="text-xs text-muted-foreground bg-muted px-1.5 py-0.5 rounded shrink-0">
                          {item.accountType === 'Organization'
                            ? github.ownerType.org
                            : github.ownerType.user}
                        </span>
                      </div>
                      {isPending ? (
                        <Loader2 className="h-4 w-4 animate-spin text-muted-foreground shrink-0" />
                      ) : null}
                    </Button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

const githubIcon = (
  <img
    src="https://upload.wikimedia.org/wikipedia/commons/9/91/Octicons-mark-github.svg"
    className="h-[30px] w-[30px] dark:invert"
    alt="GitHub"
  />
);

export default function GithubSettingsPage() {
  const t = getTranslations('settings');
  const github = t.integrations.github;

  const router = useRouter();
  const searchParams = useSearchParams();
  const { can } = usePermissions();
  const canManage = can('weldconnect:integrations:github:manage');

  const [showDisconnect, setShowDisconnect] = React.useState(false);
  const [recoverDialogOpen, setRecoverDialogOpen] = React.useState(false);

  const { data: connectionResult, isLoading: connectionLoading } = useGithubConnection();
  const { data: linkedReposResult, isLoading: reposLoading } = useLinkedRepos();
  const installUrlMutation = useGetInstallUrl();
  const disconnectMutation = useDisconnectGithub();

  const connection = (connectionResult as any)?.data as GithubConnection | null | undefined;
  const linkedRepos = ((linkedReposResult as any)?.data ?? []) as GithubRepoLink[];

  // Handle ?installed=1 callback — show success toast and scrub the param
  React.useEffect(() => {
    if (searchParams.get('installed') === '1') {
      toast.success(github.installedSuccess);
      // Scrub the search param without a full re-navigation
      const url = new URL(window.location.href);
      url.searchParams.delete('installed');
      window.history.replaceState(null, '', url.toString());
    }
  }, []);

  const handleConnect = async () => {
    try {
      const result = await installUrlMutation.mutateAsync({
        returnTo: `${window.location.origin}/settings/integrations/github?installed=1`,
      });
      const url = (result as any)?.data?.url;
      if (url) {
        window.location.href = url;
      } else {
        toast.error(github.installFailed);
      }
    } catch {
      toast.error(github.installFailed);
    }
  };

  const handleDisconnect = async () => {
    try {
      await disconnectMutation.mutateAsync();
      toast.success(github.disconnectSuccess);
      setShowDisconnect(false);
    } catch {
      toast.error(github.disconnectFailed);
    }
  };

  const isLoading = connectionLoading;

  if (isLoading) {
    return <PageLoader fullScreen={false} />;
  }

  const connected = !!connection;

  return (
    <>
      <IntegrationDetailLayout
        name={github.title}
        description={github.subtitle}
        category="Developer Tools"
        icon={githubIcon}
        connected={connected}
        isWorking={installUrlMutation.isPending || disconnectMutation.isPending}
        connectLabel={github.connect}
        disconnectLabel={github.disconnect}
        onConnect={canManage ? handleConnect : undefined}
        onDisconnect={canManage ? () => setShowDisconnect(true) : undefined}
        canManage={canManage}
        provider="GitHub"
        resources={[
          { label: 'Website', href: 'https://github.com', icon: Globe },
          { label: 'Documentation', href: 'https://docs.github.com', icon: FileText },
        ]}
        overview={github.connectDescription}
      >
        {connected && connection && (
          <div className="space-y-6">
            {/* Connection card */}
            <div className="bg-card border border-border rounded-xl p-4">
              <div className="flex items-start gap-3">
                <div className="w-10 h-10 rounded-[0.625rem] bg-muted flex items-center justify-center shrink-0">
                  <Github className="h-5 w-5" />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-1.5 mb-0.5">
                    <h3 className="text-[0.9375rem] font-semibold text-foreground m-0">
                      @{connection.ownerLogin}
                    </h3>
                    <StatusBadge status={connection.status} />
                    <span className="text-xs text-muted-foreground ml-1">
                      ({connection.ownerType === 'org' ? github.ownerType.org : github.ownerType.user})
                    </span>
                  </div>
                  {connection.installedAt && (
                    <p className="text-xs text-muted-foreground m-0">
                      {github.installedAt} {formatRelativeTime(connection.installedAt)}
                    </p>
                  )}
                </div>
                {canManage && (
                  <Button
                    variant="outline"
                    size="sm"
                    className="text-red-600 hover:text-red-700 hover:bg-red-50 dark:hover:bg-red-950/30 shrink-0"
                    onClick={() => setShowDisconnect(true)}
                  >
                    <Unplug className="h-4 w-4 mr-2" />
                    {github.disconnect}
                  </Button>
                )}
              </div>

              {connection.status === 'suspended' && (
                <div className="mt-3 bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-900 rounded-lg p-3">
                  <p className="text-xs text-amber-700 dark:text-amber-400">
                    {github.suspendedWarning}
                  </p>
                </div>
              )}

              {connection.status === 'revoked' && (
                <div className="mt-3 bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-900 rounded-lg p-3">
                  <p className="text-xs text-red-700 dark:text-red-400">
                    {github.revokedWarning}
                  </p>
                </div>
              )}
            </div>

            {/* Linked repositories */}
            <div>
              <h2 className="text-[0.7rem] font-semibold text-muted-foreground tracking-wider uppercase mb-3">
                {github.linkedRepos.title}
              </h2>
              {reposLoading ? (
                <div className="flex items-center justify-center py-8">
                  <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
                </div>
              ) : (
                <LinkedReposTable repos={linkedRepos} canManage={canManage} />
              )}
              {linkedRepos.length === 0 && (
                <p className="text-xs text-muted-foreground mt-3">
                  {github.linkedRepos.linkFromProject}
                </p>
              )}
            </div>

            {/* "Already installed" recover link */}
            {!connected && canManage && (
              <Button
                type="button"
                variant="ghost"
                className="block mt-3 text-xs text-muted-foreground hover:text-foreground underline underline-offset-2"
                onClick={() => setRecoverDialogOpen(true)}
              >
                {github.alreadyInstalled}
              </Button>
            )}
          </div>
        )}

        {/* Not connected — recover link */}
        {!connected && canManage && (
          <Button
            type="button"
            variant="ghost"
            className="block mt-3 text-xs text-muted-foreground hover:text-foreground underline underline-offset-2"
            onClick={() => setRecoverDialogOpen(true)}
          >
            {github.alreadyInstalled}
          </Button>
        )}
      </IntegrationDetailLayout>

      <ConfirmDialog
        open={showDisconnect}
        onOpenChange={(open) => { if (!open) setShowDisconnect(false); }}
        title={github.disconnectConfirm.title}
        description={github.disconnectConfirm.description}
        confirmLabel={github.disconnect}
        variant="destructive"
        loading={disconnectMutation.isPending}
        onConfirm={handleDisconnect}
      />

      <RecoverDialog
        open={recoverDialogOpen}
        onOpenChange={setRecoverDialogOpen}
      />
    </>
  );
}
