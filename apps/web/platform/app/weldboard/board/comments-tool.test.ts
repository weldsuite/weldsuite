import { describe, expect, it } from 'vitest';
import { MetricsMeasurer } from '@weldsuite/docs-engine';
import { Board, emptySnapshot } from '@weldsuite/board-engine';
import { BoardController } from '../editor/model/board-controller';
import { BoardPanels, openCommentsWithTool } from './panels';

const controller = () => new BoardController(Board.fromSnapshot(emptySnapshot()), { userId: 'alice', userName: 'Alice', measurer: new MetricsMeasurer() });

describe('the comment tool', () => {
  it('opens the comments panel when picked', () => {
    const c = controller();
    const panels = new BoardPanels();
    openCommentsWithTool(c, panels);
    expect(panels.get().open).toBeNull();
    c.setTool('comment');
    expect(panels.get().open).toBe('comments');
  });

  it('leaves the panel closed once closed while the tool stays picked, and takes over from another panel', () => {
    const c = controller();
    const panels = new BoardPanels();
    openCommentsWithTool(c, panels);
    c.setTool('comment');
    panels.close();
    c.setCamera({ x: 10, y: 0, zoom: 1 });
    expect(panels.get().open).toBeNull();

    c.setTool('select');
    panels.toggle('versions');
    c.setTool('comment');
    expect(panels.get().open).toBe('comments');
  });

  it('stops when unsubscribed', () => {
    const c = controller();
    const panels = new BoardPanels();
    openCommentsWithTool(c, panels)();
    c.setTool('comment');
    expect(panels.get().open).toBeNull();
  });
});
