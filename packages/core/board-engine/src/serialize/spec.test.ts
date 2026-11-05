import { describe, expect, it } from 'vitest';
import { Board } from '../model/board';
import { makeFrame, makeSticky } from '../model/defaults';
import { keysBetween } from '../model/order';
import { plain } from '../model/text';
import { isElement } from '../model/schema';
import { applyOp } from '../ops/apply';
import { isWellFormedOp } from '../ops/shape';
import { validateOp } from '../ops/validate';
import { clusterOps, editOps, fragmentFromSpec, normalizeSpec, placeSpec, SPEC_LIMITS, specSize, type BoardSpec } from './spec';

let seq = 0;
const makeId = () => `s${++seq}`;

/** Puts the spec on the board the way the room would: shape check, validation, apply. */
function put(board: Board, spec: BoardSpec, at?: { x: number; y: number }) {
  const placed = placeSpec(board, spec, { makeId, ...(at ? { at } : {}) });
  expect(isWellFormedOp(placed.op)).toBe(true);
  expect(validateOp(board, placed.op)).toBeNull();
  applyOp(board, placed.op);
  return placed;
}

describe('board specs', () => {
  it('lays sticky notes out in a grid, every element well formed', () => {
    const board = Board.create();
    const placed = put(board, { items: Array.from({ length: 9 }, (_, i) => ({ type: 'sticky' as const, text: `Idea ${i + 1}`, color: 'pink' as const })) });
    expect(placed.ids).toHaveLength(9);
    const els = placed.ids.map((id) => board.get(id)!);
    for (const el of els) expect(isElement(el)).toBe(true);
    // Three rows of three, none overlapping.
    expect(new Set(els.map((e) => e.y)).size).toBe(3);
    expect(new Set(els.map((e) => e.x)).size).toBe(3);
    expect(els[0]!.fill).toBe('#ffcee0');
  });

  it('runs a flowchart down along its lines, with bound arrows and labels', () => {
    const board = Board.create();
    const placed = put(board, {
      items: [
        { key: 'start', type: 'shape', shape: 'terminator', text: 'Ticket comes in' },
        { key: 'triage', type: 'shape', shape: 'diamond', text: 'Urgent?' },
        { key: 'now', type: 'shape', text: 'Call the customer' },
        { key: 'later', type: 'shape', text: 'Reply within a day' },
      ],
      lines: [
        { from: 'start', to: 'triage' },
        { from: 'triage', to: 'now', label: 'Yes' },
        { from: 'triage', to: 'later', label: 'No' },
      ],
    });
    const node = (key: string) => board.get(placed.keys[key]!)!;
    expect(node('start').y).toBeLessThan(node('triage').y);
    expect(node('triage').y).toBeLessThan(node('now').y);
    expect(node('now').y).toBe(node('later').y);
    expect(node('triage').shape).toBe('diamond');
    const arrows = [...board.elements.values()].filter((e) => e.type === 'connector');
    expect(arrows).toHaveLength(3);
    for (const a of arrows) {
      expect(board.get(a.start!.el!)).toBeDefined();
      expect(board.get(a.end!.el!)).toBeDefined();
    }
    expect(arrows.map((a) => a.text?.text ?? '').sort()).toEqual(['', 'No', 'Yes']);
  });

  it('survives a cycle in the lines', () => {
    const board = Board.create();
    const placed = put(board, {
      items: [
        { key: 'a', type: 'sticky', text: 'A' },
        { key: 'b', type: 'sticky', text: 'B' },
      ],
      lines: [
        { from: 'a', to: 'b' },
        { from: 'b', to: 'a' },
      ],
    });
    expect(Object.keys(placed.keys)).toEqual(['a', 'b']);
  });

  it('puts items in their frames, frames side by side', () => {
    const board = Board.create();
    const placed = put(board, {
      frames: [
        { key: 'well', title: 'Went well' },
        { key: 'better', title: 'To improve' },
      ],
      items: [
        { type: 'sticky', text: 'Shipped on time', frame: 'well' },
        { type: 'sticky', text: 'Fewer meetings', frame: 'better' },
        { type: 'sticky', text: 'More tests', frame: 'better' },
      ],
    });
    const frames = placed.ids.map((id) => board.get(id)!).filter((e) => e.type === 'frame');
    expect(frames.map((f) => f.name)).toEqual(['Went well', 'To improve']);
    expect(board.childIds(frames[1]!.id)).toHaveLength(2);
    for (const id of board.childIds(frames[1]!.id)) {
      const el = board.get(id)!;
      expect(el.x).toBeGreaterThanOrEqual(frames[1]!.x);
      expect(el.x + el.w).toBeLessThanOrEqual(frames[1]!.x + frames[1]!.w);
    }
    expect(frames[0]!.x + frames[0]!.w).toBeLessThan(frames[1]!.x);
  });

  it('makes a mind map the editor can grow: nodes carry their root, lines are bound', () => {
    const board = Board.create();
    put(board, {
      mindmap: {
        text: 'Launch',
        children: [
          { text: 'Marketing', children: [{ text: 'Blog post' }, { text: 'Webinar' }] },
          { text: 'Sales' },
          { text: 'Support' },
          { text: 'Docs' },
        ],
      },
    });
    const nodes = [...board.elements.values()].filter((e) => e.mindmap);
    expect(nodes).toHaveLength(7);
    const root = nodes.find((n) => n.mindmap!.root === n.id)!;
    expect(root.text?.text).toBe('Launch');
    expect(nodes.every((n) => n.mindmap!.root === root.id)).toBe(true);
    // Four branches: two grow right of the root, two left.
    const branches = nodes.filter((n) => n.mindmap!.parent === root.id);
    expect(branches.filter((b) => b.x > root.x)).toHaveLength(2);
    expect(branches.filter((b) => b.x < root.x)).toHaveLength(2);
    expect([...board.elements.values()].filter((e) => e.type === 'connector')).toHaveLength(6);
  });

  it('goes right of what is on the board, or centred on a point', () => {
    const board = Board.create();
    applyOp(board, { type: 'create', elements: [makeSticky(0, 0, {}, { id: 'old', text: 'Old' })] });
    const right = put(board, { items: [{ type: 'text', text: 'Next to it' }] });
    expect(board.get(right.ids[0]!)!.x).toBeGreaterThan(200);
    const centred = put(board, { items: [{ type: 'sticky', text: 'Here' }] }, { x: 1000, y: 1000 });
    const el = board.get(centred.ids[0]!)!;
    expect(el.x + el.w / 2).toBe(1000);
  });

  it('clamps what it is given: counts, texts, colours, shapes and unknown references', () => {
    const spec = normalizeSpec({
      items: [
        ...Array.from({ length: SPEC_LIMITS.items + 10 }, () => ({ type: 'sticky' as const, text: 'x'.repeat(5000) })),
      ],
    });
    expect(spec.items).toHaveLength(SPEC_LIMITS.items);
    expect(spec.items![0]!.text).toHaveLength(SPEC_LIMITS.text);

    const odd = normalizeSpec({
      items: [
        { key: 'a', type: 'shape', text: 'A', shape: 'blob' as never, color: 'mauve' as never, frame: 'nowhere' },
        { key: 'a', type: 'sticky', text: 'B' },
        { type: 'widget' as never, text: 'C' },
      ],
      lines: [{ from: 'a', to: 'missing' }],
    });
    expect(odd.items).toHaveLength(2);
    expect(odd.items![0]).toEqual({ key: 'a', type: 'shape', text: 'A', shape: 'rounded' });
    expect(odd.items![1]!.key).not.toBe('a');
    expect(odd.lines).toBeUndefined();
    expect(fragmentFromSpec({}).fragment.elements).toEqual([]);
    expect(specSize({ mindmap: { text: 'a', children: [{ text: 'b' }] }, items: [{ type: 'sticky', text: 'c' }] })).toBe(4);
  });
});

