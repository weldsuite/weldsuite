import { useEffect, useState } from 'react';
import {
  Github,
  ExternalLink,
  RefreshCw,
  Loader2,
  Search,
  KanbanSquare,
} from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { Button } from '@weldsuite/ui/components/button';
import { Switch } from '@weldsuite/ui/components/switch';
import { cn } from '@/lib/utils';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { toast } from 'sonner';
import { Input } from '@weldsuite/ui/components/input';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@weldsuite/ui/components/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@weldsuite/ui/components/select';
import { Label } from '@weldsuite/ui/components/label';
import { useRouter } from '@/lib/router';
import { usePermissions } from '@weldsuite/permissions/react';
import {
  useGithubConnection,
  useAvailableProjects,
  useAvailableRepos,
  useLinkedProjects,
  useProjectStatusFields,
  useLinkProject,
  useUpdateProjectLink,
  useUnlinkProject,
  useProjectSync,
} from '@/hooks/queries/use-github-queries';
import { getTranslations } from '@/lib/i18n';
import { PageLoader } from '@/components/page-loader';
import { stagesApi } from '@/app/weldflow/lib/api-client';
import type {
  GithubProjectLink,
  AvailableProjectV2,
  AvailableRepo,
  ProjectV2StatusFieldInfo,
} from '@weldsuite/core-api-client/schemas/github';

type SyncDirection = 'inbound' | 'outbound' | 'bidirectional';

interface Stage {
  id: string;
  name: string;
  color?: string;
}

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
  return `${diffDays}d ago`;
}

interface LinkProjectDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId: string;
}

