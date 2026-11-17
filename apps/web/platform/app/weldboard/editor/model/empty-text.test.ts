import { describe, expect, it } from 'vitest';
import { MetricsMeasurer } from '@weldsuite/docs-engine';
import { Board, emptySnapshot, makeText } from '@weldsuite/board-engine';
import { BoardController } from './board-controller';
import { insertText, selectAllText, deleteBackward } from './text-editing';

const controller = () =>
  new BoardController(Board.fromSnapshot(emptySnapshot()), { userId: 'alice', userName: 'Alice', measurer: new MetricsMeasurer() });

describe('a text box left empty', () => {
  it('goes when you click away, and leaves no undo step', () => {
    const c = controller();
    c.apply({ type: 'create', elements: [makeText(0, 0, '', {}, { id: 't1' })] }, { select: ['t1'] });
    c.startEditing('t1', 0);
    c.stopEditing();
    expect(c.board.get('t1')).toBeUndefined();
    expect(c.history.undoStack).toHaveLength(0);
  });

  it('also goes when you pick another tool', () => {
    const c = controller();
    c.apply({ type: 'create', elements: [makeText(0, 0, '', {}, { id: 't1' })] }, { select: ['t1'] });
    c.startEditing('t1', 0);
    c.setTool('sticky');
    expect(c.board.get('t1')).toBeUndefined();
  });

  it('stays when it has text', () => {
    const c = controller();
    c.apply({ type: 'create', elements: [makeText(0, 0, '', {}, { id: 't1' })] }, { select: ['t1'] });
    c.startEditing('t1', 0);
    insertText(c, 'Hello');
    c.stopEditing();
    expect(c.board.get('t1')?.text?.text).toBe('Hello');
  });

  it('goes when its text is cleared, and undo brings it back', () => {
    const c = controller();
    c.apply({ type: 'create', elements: [makeText(0, 0, 'Hello', {}, { id: 't1' })] });
    c.history.seal();
    c.startEditing('t1');
    selectAllText(c);
    deleteBackward(c);
    c.stopEditing();
    expect(c.board.get('t1')).toBeUndefined();
    c.undo();
    c.undo();
    expect(c.board.get('t1')?.text?.text).toBe('Hello');
  });
});
