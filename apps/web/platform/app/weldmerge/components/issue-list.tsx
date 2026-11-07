import { GitPullRequest } from 'lucide-react';
import { ListTable, type ListTableColumn, type ListTableGroup } from '@weldsuite/ui/components/list-table';
import type { MergeIssueDto, MergeIssueStatus, MergeLabelDto } from '@weldsuite/app-api-client/schemas/weldmerge';
import { useI18n } from '@/lib/i18n/provider';
import { useRouter } from '@/lib/router';
import { compareByBoardOrder } from '../lib/board';
import { relativeTime } from '../lib/format';
import { IssueStatusIcon, LabelChip, MemberAvatar, PriorityBars } from './primitives';

/** Issues as rows grouped by status, in board order inside each group. */
export function IssueList({
  issues,
  statuses,
  labels,
}: Readonly<{
  issues: readonly MergeIssueDto[];
  statuses: readonly MergeIssueStatus[];
  labels: ReadonlyMap<string, MergeLabelDto>;
}>) {
  const { t, language } = useI18n();
  const tm = t.weldmerge;
  const router = useRouter();

  const rows = [...issues].filter((issue) => statuses.includes(issue.status)).sort(compareByBoardOrder);

  const groups: ListTableGroup<MergeIssueDto>[] = statuses.map((status, index) => ({
    id: status,
    sortOrder: index,
    hideWhenEmpty: true,
    label: (
      <span className="flex items-center gap-2">
        <IssueStatusIcon status={status} />
        {tm.status[status]}
      </span>
    ),
    filter: (issue) => issue.status === status,
  }));

  const columns: ListTableColumn<MergeIssueDto>[] = [
    {
      id: 'priority',
      header: '',
      width: 'w-[1.5rem]',
      cell: (issue) => <PriorityBars priority={issue.priority} />,
    },
    {
      id: 'key',
      header: tm.issues.title,
      width: 'w-[6rem]',
      cell: (issue) => <span className="text-xs text-muted-foreground">{issue.key}</span>,
    },
    {
      id: 'title',
      header: '',
      className: 'flex-1',
      cell: (issue) => (
        <div className="flex min-w-0 items-center gap-2">
          <IssueStatusIcon status={issue.status} />
          <span className="truncate text-sm">{issue.title}</span>
        </div>
      ),
    },
    {
      id: 'labels',
      header: '',
      width: 'w-[12rem]',
      className: 'hidden lg:flex gap-1',
      cell: (issue) =>
        issue.labelIds
          .slice(0, 2)
          .map((id) => labels.get(id))
          .filter((label): label is MergeLabelDto => !!label)
          .map((label) => <LabelChip key={label.id} name={label.name} color={label.color} />),
    },
    {
      id: 'pullRequests',
      header: '',
      width: 'w-[3.5rem]',
      className: 'hidden md:flex',
      cell: (issue) =>
        issue.pullRequestCount > 0 ? (
          <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
            <GitPullRequest className="size-3.5" />
            {issue.pullRequestCount}
          </span>
        ) : null,
    },
    {
      id: 'assignee',
      header: '',
      width: 'w-[2rem]',
      cell: (issue) => <MemberAvatar userId={issue.assigneeUserId} />,
    },
    {
      id: 'updated',
      header: '',
      width: 'w-[5rem]',
      align: 'right',
      className: 'hidden sm:flex',
      cell: (issue) => (
        <span className="text-xs text-muted-foreground">{relativeTime(issue.updatedAt, language, tm.justNow)}</span>
      ),
    },
  ];

  return (
    <ListTable
      columns={columns}
      data={rows}
      groups={groups}
      rowKey={(issue) => issue.id}
      rowLabel={(issue) => `${issue.key} ${issue.title}`}
      onRowClick={(issue) => router.push(`/weldmerge/issues/${issue.key}`)}
      dense
    />
  );
}
