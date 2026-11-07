import { useMemo, useState } from 'react';
import { CircleDot, KanbanSquare, List, Plus, Search } from 'lucide-react';
import { useCan } from '@weldsuite/permissions/react';
import { Button } from '@weldsuite/ui/components/button';
import { EmptyState } from '@weldsuite/ui/components/empty-state';
import { ErrorState } from '@weldsuite/ui/components/error-banner';
import { FilterSelect } from '@weldsuite/ui/components/filter-select';
import { Input } from '@weldsuite/ui/components/input';
import { PageLoader } from '@weldsuite/ui/components/page-loader';
import { Switch } from '@weldsuite/ui/components/switch';
import { ToggleGroup, ToggleGroupItem } from '@weldsuite/ui/components/toggle-group';
import type {
  ListMergeIssuesQuery,
  MergeCycleDto,
  MergeIssueDto,
  MergeIssueStatus,
  MergeLabelDto,
} from '@weldsuite/app-api-client/schemas/weldmerge';
import { useDebounce } from '@/hooks/use-debounce';
import {
  useMergeCycles,
  useMergeIssues,
  useMergeLabels,
  useMergeTeams,
} from '@/hooks/queries/use-weldmerge-queries';
import { useI18n } from '@/lib/i18n/provider';
import { Link } from '@/lib/router';
import { IssueBoard } from '../components/issue-board';
import { IssueFormDialog } from '../components/issue-form-dialog';
import { IssueList } from '../components/issue-list';
import { BOARD_STATUSES, ALL_STATUSES } from '../lib/board';
import { fill, formatDateRange } from '../lib/format';
import { WELDMERGE_SETTINGS_PATH } from '../lib/settings-path';

type IssuesView = 'list' | 'board';

const ASSIGNEE_ME = 'me';
const ASSIGNEE_NONE = 'none';

type IssuesQuery = ReturnType<typeof useMergeIssues>;

/** The loading, error, empty, board or list state of the issues area. */
function IssuesResults({
  issues,
  rows,
  view,
  statuses,
  labelById,
  filtered,
  canCreate,
  canUpdate,
  onCreate,
}: Readonly<{
  issues: IssuesQuery;
  rows: MergeIssueDto[];
  view: IssuesView;
  statuses: readonly MergeIssueStatus[];
  labelById: Map<string, MergeLabelDto>;
  filtered: boolean;
  canCreate: boolean;
  canUpdate: boolean;
  onCreate: () => void;
}>) {
  const { t } = useI18n();
  const tm = t.weldmerge;
  if (issues.isLoading) return <PageLoader fullScreen={false} />;
  if (issues.isError) {
    return <ErrorState message={tm.loadFailed} retryLabel={tm.retry} onRetry={() => void issues.refetch()} />;
  }
  if (rows.length === 0) {
    return (
    <div className="p-6">
      <EmptyState
        icon={CircleDot}
        title={filtered ? tm.issues.noResultsTitle : tm.issues.emptyTitle}
        description={filtered ? undefined : tm.issues.emptyDescription}
        action={
          canCreate && !filtered ? (
            <Button onClick={onCreate}>
              <Plus />
              {tm.issues.newIssue}
            </Button>
          ) : undefined
        }
      />
    </div>
    );
  }
  if (view === 'board') return <IssueBoard issues={rows} statuses={statuses} labels={labelById} canMove={canUpdate} />;
  return <IssueList issues={rows} statuses={statuses} labels={labelById} />;
}

/** Search box, assignee, label and cycle filters and the canceled switch. */
function IssuesFilterBar({
  search,
  onSearch,
  assignee,
  onAssignee,
  labelId,
  onLabel,
  cycleId,
  onCycle,
  labels,
  cycles,
  showCanceled,
  onShowCanceled,
  canceledCount,
}: Readonly<{
  search: string;
  onSearch: (value: string) => void;
  assignee: string | undefined;
  onAssignee: (value: string | undefined) => void;
  labelId: string | undefined;
  onLabel: (value: string | undefined) => void;
  cycleId: string | undefined;
  onCycle: (value: string | undefined) => void;
  labels: MergeLabelDto[];
  cycles: MergeCycleDto[];
  showCanceled: boolean;
  onShowCanceled: (value: boolean) => void;
  canceledCount: number;
}>) {
  const { t, language } = useI18n();
  const tm = t.weldmerge;
  return (
    <div className="flex flex-wrap items-center gap-2 border-b px-4 py-2">
      <div className="relative">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={search}
          onChange={(event) => onSearch(event.target.value)}
          placeholder={tm.issues.searchPlaceholder}
          aria-label={tm.issues.searchPlaceholder}
          className="h-8 w-52 pl-8"
        />
      </div>
      <FilterSelect
        value={assignee}
        onChange={onAssignee}
        ariaLabel={tm.issues.assignee}
        allLabel={tm.issues.allAssignees}
        options={[
          { value: ASSIGNEE_ME, label: tm.issues.assignedToMe },
          { value: ASSIGNEE_NONE, label: tm.issues.unassignedFilter },
        ]}
      />
      <FilterSelect
        value={labelId}
        onChange={onLabel}
        ariaLabel={tm.issues.label}
        allLabel={tm.issues.allLabels}
        options={labels.map((label) => ({ value: label.id, label: label.name }))}
      />
      <FilterSelect
        value={cycleId}
        onChange={onCycle}
        ariaLabel={tm.issues.cycle}
        allLabel={tm.issues.allCycles}
        options={cycles.map((cycle) => ({
          value: cycle.id,
          label: `${cycle.name?.trim() || fill(tm.cycles.cycleName, { number: cycle.number })} · ${formatDateRange(cycle.startsAt, cycle.endsAt, language)}`,
        }))}
      />
      <label className="ml-auto flex items-center gap-2 text-sm text-muted-foreground">
        <Switch checked={showCanceled} onCheckedChange={onShowCanceled} aria-label={tm.issues.showCanceled} />
        {fill(tm.issues.canceledCount, { count: canceledCount })}
      </label>
    </div>
  );
}

