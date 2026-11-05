import { useEffect, useMemo, useState } from 'react';
import { GitPullRequest } from 'lucide-react';
import { arrayMove } from '@dnd-kit/sortable';
import type { DragEndEvent } from '@dnd-kit/core';
import { toast } from 'sonner';
import {
  KanbanBoard,
  KanbanCard,
  KanbanCards,
  KanbanHeader,
  KanbanProvider,
} from '@weldsuite/ui/components/kanban';
import type { MergeIssueDto, MergeIssueStatus, MergeLabelDto } from '@weldsuite/app-api-client/schemas/weldmerge';
import { useMoveMergeIssue } from '@/hooks/queries/use-weldmerge-queries';
import { useI18n } from '@/lib/i18n/provider';
import { useRouter } from '@/lib/router';
import { boardMoveFor, cardsFromIssues, type BoardCard } from '../lib/board';
import { fill } from '../lib/format';
import { IssueStatusIcon, LabelChip, MemberAvatar, PriorityBars } from './primitives';

/** One issue on the board: key, title, priority, labels, linked pull requests, assignee. */
export function IssueCardBody({ issue, labels }: Readonly<{ issue: MergeIssueDto; labels: ReadonlyMap<string, MergeLabelDto> }>) {
  const { t } = useI18n();
  const issueLabels = issue.labelIds.map((id) => labels.get(id)).filter((label): label is MergeLabelDto => !!label);
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
        <span>{issue.key}</span>
        <MemberAvatar userId={issue.assigneeUserId} />
      </div>
      <p className="text-sm font-medium leading-snug">{issue.title}</p>
      <div className="flex flex-wrap items-center gap-1.5">
        <PriorityBars priority={issue.priority} />
        {issueLabels.slice(0, 2).map((label) => (
          <LabelChip key={label.id} name={label.name} color={label.color} />
        ))}
        {issueLabels.length > 2 && <span className="text-xs text-muted-foreground">+{issueLabels.length - 2}</span>}
        {issue.pullRequestCount > 0 && (
          <span
            className="ml-auto inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-xs text-muted-foreground"
            title={fill(t.weldmerge.issues.pullRequestChip, { number: issue.pullRequestCount })}
          >
            <GitPullRequest className="size-3" />
            {issue.pullRequestCount}
          </span>
        )}
      </div>
    </div>
  );
}

/**
 * The board: one column per status, cards dragged between and within columns.
 * A finished drag becomes one status + sortOrder write (see lib/board.ts); the
 * cached lists change first, so the card stays where it was dropped.
 */
export function IssueBoard({
  issues,
  statuses,
  labels,
  canMove,
}: Readonly<{
  issues: readonly MergeIssueDto[];
  statuses: readonly MergeIssueStatus[];
  labels: ReadonlyMap<string, MergeLabelDto>;
  canMove: boolean;
}>) {
  const { t } = useI18n();
  const router = useRouter();
  const move = useMoveMergeIssue();

  // `saved` is the board as stored; `cards` is the working copy the drag edits
  // (the kanban mutates card objects while dragging, hence the clones).
  const saved = useMemo(() => cardsFromIssues(issues, statuses), [issues, statuses]);
  const [cards, setCards] = useState<BoardCard[]>(() => saved.map((card) => ({ ...card })));
  useEffect(() => setCards(saved.map((card) => ({ ...card }))), [saved]);

  const columns = useMemo(() => statuses.map((status) => ({ id: status, name: t.weldmerge.status[status] })), [statuses, t]);

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || !canMove) {
      setCards(saved.map((card) => ({ ...card })));
      return;
    }
    // The kanban applies this same move after our callback; mirror it to know where the card lands.
    const from = cards.findIndex((card) => card.id === active.id);
    const to = cards.findIndex((card) => card.id === over.id);
    const final = active.id === over.id || from < 0 ? cards : arrayMove(cards, from, to);
    const result = boardMoveFor(saved, final, String(active.id));
    if (!result) return;
    move.mutate(result, { onError: () => toast.error(t.weldmerge.issues.moveFailed) });
  };

  return (
    <div className="h-full overflow-x-auto p-4">
      <KanbanProvider<BoardCard>
        columns={columns}
        data={cards}
        onDataChange={setCards}
        onDragEnd={handleDragEnd}
        onDragCancel={() => setCards(saved.map((card) => ({ ...card })))}
        className="h-full items-start"
      >
        {(column) => {
          const count = cards.filter((card) => card.column === column.id).length;
          return (
            <KanbanBoard key={column.id} id={column.id} className="mx-1 h-fit max-h-full bg-muted/40">
              <KanbanHeader className="flex items-center gap-2">
                <IssueStatusIcon status={column.id as MergeIssueStatus} />
                <span>{column.name}</span>
                <span className="font-normal text-muted-foreground">{count}</span>
              </KanbanHeader>
              <KanbanCards<BoardCard> id={column.id} className="max-h-[calc(100vh-18rem)] min-h-16 overflow-y-auto">
                {(card) => (
                  <KanbanCard<BoardCard>
                    key={card.id}
                    {...card}
                    onClick={() => router.push(`/weldmerge/issues/${card.issue.key}`)}
                  >
                    <IssueCardBody issue={card.issue} labels={labels} />
                  </KanbanCard>
                )}
              </KanbanCards>
            </KanbanBoard>
          );
        }}
      </KanbanProvider>
    </div>
  );
}
