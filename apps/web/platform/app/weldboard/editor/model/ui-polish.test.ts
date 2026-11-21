import { describe, expect, it } from 'vitest';
import { MetricsMeasurer } from '@weldsuite/docs-engine';
import { Board, emptySnapshot, makeShape, makeSticky, makeText } from '@weldsuite/board-engine';
import { colorName, type ColorNames } from '../swatches';
import { BoardController } from './board-controller';
import { handlePositions, Interactions, LINK_BADGE_INSET, linkBadges, type PointerInfo } from './interactions';
import { handleKey } from './keyboard';
import { deleteBackward, insertText } from './text-editing';

const controller = (board = Board.fromSnapshot(emptySnapshot())) =>
  new BoardController(board, { userId: 'alice', userName: 'Alice', measurer: new MetricsMeasurer() });

const key = (k: string, shift = false) => ({ key: k, shift, alt: false, mod: false, composing: false });

const EN: ColorNames = {
  hues: { red: 'red', orange: 'orange', yellow: 'yellow', lime: 'lime', green: 'green', teal: 'teal', cyan: 'cyan', blue: 'blue', indigo: 'indigo', violet: 'violet', purple: 'purple', pink: 'pink', grey: 'grey', white: 'white', black: 'black' },
  light: 'light {color}',
  dark: 'dark {color}',
};

describe('colour names for swatches', () => {
  it('names a colour by its hue and lightness, not its hex code', () => {
    expect(colorName('#fff9b1', EN)).toBe('Light yellow');
    expect(colorName('#ff9d48', EN)).toBe('Orange');
    expect(colorName('#3b82f6', EN)).toBe('Blue');
    expect(colorName('#1f2937', EN)).toBe('Dark blue');
    expect(colorName('#ffffff', EN)).toBe('White');
    expect(colorName('#e6e6e6', EN)).toBe('Light grey');
  });

  it('follows the language pattern (Dutch writes light colours as one word)', () => {
    const nl = { ...EN, hues: { ...EN.hues, yellow: 'geel' }, light: 'licht{color}' };
    expect(colorName('#fff9b1', nl)).toBe('Lichtgeel');
  });

  it('keeps anything that is not a hex colour as it is', () => {
    expect(colorName('transparent', EN)).toBe('transparent');
  });
});

describe('revealing something on the board', () => {
  it('moves just far enough, at the same zoom, and not at all when it is in view', () => {
    const c = controller();
    c.setViewport(1000, 800);
    c.setCamera({ x: 0, y: 0, zoom: 1 });
    c.reveal({ x: 100, y: 100, w: 100, h: 50 });
    expect(c.camera).toEqual({ x: 0, y: 0, zoom: 1 });
    c.reveal({ x: 1200, y: 100, w: 100, h: 50 });
    expect(c.camera).toEqual({ x: 348, y: 0, zoom: 1 });
  });
});

describe('typing a mind map', () => {
  /** A mind map's centre topic, being typed. */
  function mindMap() {
    const board = Board.fromSnapshot(emptySnapshot());
    const root = makeShape('rounded', 0, 0, 220, 80, { order: 'a0' }, { id: 'root' });
    root.mindmap = { root: 'root' };
    board.elements.set('root', root);
    const c = controller(board);
    c.setViewport(1200, 800);
    const ia = new Interactions(c);
    c.select(['root']);
    c.startEditing('root', 0);
    insertText(c, 'Launch plan');
    return { c, ia };
  }

  it('Tab finishes the topic and starts a child, Enter a sibling', () => {
    const { c, ia } = mindMap();
    expect(handleKey(c, ia, key('Tab'))).toBe(true);
    expect(c.board.get('root')?.text?.text).toBe('Launch plan');
    const child = c.board.get(c.editing!.id)!;
    expect(child.mindmap?.parent).toBe('root');

    insertText(c, 'Marketing');
    expect(handleKey(c, ia, key('Enter'))).toBe(true);
    const sibling = c.board.get(c.editing!.id)!;
    expect(sibling.id).not.toBe(child.id);
    expect(sibling.mindmap?.parent).toBe('root');
    expect(c.board.get(child.id)?.text?.text).toBe('Marketing');
  });

  it('Shift+Enter still adds a line to the topic', () => {
    const { c, ia } = mindMap();
    handleKey(c, ia, key('Enter', true));
    expect(c.editing?.id).toBe('root');
    expect(c.board.get('root')?.text?.text).toBe('Launch plan\n');
  });
});