describe('clustering', () => {
  it('moves the notes into one frame per theme, and leaves the rest alone', () => {
    const board = Board.create();
    const keys = keysBetween(null, null, 4);
    applyOp(board, {
      type: 'create',
      elements: [
        makeSticky(0, 0, { order: keys[0]! }, { id: 'a', text: 'Cheaper plans' }),
        makeSticky(220, 0, { order: keys[1]! }, { id: 'b', text: 'Faster support' }),
        makeSticky(440, 0, { order: keys[2]! }, { id: 'c', text: 'Price cut' }),
        makeFrame(0, 400, 300, 300, 'Kept', { order: keys[3]! }, { id: 'f' }),
      ],
    });
    const { op, frames } = clusterOps(
      board,
      [
        { title: 'Price', ids: ['a', 'c', 'gone'] },
        { title: 'Service', ids: ['b', 'a', 'f'] },
      ],
      { makeId },
    );
    expect(validateOp(board, op)).toBeNull();
    applyOp(board, op);
    expect(frames).toHaveLength(2);
    expect(board.get(frames[0]!)!.name).toBe('Price');
    expect(board.childIds(frames[0]!).sort()).toEqual(['a', 'c']);
    expect(board.childIds(frames[1]!)).toEqual(['b']);
    expect(board.get('f')!.parent).toBeUndefined();
    expect(board.get('a')!.text).toEqual(plain('Cheaper plans'));
  });
});

describe('editing elements by id', () => {
  it('replaces text, recolours, moves a frame with its contents and removes elements', () => {
    const board = Board.create();
    const keys = keysBetween(null, null, 4);
    applyOp(board, {
      type: 'create',
      elements: [
        makeFrame(0, 0, 600, 400, 'Ideas', { order: keys[0]! }, { id: 'f' }),
        makeSticky(40, 80, { order: keys[0]!, parent: 'f' }, { id: 'a', text: 'Old text' }),
        makeSticky(700, 0, { order: keys[1]! }, { id: 'b', text: 'Bye' }),
        { ...makeSticky(900, 0, { order: keys[2]! }, { id: 'l', text: 'Locked' }), locked: true },
      ],
    });
    const { op, changed, skipped } = editOps(board, [
      { id: 'a', text: 'New text', color: 'blue' },
      { id: 'f', text: 'Better ideas', x: 100, y: 50 },
      { id: 'b', delete: true },
      { id: 'l', text: 'Nope' },
      { id: 'gone', text: 'Nope' },
    ]);
    expect(validateOp(board, op)).toBeNull();
    applyOp(board, op);
    expect(changed.sort()).toEqual(['a', 'b', 'f']);
    expect(skipped.sort()).toEqual(['gone', 'l']);
    expect(board.get('a')!.text?.text).toBe('New text');
    expect(board.get('a')!.fill).toBe('#a6ccf5');
    expect(board.get('f')!.name).toBe('Better ideas');
    expect(board.get('f')!.x).toBe(100);
    // The note inside moved with its frame.
    expect(board.get('a')!.x).toBe(140);
    expect(board.get('a')!.y).toBe(130);
    expect(board.get('b')).toBeUndefined();
    expect(board.get('l')!.text?.text).toBe('Locked');
  });
});
