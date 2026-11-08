/**
 * WeldDesk teams: list, create, edit, switch on or off, delete. Rows are
 * `helpdesk_departments` via `/api/helpdesk-departments` (desk-api). A team's
 * members take the conversations routed to it (auto-assignment), and its
 * escalation rules run on the SLA sweep (`@weldsuite/db/lib/desk-escalation`).
 */

import { useMemo, useState } from 'react';
import { Pencil, Plus, Trash2, Users } from 'lucide-react';
import { toast } from 'sonner';
import { useCan } from '@weldsuite/permissions/react';
import { Button } from '@weldsuite/ui/components/button';
import { ConfirmDialog } from '@weldsuite/ui/components/confirm-dialog';
import { EmptyState } from '@weldsuite/ui/components/empty-state';
import { ErrorState } from '@weldsuite/ui/components/error-banner';
import { PageLoader } from '@weldsuite/ui/components/page-loader';
import { SoftBadge } from '@weldsuite/ui/components/soft-badge';
import { Switch } from '@weldsuite/ui/components/switch';
import { getTranslations } from '@/lib/i18n';
import {
  useDeleteDeskTeam,
  useDeskTeamMembers,
  useDeskTeams,
  useUpdateDeskTeam,
  type DeskTeam,
} from '@/hooks/queries/use-desk-routing-queries';
import { TeamEditor } from './team-editor';

export function TeamsSettings() {
  const t = getTranslations('helpdesk').teamsSettings;
  const canCreate = useCan('departments:create');
  const canUpdate = useCan('departments:update');
  const canDelete = useCan('departments:delete');
  const { data: teams, isLoading, isError, refetch } = useDeskTeams();
  const { data: members = [] } = useDeskTeamMembers();
  const updateTeam = useUpdateDeskTeam();
  const deleteTeam = useDeleteDeskTeam();

  const [editorOpen, setEditorOpen] = useState(false);
  const [editing, setEditing] = useState<DeskTeam | null>(null);
  const [deleting, setDeleting] = useState<DeskTeam | null>(null);

  const managerName = useMemo(() => {
    const byId = new Map<string, string>();
    for (const m of members) {
      byId.set(m.memberId, m.name);
      byId.set(m.userId, m.name);
    }
    return (team: DeskTeam) => (team.managerId ? (byId.get(team.managerId) ?? team.managerName) : null);
  }, [members]);

  const openEditor = (team: DeskTeam | null) => {
    setEditing(team);
    setEditorOpen(true);
  };

  const toggleActive = async (team: DeskTeam) => {
    try {
      await updateTeam.mutateAsync({ id: team.id, isActive: !team.isActive });
      toast.success((team.isActive ? t.toast.deactivated : t.toast.activated).replace('{name}', team.name));
    } catch {
      toast.error(t.toast.saveFailed);
    }
  };

  const confirmDelete = async () => {
    if (!deleting) return;
    try {
      await deleteTeam.mutateAsync(deleting.id);
      toast.success(t.toast.deleted);
      setDeleting(null);
    } catch {
      toast.error(t.toast.deleteFailed);
    }
  };

  const summary = (team: DeskTeam): string[] => {
    const parts: string[] = [];
    const count = team.agentIds.length;
    if (count === 0) parts.push(t.list.noMembers);
    else parts.push(count === 1 ? t.list.oneMember : t.list.members.replace('{count}', String(count)));
    const manager = managerName(team);
    if (manager) parts.push(t.list.manager.replace('{name}', manager));
    const rules = team.escalationRules.length;
    if (rules > 0) parts.push(rules === 1 ? t.list.oneEscalation : t.list.escalations.replace('{count}', String(rules)));
    return parts;
  };

  let body: React.ReactNode;
  if (isLoading) {
    body = <PageLoader fullScreen={false} />;
  } else if (isError) {
    body = <ErrorState message={t.loadError} onRetry={() => void refetch()} />;
  } else if (!teams || teams.length === 0) {
    body = (
      <EmptyState
        icon={Users}
        title={t.empty.title}
        description={t.empty.description}
        action={
          canCreate ? (
            <Button onClick={() => openEditor(null)}>
              <Plus className="mr-1.5 h-4 w-4" />
              {t.newTeam}
            </Button>
          ) : undefined
        }
      />
    );
  } else {
    body = (
      <ul className="divide-y rounded-lg border" data-testid="team-list">
        {teams.map((team, index) => (
          <li key={team.id} className="flex flex-wrap items-center gap-3 p-4 sm:flex-nowrap" data-testid="team-row">
            <span className="w-6 shrink-0 text-center text-xs tabular-nums text-muted-foreground" title={t.list.orderTitle}>
              {index + 1}
            </span>
            <div className="min-w-0 flex-1 space-y-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className="truncate font-medium">{team.name}</span>
                {!team.isActive && <SoftBadge tone="neutral">{t.list.inactiveBadge}</SoftBadge>}
              </div>
              <p className="text-sm text-muted-foreground">{summary(team).join(' · ')}</p>
              {team.description && <p className="truncate text-xs text-muted-foreground">{team.description}</p>}
            </div>
            <div className="flex shrink-0 items-center gap-1">
              <Switch
                checked={team.isActive}
                disabled={!canUpdate || updateTeam.isPending}
                onCheckedChange={() => void toggleActive(team)}
                aria-label={t.list.activeToggle.replace('{name}', team.name)}
              />
              {canUpdate && (
                <Button variant="ghost" size="icon" onClick={() => openEditor(team)} aria-label={t.list.edit.replace('{name}', team.name)}>
                  <Pencil className="h-4 w-4" />
                </Button>
              )}
              {canDelete && (
                <Button variant="ghost" size="icon" onClick={() => setDeleting(team)} aria-label={t.list.delete.replace('{name}', team.name)}>
                  <Trash2 className="h-4 w-4" />
                </Button>
              )}
            </div>
          </li>
        ))}
      </ul>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="mx-auto max-w-3xl space-y-6 p-4 md:p-6" data-testid="teams-settings">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">{t.title}</h1>
            <p className="text-sm text-muted-foreground">{t.description}</p>
          </div>
          {canCreate && teams && teams.length > 0 && (
            <Button onClick={() => openEditor(null)} data-testid="team-new">
              <Plus className="mr-1.5 h-4 w-4" />
              {t.newTeam}
            </Button>
          )}
        </div>
        {body}
      </div>

      <TeamEditor open={editorOpen} onOpenChange={setEditorOpen} team={editing} teams={teams ?? []} members={members} />

      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => !open && setDeleting(null)}
        title={t.delete.title}
        description={t.delete.description.replace('{name}', deleting?.name ?? '')}
        confirmLabel={t.delete.confirm}
        variant="destructive"
        loading={deleteTeam.isPending}
        onConfirm={confirmDelete}
      />
    </div>
  );
}
