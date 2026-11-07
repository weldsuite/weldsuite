/**
 * Board ordering for WeldMerge issues. `sortOrder` is a double ordered
 * smallest first inside a status column; moving a card writes one new value
 * between its neighbours, and only when neighbours tie (every new issue starts
 * at 0) is the whole column renumbered.
 */

import type { MergeIssueDto, MergeIssueStatus } from '@weldsuite/app-api-client/schemas/weldmerge';

/** Gap between renumbered cards, and the step past either end of a column. */
export const SORT_STEP = 1024;

/** The columns of the board, left to right. Canceled sits behind a toggle. */
export const BOARD_STATUSES: readonly MergeIssueStatus[] = ['backlog', 'todo', 'in_progress', 'in_review', 'done'];

export const ALL_STATUSES: readonly MergeIssueStatus[] = [...BOARD_STATUSES, 'canceled'];

type Orderable = Pick<MergeIssueDto, 'id' | 'sortOrder' | 'createdAt'>;

/** Board order: smallest `sortOrder` first; ties keep the newest issue on top. */
export function compareByBoardOrder(a: Orderable, b: Orderable): number {
  if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder;
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? 1 : -1;
  return a.id < b.id ? -1 : 1;
}

/** Issues grouped by status, each group in board order. */
export function groupByStatus<T extends Orderable & { status: MergeIssueStatus }>(
  issues: readonly T[],
): Record<MergeIssueStatus, T[]> {
  const groups = Object.fromEntries(ALL_STATUSES.map((status) => [status, [] as T[]])) as Record<MergeIssueStatus, T[]>;
  for (const issue of issues) groups[issue.status].push(issue);
  for (const status of ALL_STATUSES) groups[status].sort(compareByBoardOrder);
  return groups;
}

export interface SortPatch {
  id: string;
  sortOrder: number;
}

/**
 * The `sortOrder` writes needed after `movedId` landed in `ordered` (the target
 * column in its new order, the moved card included). The first patch is always
 * the moved card; any further patches renumber the column because its
 * neighbours left no room between them.
 */
export function sortPatchesForMove(
  ordered: ReadonlyArray<Pick<MergeIssueDto, 'id' | 'sortOrder'>>,
  movedId: string,
): SortPatch[] {
  const index = ordered.findIndex((card) => card.id === movedId);
  if (index < 0) return [];
  const prev = ordered[index - 1]?.sortOrder;
  const next = ordered[index + 1]?.sortOrder;

  if (prev === undefined && next === undefined) return [{ id: movedId, sortOrder: 0 }];
  if (prev === undefined) return [{ id: movedId, sortOrder: (next as number) - SORT_STEP }];
  if (next === undefined) return [{ id: movedId, sortOrder: prev + SORT_STEP }];

  const middle = (prev + next) / 2;
  if (prev < next && middle > prev && middle < next) return [{ id: movedId, sortOrder: middle }];

  // No room between the neighbours: renumber the column, moved card first.
  const renumbered = ordered.map((card, i) => ({ id: card.id, sortOrder: (i + 1) * SORT_STEP }));
  const moved = renumbered.find((card) => card.id === movedId)!;
  return [moved, ...renumbered.filter((card) => card.id !== movedId)];
}

/** A card on the board: the library's kanban item shape plus the issue. */
/** A type alias (not an interface) so it satisfies the kanban's `Record<string, unknown>` item constraint. */
export type BoardCard = {
  id: string;
  name: string;
  column: MergeIssueStatus;
  issue: MergeIssueDto;
};

export function cardsFromIssues(issues: readonly MergeIssueDto[], statuses: readonly MergeIssueStatus[]): BoardCard[] {
  const groups = groupByStatus(issues);
  return statuses.flatMap((status) =>
    groups[status].map((issue) => ({ id: issue.id, name: issue.title, column: issue.status, issue })),
  );
}

/** The ids of one column, top to bottom. */
export function columnIds(cards: readonly BoardCard[], status: MergeIssueStatus): string[] {
  return cards.filter((card) => card.column === status).map((card) => card.id);
}

/** What to persist once a drag ends. */
export interface BoardMove {
  issueId: string;
  status: MergeIssueStatus;
  patches: SortPatch[];
}

/**
 * Works out what a finished drag changed. `before` is the board as last saved,
 * `after` the board at the end of the drag (the dragged card already in its new
 * column and place). Null when the card ended up where it started.
 */
export function boardMoveFor(
  before: readonly BoardCard[],
  after: readonly BoardCard[],
  movedId: string,
): BoardMove | null {
  const original = before.find((card) => card.id === movedId);
  const moved = after.find((card) => card.id === movedId);
  if (!original || !moved) return null;

  const sameColumn = original.column === moved.column;
  if (sameColumn && columnIds(before, moved.column).join() === columnIds(after, moved.column).join()) return null;

  // Sort values come from the saved issues: the dragged card's own value is
  // replaced by the patch, its neighbours' values stay as saved.
  const ordered = after
    .filter((card) => card.column === moved.column)
    .map((card) => ({ id: card.id, sortOrder: card.issue.sortOrder }));
  const patches = sortPatchesForMove(ordered, movedId);
  if (patches.length === 0) return null;
  return { issueId: movedId, status: moved.column, patches };
}