/**
 * Issues of one team (or all teams) as a board or a list, with filters for
 * assignee, label, cycle and a search box. Canceled issues stay hidden until
 * asked for.
 */
export default function WeldMergeIssuesPage() {
  const { t } = useI18n();
  const tm = t.weldmerge;
  const canCreate = useCan('merge_issues:create');
  const canUpdate = useCan('merge_issues:update');

  const [view, setView] = useState<IssuesView>('board');
  const [teamId, setTeamId] = useState<string | undefined>();
  const [assignee, setAssignee] = useState<string | undefined>();
  const [labelId, setLabelId] = useState<string | undefined>();
  const [cycleId, setCycleId] = useState<string | undefined>();
  const [search, setSearch] = useState('');
  const [showCanceled, setShowCanceled] = useState(false);
  const [creating, setCreating] = useState(false);
  const q = useDebounce(search.trim(), 300) || undefined;

  const teams = useMergeTeams();
  const labels = useMergeLabels(teamId);
  const cycles = useMergeCycles(teamId);
  const params: ListMergeIssuesQuery = { teamId, assignee, labelId, cycleId, q };
  const issues = useMergeIssues(params);

  const labelById = useMemo(
    () => new Map<string, MergeLabelDto>((labels.data ?? []).map((label) => [label.id, label])),
    [labels.data],
  );
  const statuses = showCanceled ? ALL_STATUSES : BOARD_STATUSES;
  const issueRows = useMemo(() => issues.data ?? [], [issues.data]);
  const canceledCount = issueRows.filter((issue) => issue.status === 'canceled').length;

  const changeTeam = (next: string | undefined) => {
    setTeamId(next);
    // Labels and cycles belong to a team.
    setLabelId(undefined);
    setCycleId(undefined);
  };

  if (teams.isLoading) return <PageLoader fullScreen={false} />;
  if (teams.isError) {
    return <ErrorState message={tm.loadFailed} retryLabel={tm.retry} onRetry={() => void teams.refetch()} />;
  }

  if ((teams.data ?? []).length === 0) {
    return (
      <div className="p-6">
        <EmptyState
          icon={CircleDot}
          title={tm.issues.noTeamsTitle}
          description={tm.issues.noTeamsDescription}
          action={
            <Button asChild>
              <Link href={WELDMERGE_SETTINGS_PATH}>{tm.issues.openSettings}</Link>
            </Button>
          }
        />
      </div>
    );
  }

  const filtered = !!(assignee || labelId || cycleId || q);

  return (
    <div className="flex h-full flex-col">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b px-4 py-3">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="mr-2 text-lg font-semibold">{tm.issues.title}</h1>
          <FilterSelect
            value={teamId}
            onChange={changeTeam}
            ariaLabel={tm.issues.team}
            allLabel={tm.issues.allTeams}
            options={(teams.data ?? []).map((team) => ({ value: team.id, label: `${team.name} (${team.key})` }))}
          />
          <ToggleGroup
            type="single"
            variant="outline"
            size="sm"
            value={view}
            onValueChange={(next) => next && setView(next as IssuesView)}
            aria-label={tm.issues.title}
          >
            <ToggleGroupItem value="list" aria-label={tm.issues.list}>
              <List />
              <span className="hidden sm:inline">{tm.issues.list}</span>
            </ToggleGroupItem>
            <ToggleGroupItem value="board" aria-label={tm.issues.board}>
              <KanbanSquare />
              <span className="hidden sm:inline">{tm.issues.board}</span>
            </ToggleGroupItem>
          </ToggleGroup>
        </div>
        {canCreate && (
          <Button size="sm" onClick={() => setCreating(true)}>
            <Plus />
            {tm.issues.newIssue}
          </Button>
        )}
      </div>

      <IssuesFilterBar
        search={search}
        onSearch={setSearch}
        assignee={assignee}
        onAssignee={setAssignee}
        labelId={labelId}
        onLabel={setLabelId}
        cycleId={cycleId}
        onCycle={setCycleId}
        labels={labels.data ?? []}
        cycles={cycles.data ?? []}
        showCanceled={showCanceled}
        onShowCanceled={setShowCanceled}
        canceledCount={canceledCount}
      />

      <div className="min-h-0 flex-1 overflow-y-auto">
        <IssuesResults
          issues={issues}
          rows={issueRows}
          view={view}
          statuses={statuses}
          labelById={labelById}
          filtered={filtered}
          canCreate={canCreate}
          canUpdate={canUpdate}
          onCreate={() => setCreating(true)}
        />
      </div>

      <IssueFormDialog open={creating} onOpenChange={setCreating} defaultTeamId={teamId} />
    </div>
  );
}
