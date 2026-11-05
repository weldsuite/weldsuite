import { describe, expect, it } from 'vitest';
import type { MergeIssueDto, MergeIssueStatus } from '@weldsuite/app-api-client/schemas/weldmerge';
import {
  BOARD_STATUSES,
  SORT_STEP,
  boardMoveFor,
  cardsFromIssues,
  compareByBoardOrder,
  groupByStatus,
  sortPatchesForMove,
  type BoardCard,
} from './board';

function issue(id: string, status: MergeIssueStatus, sortOrder: number, createdAt = '2026-11-01T00:00:00.000Z'): MergeIssueDto {
  return {
    id,
    teamId: 'mtm_1',
    teamKey: 'PLAT',
    number: Number(id.replace(/\D/g, '')) || 1,
    key: `PLAT-${id}`,
    title: `Issue ${id}`,
    description: null,
    status,
    priority: 0,
    assigneeUserId: null,
    creatorUserId: 'user_1',
    cycleId: null,
    parentIssueId: null,
    labelIds: [],
    estimate: null,
    dueDate: null,
    flowProjectId: null,
    agentId: null,
    sortOrder,
    pullRequestCount: 0,
    startedAt: null,
    completedAt: null,
    canceledAt: null,
    createdAt,
    updatedAt: createdAt,
  };
}

describe('board order', () => {
  it('sorts by sortOrder, newest first on ties', () => {
    const a = issue('1', 'todo', 5, '2026-11-01T00:00:00.000Z');
    const b = issue('2', 'todo', 5, '2026-11-02T00:00:00.000Z');
    const c = issue('3', 'todo', 1);
    expect([a, b, c].sort(compareByBoardOrder).map((i) => i.id)).toEqual(['3', '2', '1']);
  });

  it('groups by status in board order', () => {
    const groups = groupByStatus([issue('1', 'todo', 2), issue('2', 'todo', 1), issue('3', 'done', 0)]);
    expect(groups.todo.map((i) => i.id)).toEqual(['2', '1']);
    expect(groups.done.map((i) => i.id)).toEqual(['3']);
    expect(groups.canceled).toEqual([]);
  });
});

describe('sortPatchesForMove', () => {
  it('writes 0 for a card alone in its column', () => {
    expect(sortPatchesForMove([{ id: 'a', sortOrder: 7 }], 'a')).toEqual([{ id: 'a', sortOrder: 0 }]);
  });

  it('puts a card between its neighbours', () => {
    const patches = sortPatchesForMove(
      [
        { id: 'a', sortOrder: 1 },
        { id: 'm', sortOrder: 99 },
        { id: 'b', sortOrder: 3 },
      ],
      'm',
    );
    expect(patches).toEqual([{ id: 'm', sortOrder: 2 }]);
  });

  it('steps past either end of the column', () => {
    expect(
      sortPatchesForMove(
        [
          { id: 'm', sortOrder: 0 },
          { id: 'b', sortOrder: 10 },
        ],
        'm',
      ),
    ).toEqual([{ id: 'm', sortOrder: 10 - SORT_STEP }]);
    expect(
      sortPatchesForMove(
        [
          { id: 'a', sortOrder: 10 },
          { id: 'm', sortOrder: 0 },
        ],
        'm',
      ),
    ).toEqual([{ id: 'm', sortOrder: 10 + SORT_STEP }]);
  });

  it('renumbers the column when neighbours tie, moved card first', () => {
    const patches = sortPatchesForMove(
      [
        { id: 'a', sortOrder: 0 },
        { id: 'm', sortOrder: 5 },
        { id: 'b', sortOrder: 0 },
      ],
      'm',
    );
    expect(patches[0]).toEqual({ id: 'm', sortOrder: 2 * SORT_STEP });
    expect(patches.map((p) => p.id).sort()).toEqual(['a', 'b', 'm']);
    expect(patches.find((p) => p.id === 'a')?.sortOrder).toBe(SORT_STEP);
    expect(patches.find((p) => p.id === 'b')?.sortOrder).toBe(3 * SORT_STEP);
  });

  it('returns nothing for an unknown card', () => {
    expect(sortPatchesForMove([{ id: 'a', sortOrder: 0 }], 'zzz')).toEqual([]);
  });
});

describe('boardMoveFor', () => {
  const issues = [issue('1', 'todo', 1), issue('2', 'todo', 2), issue('3', 'in_progress', 1)];
  const before = cardsFromIssues(issues, BOARD_STATUSES);
  const clone = (cards: BoardCard[]) => cards.map((card) => ({ ...card }));

  it('is null when the card is back where it started', () => {
    expect(boardMoveFor(before, clone(before), '1')).toBeNull();
  });

  it('moves a card to another column and places it among the cards there', () => {
    const after = clone(before);
    after.find((card) => card.id === '1')!.column = 'in_progress';
    const move = boardMoveFor(before, after, '1');
    // Card 1 lands first in the column, ahead of card 3 (sortOrder 1).
    expect(move).toEqual({ issueId: '1', status: 'in_progress', patches: [{ id: '1', sortOrder: 1 - SORT_STEP }] });
  });

  it('moves a card into an empty column', () => {
    const after = clone(before);
    after.find((card) => card.id === '2')!.column = 'done';
    expect(boardMoveFor(before, after, '2')).toEqual({ issueId: '2', status: 'done', patches: [{ id: '2', sortOrder: 0 }] });
  });

  it('reorders inside a column', () => {
    // Card 2 dragged above card 1.
    const after = clone(before);
    const [two] = after.splice(1, 1);
    after.unshift(two!);
    const move = boardMoveFor(before, after, '2');
    expect(move?.status).toBe('todo');
    expect(move?.patches).toEqual([{ id: '2', sortOrder: 1 - SORT_STEP }]);
  });
});