function LinkProjectDialog({ open, onOpenChange, projectId }: LinkProjectDialogProps) {
  const t = getTranslations('settings');
  const gp = t.integrations.github.projects;

  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<AvailableProjectV2 | null>(null);
  const [syncDirection, setSyncDirection] = useState<SyncDirection>('bidirectional');
  const [syncIssues, setSyncIssues] = useState(true);
  // GitHub status option id → WeldFlow stage id ('' = unmapped)
  const [mapping, setMapping] = useState<Record<string, string>>({});
  // Target repo for pushing WeldFlow tasks → GitHub issues (outbound).
  const [selectedRepo, setSelectedRepo] = useState<AvailableRepo | null>(null);

  const { data: availableResult, isLoading } = useAvailableProjects(open);
  const { data: reposResult } = useAvailableRepos(open);
  const { data: statusFieldsResult, isLoading: fieldsLoading } = useProjectStatusFields(
    selected?.nodeId ?? null,
  );
  const { data: stagesData } = useQuery({
    queryKey: ['weldflow-stages', projectId],
    queryFn: async () => {
      const res = await stagesApi.list(projectId);
      return (res.success && res.data ? res.data : []) as Stage[];
    },
    enabled: open,
  });
  const linkMutation = useLinkProject();

  const allProjects = availableResult?.data ?? [];
  const filtered = allProjects.filter((p) =>
    `${p.title} ${p.ownerLogin}`.toLowerCase().includes(search.toLowerCase()),
  );
  const statusInfo = statusFieldsResult?.data as ProjectV2StatusFieldInfo | undefined;
  const stages = stagesData ?? [];
  const repos = (reposResult?.data ?? []) as AvailableRepo[];

  // Reset the per-project status mapping whenever the selected project changes.
  useEffect(() => {
    setMapping({});
  }, [selected?.nodeId]);

  const handleLink = async () => {
    if (!selected) return;
    try {
      const statusOptionMap = (statusInfo?.options ?? []).map((o) => ({
        githubOptionId: o.id,
        githubOptionName: o.name,
        stageId: mapping[o.id] || null,
      }));

      await linkMutation.mutateAsync({
        projectId,
        projectV2NodeId: selected.nodeId,
        projectV2Number: selected.number,
        projectTitle: selected.title,
        ownerType: selected.ownerType,
        ownerLogin: selected.ownerLogin,
        repoId: selectedRepo?.id,
        repoFullName: selectedRepo?.fullName,
        statusFieldId: statusInfo?.fieldId ?? undefined,
        statusOptionMap,
        syncDirection,
        syncIssues,
      });
      toast.success(gp.linkSuccess);
      handleClose();
    } catch {
      toast.error(gp.linkFailed);
    }
  };

  const handleClose = () => {
    onOpenChange(false);
    setSelected(null);
    setSearch('');
    setMapping({});
    setSelectedRepo(null);
  };

  return (
    <Dialog open={open} onOpenChange={(o) => (o ? onOpenChange(true) : handleClose())}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <KanbanSquare className="h-4 w-4" />
            {gp.dialog.title}
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          {/* Search */}
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              className="pl-9"
              placeholder={gp.dialog.search}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>

          {/* Project list */}
          <div className="border border-border rounded-lg overflow-hidden max-h-44 overflow-y-auto">
            {isLoading ? (
              <PageLoader fullScreen={false} />
            ) : filtered.length === 0 ? (
              <div className="py-6 text-center text-sm text-muted-foreground">
                {gp.dialog.noProjects}
              </div>
            ) : (
              filtered.map((proj) => (
                <Button
                  key={proj.nodeId}
                  type="button"
                  variant="ghost"
                  className={cn(
                    'w-full flex items-center gap-3 px-3 py-2.5 text-sm text-left hover:bg-muted/50 transition-colors border-b border-border last:border-0',
                    selected?.nodeId === proj.nodeId && 'bg-primary/5 text-primary',
                  )}
                  onClick={() => setSelected(proj)}
                >
                  <KanbanSquare className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                  <span className="flex-1 font-medium truncate">
                    {proj.title}
                    <span className="text-xs text-muted-foreground ml-1">#{proj.number}</span>
                  </span>
                  <span className="text-xs text-muted-foreground shrink-0">@{proj.ownerLogin}</span>
                </Button>
              ))
            )}
          </div>

          {/* Settings (visible when a project is selected) */}
          {selected && (
            <div className="space-y-3 border border-border rounded-lg p-3">
              <div className="flex items-center justify-between">
                <Label className="text-xs font-medium">{gp.dialog.direction}</Label>
                <Select
                  value={syncDirection}
                  onValueChange={(v) => setSyncDirection(v as SyncDirection)}
                >
                  <SelectTrigger className="h-7 w-[140px] text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="inbound">
                      {t.integrations.github.syncDirection.inbound}
                    </SelectItem>
                    <SelectItem value="outbound">
                      {t.integrations.github.syncDirection.outbound}
                    </SelectItem>
                    <SelectItem value="bidirectional">
                      {t.integrations.github.syncDirection.bidirectional}
                    </SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="flex items-center justify-between">
                <Label className="text-xs font-medium">{gp.dialog.syncIssues}</Label>
                <Switch checked={syncIssues} onCheckedChange={setSyncIssues} />
              </div>

              {/* Target repo — where WeldFlow tasks become issues (outbound) */}
              {syncDirection !== 'inbound' && (
                <div className="flex items-center justify-between gap-2">
                  <Label className="text-xs font-medium">{gp.dialog.repo}</Label>
                  <Select
                    value={selectedRepo?.fullName ?? ''}
                    onValueChange={(v) => setSelectedRepo(repos.find((r) => r.fullName === v) ?? null)}
                  >
                    <SelectTrigger className="h-7 w-[200px] text-xs">
                      <SelectValue placeholder={gp.dialog.repoPlaceholder} />
                    </SelectTrigger>
                    <SelectContent>
                      {repos.map((r) => (
                        <SelectItem key={r.id} value={r.fullName}>
                          {r.fullName}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              )}

              {/* Status → stage mapping */}
              <div className="pt-1 border-t border-border">
                <Label className="text-xs font-medium">{gp.dialog.statusMapping}</Label>
                <p className="text-[11px] text-muted-foreground mb-2">{gp.dialog.statusMappingHint}</p>
                {fieldsLoading ? (
                  <p className="text-xs text-muted-foreground">{gp.dialog.loadingFields}</p>
                ) : !statusInfo?.fieldId || statusInfo.options.length === 0 ? (
                  <p className="text-xs text-muted-foreground">{gp.dialog.noStatusField}</p>
                ) : (
                  <div className="space-y-1.5">
                    {statusInfo.options.map((opt) => (
                      <div key={opt.id} className="flex items-center justify-between gap-2">
                        <span className="text-xs truncate flex-1">{opt.name}</span>
                        <Select
                          value={mapping[opt.id] ?? ''}
                          onValueChange={(v) =>
                            setMapping((m) => ({ ...m, [opt.id]: v === '__none__' ? '' : v }))
                          }
                        >
                          <SelectTrigger className="h-7 w-[150px] text-xs">
                            <SelectValue placeholder={gp.dialog.unmapped} />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="__none__">{gp.dialog.unmapped}</SelectItem>
                            {stages.map((s) => (
                              <SelectItem key={s.id} value={s.id}>
                                {s.name}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={handleClose}>
            {gp.dialog.cancel}
          </Button>
          <Button onClick={handleLink} disabled={!selected || linkMutation.isPending}>
            {linkMutation.isPending ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : null}
            {gp.dialog.link}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

interface GithubSectionProps {
  projectId: string;
  isAdmin: boolean;
}

export function GithubSection({ projectId, isAdmin }: GithubSectionProps) {
  const t = getTranslations('settings');
  const gp = t.integrations.github.projects;

  const router = useRouter();
  const { can } = usePermissions();
  const canManage = can('weldconnect:integrations:github:manage') && isAdmin;

  const [showLinkDialog, setShowLinkDialog] = useState(false);
  const [unlinkTarget, setUnlinkTarget] = useState<string | null>(null);
  const [syncingIds, setSyncingIds] = useState<Set<string>>(new Set());

  const { data: connectionResult, isLoading: connectionLoading } = useGithubConnection();
  const { data: linkedResult, isLoading: linksLoading } = useLinkedProjects(projectId);
  const unlinkMutation = useUnlinkProject();
  const syncMutation = useProjectSync();

  const connection = connectionResult?.data ?? null;
  const linkedProjects = (linkedResult?.data ?? []) as GithubProjectLink[];

  const handleSync = async (linkId: string) => {
    setSyncingIds((prev) => new Set(prev).add(linkId));
    try {
      await syncMutation.mutateAsync(linkId);
      toast.success(gp.syncStarted);
    } catch {
      toast.error(gp.syncFailed);
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
      toast.success(gp.unlinked);
      setUnlinkTarget(null);
    } catch {
      toast.error(gp.unlinkFailed);
    }
  };

  if (connectionLoading) return <PageLoader fullScreen={false} />;

  if (!connection) {
    return (
      <div className="space-y-4">
        <div>
          <h3 className="text-sm font-semibold mb-1">{gp.title}</h3>
          <p className="text-sm text-muted-foreground">{gp.noConnection}</p>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => router.push('/settings/integrations/github')}
        >
          <Github className="h-4 w-4 mr-2" />
          {gp.linkFirst}
        </Button>
      </div>
    );
  }

  // One WeldFlow project maps to at most one GitHub Project.
  const hasLink = linkedProjects.length > 0;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-sm font-semibold mb-0.5">{gp.title}</h3>
          <p className="text-xs text-muted-foreground">
            {gp.connected} @{connection.ownerLogin}
          </p>
        </div>
        {canManage && !hasLink && (
          <Button size="sm" variant="outline" onClick={() => setShowLinkDialog(true)}>
            <KanbanSquare className="h-4 w-4 mr-2" />
            {gp.linkProject}
          </Button>
        )}
      </div>

      {linksLoading ? (
        <PageLoader fullScreen={false} />
      ) : !hasLink ? (
        <div className="bg-muted/40 border border-border rounded-lg p-4 text-center">
          <p className="text-sm text-muted-foreground">{gp.empty}</p>
          {canManage && (
            <Button
              size="sm"
              variant="outline"
              className="mt-3"
              onClick={() => setShowLinkDialog(true)}
            >
              {gp.linkProject}
            </Button>
          )}
        </div>
      ) : (
        <div className="space-y-2">
          {linkedProjects.map((link) => (
            <ProjectLinkRow
              key={link.id}
              link={link}
              canManage={canManage}
              isSyncing={syncingIds.has(link.id)}
              onSync={() => handleSync(link.id)}
              onUnlink={() => setUnlinkTarget(link.id)}
            />
          ))}
        </div>
      )}

      {canManage && (
        <LinkProjectDialog
          open={showLinkDialog}
          onOpenChange={setShowLinkDialog}
          projectId={projectId}
        />
      )}

      <ConfirmDialog
        open={!!unlinkTarget}
        onOpenChange={(open) => {
          if (!open) setUnlinkTarget(null);
        }}
        title={gp.unlinkConfirm.title}
        description={gp.unlinkConfirm.description}
        confirmLabel={gp.unlink}
        variant="destructive"
        loading={unlinkMutation.isPending}
        onConfirm={handleUnlink}
      />
    </div>
  );
}

function ProjectLinkRow({
  link,
  canManage,
  isSyncing,
  onSync,
  onUnlink,
}: {
  link: GithubProjectLink;
  canManage: boolean;
  isSyncing: boolean;
  onSync: () => void;
  onUnlink: () => void;
}) {
  const t = getTranslations('settings');
  const gp = t.integrations.github.projects;
  const updateMutation = useUpdateProjectLink(link.id);

  const projectUrl = `https://github.com/${link.ownerType === 'org' ? 'orgs' : 'users'}/${link.ownerLogin}/projects/${link.projectV2Number}`;

  return (
    <div className="flex items-center gap-3 bg-card border border-border rounded-lg px-3 py-2.5">
      <KanbanSquare className="h-4 w-4 text-muted-foreground shrink-0" />
      <div className="flex-1 min-w-0">
        <a
          href={projectUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="text-sm font-medium text-foreground hover:text-primary flex items-center gap-1 group"
        >
          {link.projectTitle || `Project #${link.projectV2Number}`}
          <ExternalLink className="h-3 w-3 opacity-0 group-hover:opacity-100 transition-opacity" />
        </a>
        <div className="flex items-center gap-2 mt-0.5">
          <span className="text-xs text-muted-foreground">
            {t.integrations.github.syncDirection[link.syncDirection]}
          </span>
          {link.lastSyncedAt && (
            <span className="text-xs text-muted-foreground">
              · {gp.lastSynced}: {formatRelativeTime(link.lastSyncedAt)}
            </span>
          )}
        </div>
      </div>

      {canManage && (
        <div className="flex items-center gap-1.5 shrink-0">
          <Select
            value={link.syncDirection}
            onValueChange={(v) =>
              updateMutation.mutate({ syncDirection: v as GithubProjectLink['syncDirection'] })
            }
            disabled={updateMutation.isPending}
          >
            <SelectTrigger className="h-7 w-[120px] text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="inbound">{t.integrations.github.syncDirection.inbound}</SelectItem>
              <SelectItem value="outbound">
                {t.integrations.github.syncDirection.outbound}
              </SelectItem>
              <SelectItem value="bidirectional">
                {t.integrations.github.syncDirection.bidirectional}
              </SelectItem>
            </SelectContent>
          </Select>
          <Button
            variant="ghost"
            size="sm"
            onClick={onSync}
            disabled={isSyncing}
            className="h-7 w-7 p-0"
            title={gp.syncNow}
          >
            <RefreshCw className={cn('h-3.5 w-3.5', isSyncing && 'animate-spin')} />
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={onUnlink}
            className="h-7 px-2 text-red-600 hover:text-red-700 hover:bg-red-50 dark:hover:bg-red-950/30 text-xs"
          >
            {gp.unlink}
          </Button>
        </div>
      )}
    </div>
  );
}
