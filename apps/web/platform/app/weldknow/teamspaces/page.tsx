import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Folder, Globe, LayoutGrid, Lock, Plus, Users } from 'lucide-react';
import { Badge } from '@weldsuite/ui/components/badge';
import { Button } from '@weldsuite/ui/components/button';
import { Skeleton } from '@weldsuite/ui/components/skeleton';
import { useCan } from '@weldsuite/permissions/react';
import { getTranslations } from '@/lib/i18n';
import { useBreadcrumbs } from '@/contexts/breadcrumb-context';
import {
  useJoinKnowledgeSpace,
  useKnowledgeSpaces,
  type KnowledgeSpace,
} from '@/hooks/queries/use-knowledge-queries';
import { CreateSpaceDialog } from '../components/create-space-dialog';
import { SpaceMembersDialog, useRoleLabel } from '../components/space-members-dialog';

/**
 * Every teamspace the caller can see: the ones they are in, and the open and
 * closed ones they could join or ask to be added to. Admins holding
 * knowledge:manage also see private teamspaces here, and may join any of them.
 */
export default function TeamspacesPage() {
  const t = getTranslations('weldknow');
  const roleLabel = useRoleLabel();
  const canCreate = useCan('knowledge:create');
  const { data, isLoading } = useKnowledgeSpaces();
  const joinSpace = useJoinKnowledgeSpace();
  const [showCreate, setShowCreate] = useState(false);
  const [membersSpaceId, setMembersSpaceId] = useState<string | null>(null);
  useBreadcrumbs([{ label: t.breadcrumb.home, href: '/weldknow' }, { label: t.teamspaces.title }]);

  const teamspaces = useMemo(() => (data?.data ?? []).filter((s) => s.kind === 'team'), [data]);
  const yours = teamspaces.filter((s) => s.isMember);
  const others = teamspaces.filter((s) => !s.isMember);
  // Looked up fresh so the dialog follows role changes, and closes if the space disappears.
  const membersSpace = teamspaces.find((s) => s.id === membersSpaceId) ?? null;

  const visibilityLabel = (space: KnowledgeSpace) =>
    space.visibility === 'open'
      ? t.space.visibilityOpen
      : space.visibility === 'closed'
        ? t.space.visibilityClosed
        : t.space.visibilityPrivate;

  const handleJoin = async (space: KnowledgeSpace) => {
    try {
      await joinSpace.mutateAsync(space.id);
      toast.success(t.teamspaces.joinSuccess);
    } catch {
      toast.error(t.teamspaces.joinError);
    }
  };

  const renderRow = (space: KnowledgeSpace) => {
    const VisibilityIcon = space.visibility === 'open' ? Globe : Lock;
    const canJoin = !space.isMember && (space.visibility === 'open' || space.canManage);
    return (
      <div key={space.id} className="flex items-center justify-between gap-3 rounded-md border px-3 py-2.5">
        <div className="flex min-w-0 items-center gap-2.5">
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-muted text-base leading-none">
            {space.icon || <Folder className="h-4 w-4 text-muted-foreground" />}
          </span>
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <p className="truncate text-sm font-medium">{space.name}</p>
              {space.isDefault && <Badge variant="secondary">{t.teamspaces.defaultBadge}</Badge>}
            </div>
            <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <VisibilityIcon className="h-3 w-3" />
              {visibilityLabel(space)}
              <span>·</span>
              {t.teamspaces.memberCount.replace('{count}', String(space.memberCount))}
              {space.role && (
                <>
                  <span>·</span>
                  {t.teamspaces.roleLabel.replace('{role}', roleLabel(space.role).toLowerCase())}
                </>
              )}
            </p>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {!space.isMember && !canJoin && (
            <span className="hidden text-xs text-muted-foreground sm:inline">{t.teamspaces.askOwner}</span>
          )}
          <Button variant="ghost" size="sm" onClick={() => setMembersSpaceId(space.id)}>
            <Users className="mr-1.5 h-4 w-4" />
            {t.teamspaces.members}
          </Button>
          {canJoin && (
            <Button variant="outline" size="sm" onClick={() => handleJoin(space)} disabled={joinSpace.isPending}>
              {t.teamspaces.join}
            </Button>
          )}
        </div>
      </div>
    );
  };

  const content = (() => {
    if (isLoading) {
      return (
        <div className="space-y-2">
          <Skeleton className="h-14 w-full" />
          <Skeleton className="h-14 w-full" />
          <Skeleton className="h-14 w-full" />
        </div>
      );
    }
    if (teamspaces.length === 0) {
      return (
        <div className="flex flex-col items-center justify-center gap-1 py-16 text-center">
          <LayoutGrid className="mb-2 h-10 w-10 text-muted-foreground/40" />
          <p className="text-sm text-muted-foreground">{t.teamspaces.empty}</p>
        </div>
      );
    }
    return (
      <div className="space-y-8">
        <section>
          <h2 className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">{t.teamspaces.yours}</h2>
          {yours.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t.sidebar.noTeamspacesJoined}</p>
          ) : (
            <div className="space-y-1">{yours.map(renderRow)}</div>
          )}
        </section>
        <section>
          <h2 className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">{t.teamspaces.others}</h2>
          {others.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t.teamspaces.noOthers}</p>
          ) : (
            <div className="space-y-1">{others.map(renderRow)}</div>
          )}
        </section>
      </div>
    );
  })();

  return (
    <div className="mx-auto max-w-3xl px-6 py-8">
      <div className="mb-6 flex items-center justify-between gap-2">
        <div>
          <div className="flex items-center gap-2">
            <LayoutGrid className="h-5 w-5 text-muted-foreground" />
            <h1 className="text-2xl font-semibold">{t.teamspaces.title}</h1>
          </div>
          <p className="mt-1 text-sm text-muted-foreground">{t.teamspaces.description}</p>
        </div>
        {canCreate && (
          <Button onClick={() => setShowCreate(true)}>
            <Plus className="mr-2 h-4 w-4" />
            {t.sidebar.newTeamspace}
          </Button>
        )}
      </div>

      {content}

      <CreateSpaceDialog open={showCreate} onOpenChange={setShowCreate} />
      <SpaceMembersDialog space={membersSpace} onOpenChange={(open) => !open && setMembersSpaceId(null)} />
    </div>
  );
}
