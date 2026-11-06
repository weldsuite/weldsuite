import { useMemo, useState, type ReactNode } from 'react';
import { Pencil, Plus, Repeat, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { useCan } from '@weldsuite/permissions/react';
import { Badge } from '@weldsuite/ui/components/badge';
import { Button } from '@weldsuite/ui/components/button';
import { ConfirmDialog } from '@weldsuite/ui/components/confirm-dialog';
import { EmptyState } from '@weldsuite/ui/components/empty-state';
import { ErrorState } from '@weldsuite/ui/components/error-banner';
import { FilterSelect } from '@weldsuite/ui/components/filter-select';
import { PageLoader } from '@weldsuite/ui/components/page-loader';
import { Progress } from '@weldsuite/ui/components/progress';
import { SectionCard } from '@weldsuite/ui/components/section-card';
import type { MergeCycleDto } from '@weldsuite/app-api-client/schemas/weldmerge';
import {
  useDeleteMergeCycle,
  useMergeCycles,
  useMergeTeams,
} from '@/hooks/queries/use-weldmerge-queries';
import { useI18n } from '@/lib/i18n/provider';
import { Link } from '@/lib/router';
import { CycleFormDialog } from '../components/cycle-form-dialog';
import { cycleState, fill, formatDateRange, todayIso } from '../lib/format';

/** Cycles per team with progress; members who manage teams create, edit and delete them. */
export default function WeldMergeCyclesPage() {
  const { t, language } = useI18n();
  const tm = t.weldmerge;
  const tc = tm.cycles;
  const canManage = useCan('merge_teams:manage');

  const [teamId, setTeamId] = useState<string | undefined>();
  const [editing, setEditing] = useState<MergeCycleDto | null>(null);
  const [creating, setCreating] = useState(false);
  const [deleting, setDeleting] = useState<MergeCycleDto | null>(null);

  const teams = useMergeTeams();
  const cycles = useMergeCycles(teamId);
  const remove = useDeleteMergeCycle();
  const teamById = useMemo(() => new Map((teams.data ?? []).map((team) => [team.id, team])), [teams.data]);
  const today = todayIso();

  const sorted = useMemo(
    () => [...(cycles.data ?? [])].sort((a, b) => b.startsAt.localeCompare(a.startsAt)),
    [cycles.data],
  );

  if (teams.isLoading) return <PageLoader fullScreen={false} />;
  if (teams.isError) return <ErrorState message={tm.loadFailed} retryLabel={tm.retry} onRetry={() => void teams.refetch()} />;

  if ((teams.data ?? []).length === 0) {
    return (
      <div className="p-6">
        <EmptyState
          icon={Repeat}
          title={tc.noTeamsTitle}
          description={tc.noTeamsDescription}
          action={
            <Button asChild>
              <Link href="/weldmerge/settings">{tm.issues.openSettings}</Link>
            </Button>
          }
        />
      </div>
    );
  }

  const confirmDelete = async () => {
    if (!deleting) return;
    try {
      await remove.mutateAsync(deleting.id);
      setDeleting(null);
    } catch {
      toast.error(tc.deleteFailed);
    }
  };

  let content: ReactNode;
  if (cycles.isLoading) {
    content = <PageLoader fullScreen={false} />;
  } else if (cycles.isError) {
    content = <ErrorState message={tm.loadFailed} retryLabel={tm.retry} onRetry={() => void cycles.refetch()} />;
  } else if (sorted.length === 0) {
    content = (
      <EmptyState
        icon={Repeat}
        title={tc.emptyTitle}
        description={tc.emptyDescription}
        action={
          canManage ? (
            <Button onClick={() => setCreating(true)}>
              <Plus />
              {tc.newCycle}
            </Button>
          ) : undefined
        }
      />
    );
  } else {
    content = (
      <ul className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {sorted.map((cycle) => {
          const state = cycleState(cycle.startsAt, cycle.endsAt, today);
          const percent = cycle.issueCount === 0 ? 0 : Math.round((cycle.completedIssueCount / cycle.issueCount) * 100);
          const team = teamById.get(cycle.teamId);
          return (
            <li key={cycle.id}>
              <SectionCard
                title={
                  <span className="flex flex-wrap items-center gap-2">
                    {cycle.name?.trim() || fill(tc.cycleName, { number: cycle.number })}
                    <Badge variant={state === 'current' ? 'default' : 'secondary'}>{tc.state[state]}</Badge>
                  </span>
                }
                action={
                  canManage ? (
                    <span className="flex">
                      <Button variant="ghost" size="icon" className="size-8" aria-label={t.common.actions.edit} onClick={() => setEditing(cycle)}>
                        <Pencil />
                      </Button>
                      <Button variant="ghost" size="icon" className="size-8" aria-label={t.common.actions.delete} onClick={() => setDeleting(cycle)}>
                        <Trash2 />
                      </Button>
                    </span>
                  ) : undefined
                }
              >
                <div className="space-y-3">
                  <p className="text-sm text-muted-foreground">
                    {team ? `${team.name} · ` : ''}
                    {formatDateRange(cycle.startsAt, cycle.endsAt, language)}
                  </p>
                  <Progress value={percent} aria-label={tc.progress} />
                  <p className="text-sm">
                    {cycle.issueCount === 0
                      ? tc.noIssues
                      : fill(tc.progress, { done: cycle.completedIssueCount, total: cycle.issueCount })}
                    {cycle.issueCount > 0 && <span className="text-muted-foreground"> · {percent}%</span>}
                  </p>
                </div>
              </SectionCard>
            </li>
          );
        })}
      </ul>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b px-4 py-3">
        <div className="flex flex-wrap items-center gap-3">
          <div>
            <h1 className="text-lg font-semibold">{tc.title}</h1>
            <p className="text-sm text-muted-foreground">{tc.description}</p>
          </div>
          <FilterSelect
            value={teamId}
            onChange={setTeamId}
            ariaLabel={tc.team}
            allLabel={tc.allTeams}
            options={(teams.data ?? []).map((team) => ({ value: team.id, label: `${team.name} (${team.key})` }))}
          />
        </div>
        {canManage && (
          <Button size="sm" onClick={() => setCreating(true)}>
            <Plus />
            {tc.newCycle}
          </Button>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {content}
      </div>

      <CycleFormDialog open={creating} onOpenChange={setCreating} teams={teams.data ?? []} defaultTeamId={teamId} />
      <CycleFormDialog
        open={editing !== null}
        onOpenChange={(open) => !open && setEditing(null)}
        teams={teams.data ?? []}
        cycle={editing}
      />
      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => !open && setDeleting(null)}
        title={tc.deleteTitle}
        description={tc.deleteDescription}
        confirmLabel={t.common.actions.delete}
        variant="destructive"
        loading={remove.isPending}
        onConfirm={confirmDelete}
      />
    </div>
  );
}
