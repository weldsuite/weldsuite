import { describe, expect, it } from 'vitest';
import { MetricsMeasurer } from '@weldsuite/docs-engine';
import { Board, castVoteOp, clearVotingOp, emptySnapshot, makeSticky, takesOthersVotes } from '@weldsuite/board-engine';
import { BoardController } from './board-controller';

/** A board with one sticky and an open round. */
function boardWithRound(): Board {
  const board = Board.fromSnapshot(emptySnapshot());
  board.elements.set('s1', makeSticky(0, 0, {}, { id: 's1', text: 'Idea' }));
  board.props.voting = { id: 'v1', votesPerPerson: 3, anonymous: false, status: 'open' };
  return board;
}

const controller = (board: Board) =>
  new BoardController(board, { userId: 'alice', userName: 'Alice', measurer: new MetricsMeasurer() });

describe('undoing a voting round change', () => {
  it("is no undo step when it takes other people's votes: undo never puts them back", () => {
    const board = boardWithRound();
    board.votes.set('bob', ['s1']);
    const c = controller(board);
    expect(c.apply(castVoteOp(board, 'alice', 's1')!)).toBe(true);
    expect(takesOthersVotes(board, 'alice')).toBe(true);

    c.apply(clearVotingOp(board), { undoable: !takesOthersVotes(board, 'alice') });
    expect(board.props.voting ?? null).toBeNull();
    expect(c.history.undoStack).toHaveLength(1);

    // The one step left is Alice's vote, moved past the clear: it changes nothing now.
    c.undo();
    expect(board.props.voting ?? null).toBeNull();
    expect([...board.votes.entries()].filter(([, ids]) => ids.length > 0)).toEqual([]);
  });

  it('stays an undo step when only your own votes go', () => {
    const board = boardWithRound();
    const c = controller(board);
    c.apply(castVoteOp(board, 'alice', 's1')!);
    expect(takesOthersVotes(board, 'alice')).toBe(false);

    c.apply(clearVotingOp(board), { undoable: !takesOthersVotes(board, 'alice') });
    expect(board.props.voting ?? null).toBeNull();

    c.undo();
    expect(board.props.voting).toMatchObject({ id: 'v1', status: 'open' });
    expect(board.votes.get('alice')).toEqual(['s1']);
  });
});