describe('links on sticky notes and shapes', () => {
  function boardWithLink() {
    const board = Board.fromSnapshot(emptySnapshot());
    board.elements.set('s1', { ...makeSticky(0, 0, { order: 'a0' }, { id: 's1', text: 'Spec' }), link: 'https://example.com/spec' });
    board.elements.set('s2', makeSticky(400, 0, { order: 'a1' }, { id: 's2', text: 'No link' }));
    const c = controller(board);
    c.setViewport(1200, 800);
    c.setCamera({ x: 0, y: 0, zoom: 1 });
    return c;
  }
  const press = (screen: { x: number; y: number }): PointerInfo => ({ screen, button: 0, shift: false, alt: false, mod: false, pressure: 0.5, pointerType: 'mouse' });

  it('shows a badge in the top-right corner of an element with a link, and only there', () => {
    const c = boardWithLink();
    const badges = linkBadges(c);
    expect(badges.map((b) => b.el.id)).toEqual(['s1']);
    const s1 = c.board.get('s1')!;
    expect(badges[0].at).toEqual({ x: s1.x + s1.w - LINK_BADGE_INSET, y: s1.y + LINK_BADGE_INSET });
  });

  it('leaves the badge off when the element is too small on screen to carry one', () => {
    const c = boardWithLink();
    c.setCamera({ x: 0, y: 0, zoom: 0.2 });
    expect(linkBadges(c)).toEqual([]);
  });

  it('opens the link from the badge, also on a board you may only view', () => {
    const c = boardWithLink();
    const ia = new Interactions(c);
    const opened: string[] = [];
    ia.onOpenLink = (url) => opened.push(url);
    const at = linkBadges(c)[0].at;
    expect(ia.cursorAt(at)).toBe('pointer');
    ia.down(press(at));
    expect(opened).toEqual(['https://example.com/spec']);
    expect(c.selection.size).toBe(0);

    c.setReadOnly(true);
    ia.down(press(at));
    expect(opened).toHaveLength(2);
  });

  it('leaves the corner to the resize handle while the element is selected', () => {
    const c = boardWithLink();
    const ia = new Interactions(c);
    const opened: string[] = [];
    ia.onOpenLink = (url) => opened.push(url);
    c.select(['s1']);
    const s1 = c.board.get('s1')!;
    const corner = { x: s1.x + s1.w, y: s1.y };
    expect(ia.cursorAt(corner)).not.toBe('pointer');
    ia.down(press(corner));
    expect(opened).toEqual([]);
  });
});

describe('right-click', () => {
  it('selects what is under the pointer for its menu, and clears the selection on empty board', () => {
    const board = Board.fromSnapshot(emptySnapshot());
    board.elements.set('s1', makeSticky(0, 0, { order: 'a0' }, { id: 's1' }));
    const c = controller(board);
    c.setViewport(1200, 800);
    c.setCamera({ x: 0, y: 0, zoom: 1 });
    const ia = new Interactions(c);

    expect(ia.contextMenu({ x: 50, y: 50 })).toBe('selection');
    expect([...c.selection]).toEqual(['s1']);

    expect(ia.contextMenu({ x: 900, y: 600 })).toBe('canvas');
    expect(c.selection.size).toBe(0);
  });
});

describe('a text box as tall as its text', () => {
  function typing() {
    const board = Board.fromSnapshot(emptySnapshot());
    board.elements.set('t1', makeText(0, 0, '', { order: 'a0' }, { id: 't1', w: 300 }));
    const c = controller(board);
    c.setViewport(1200, 800);
    c.select(['t1']);
    c.startEditing('t1', 0);
    insertText(c, 'First line');
    return c;
  }

  it('grows with each new line and shrinks when one goes', () => {
    const c = typing();
    const one = c.board.get('t1')!.h;
    insertText(c, '\nSecond line');
    const two = c.board.get('t1')!.h;
    expect(two).toBeGreaterThan(one * 1.8);
    for (let i = 0; i < '\nSecond line'.length; i++) deleteBackward(c);
    expect(c.board.get('t1')!.h).toBe(one);
  });

  it('undoes the text and its height in one step', () => {
    const c = typing();
    c.stopEditing();
    c.select(['t1']);
    c.startEditing('t1', 'First line'.length);
    const one = c.board.get('t1')!.h;
    insertText(c, '\nSecond line');
    c.stopEditing();
    c.undo();
    expect(c.board.get('t1')?.text?.text).toBe('First line');
    expect(c.board.get('t1')!.h).toBe(one);
  });

  it('gets taller when made narrower, and has no top or bottom handle', () => {
    const c = typing();
    c.stopEditing();
    const one = c.board.get('t1')!.h;
    c.apply({ type: 'set', id: 't1', patch: { w: 60 } });
    expect(c.board.get('t1')!.h).toBeGreaterThan(one);
    c.select(['t1']);
    const sides = handlePositions(c).flatMap(({ handle }) => (handle.kind === 'resize' ? [handle.handle] : []));
    expect(sides).not.toContain('n');
    expect(sides).not.toContain('s');
    expect(sides).toContain('e');
  });
});
