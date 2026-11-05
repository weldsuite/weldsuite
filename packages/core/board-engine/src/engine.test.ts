import type { ClientMessage, Outgoing, ServerMessage } from '@weldsuite/collab';
import { MetricsMeasurer } from '@weldsuite/docs-engine';
import { describe, expect, it } from 'vitest';
import { createBoardClient, createBoardRoom, type BoardPresence } from './collab/adapter';
import { displayToSvg } from './display/svg';
import { boardDisplay } from './display/display';
import { deleteOps, groupOps, moveOps, reparentOps, stackOps, ungroupOps } from './geometry/arrange';
import { elementBounds } from './geometry/bounds';
import { connectorGeometry, elbowRoute } from './geometry/connectors';
import { addMindMapChild, mindMapLayoutOps } from './geometry/mindmap';
import { SpatialIndex } from './geometry/spatial';
import { convertLegacyWhiteboard, legacyWriteOps, toLegacyElements } from './legacy/weldflow';
import { Board } from './model/board';
import { makeConnector, makeFrame, makeShape, makeSticky } from './model/defaults';
import { compareOrder, isOrderKey, keyBetween, keysBetween } from './model/order';
import { isElement } from './model/schema';
import { formatRich, insertRich, plain } from './model/text';
import { applyOp } from './ops/apply';
import { isWellFormedOp } from './ops/shape';
import { transform } from './ops/transform';
import type { Op } from './ops/types';
import { validateOp } from './ops/validate';
import { fragmentFromText, fragmentToText, makeFragment, placeFragment } from './serialize/fragment';
import { fromExcalidraw, parseCells, stickiesFromText } from './serialize/import';
import { isWellFormedSnapshot } from './serialize/snapshot';
import { boardToPlainText } from './serialize/text';
import { BUILT_IN_TEMPLATES } from './templates';
import { caretRect, layoutText, offsetAt } from './text/layout';
import { counterIds, randomOp, rng } from './test-support';

const measurer = new MetricsMeasurer();
const snap = (b: Board) => JSON.stringify(b.toSnapshot());

describe('order keys', () => {
  it('sort between their neighbours and stay short when appended to again and again', () => {
    let key: string | null = null;
    const keys: string[] = [];
    for (let i = 0; i < 5000; i++) {
      key = keyBetween(key, null);
      keys.push(key);
    }
    expect([...keys].sort()).toEqual(keys);
    expect(keys.at(-1)!.length).toBeLessThan(6);
    expect(keys.every(isOrderKey)).toBe(true);
    const between = keysBetween(keys[10]!, keys[11]!, 50);
    expect([...between].sort()).toEqual(between);
    expect(between.every((k) => k > keys[10]! && k < keys[11]!)).toBe(true);
    let lo = 'a0';
    let hi = 'a1';
    for (let i = 0; i < 200; i++) {
      const mid = keyBetween(lo, hi);
      expect(mid > lo && mid < hi).toBe(true);
      if (i % 2) lo = mid;
      else hi = mid;
    }
    expect(keyBetween(null, 'a0') < 'a0').toBe(true);
  });

  it('break ties by id', () => {
    expect(compareOrder({ order: 'a1', id: 'b' }, { order: 'a1', id: 'a' })).toBeGreaterThan(0);
  });
});

describe('rich text', () => {
  it('inserts, formats and undoes formatting exactly', () => {
    const t = insertRich(plain('hello world'), 5, { text: ',', marks: [[1, { b: true }]] });
    expect(t.text).toBe('hello, world');
    expect(t.marks).toEqual([[5, {}], [1, { b: true }], [6, {}]]);
    const { text: f, inverse } = formatRich(t, 0, [[3, { i: true }]]);
    const { text: back } = formatRich(f, 0, inverse);
    expect(back).toEqual(t);
  });
});

describe('ops', () => {
  it('apply returns the exact inverse for random ops', () => {
    for (let seed = 1; seed <= 30; seed++) {
      const random = rng(seed);
      const ids = counterIds(`s${seed}_`);
      const board = Board.create();
      for (let step = 0; step < 150; step++) {
        const op = randomOp(board, random, ids);
        if (!op) continue;
        expect(isWellFormedOp(JSON.parse(JSON.stringify(op)))).toBe(true);
        expect(validateOp(board, op)).toBeNull();
        const before = snap(board);
        const inverse = applyOp(board, op);
        const after = snap(board);
        applyOp(board, inverse);
        expect(snap(board)).toBe(before);
        applyOp(board, op);
        expect(snap(board)).toBe(after);
      }
    }
  });

  it('refuses malformed and invalid ops', () => {
    expect(isWellFormedOp({ type: 'set', id: 'a', patch: { x: 'one' } })).toBe(false);
    expect(isWellFormedOp({ type: 'set', id: 'a', patch: { type: 'frame' } })).toBe(false);
    expect(isWellFormedOp({ type: 'set', id: 'a', patch: { x: null } })).toBe(false);
    expect(isWellFormedOp({ type: 'create', elements: [{ id: 'x', type: 'sticky', order: 'a0', x: 0, y: 0, w: 1, h: 1, points: [1] }] })).toBe(false);
    expect(isWellFormedOp({ type: 'set', id: 'a', patch: { link: 'javascript:alert(1)' } })).toBe(false);
    expect(isWellFormedOp({ type: 'nope' })).toBe(false);
    const board = Board.create();
    applyOp(board, { type: 'create', elements: [makeFrame(0, 0, 100, 100, 'F', {}, { id: 'f' }), makeSticky(10, 10, { parent: 'f' }, { id: 's' })] });
    expect(validateOp(board, { type: 'create', elements: [makeSticky(0, 0, {}, { id: 's' })] })).not.toBeNull();
    expect(validateOp(board, { type: 'set', id: 'f', patch: { parent: 's' } })).toMatch(/inside/);
    applyOp(board, { type: 'create', elements: [makeFrame(0, 0, 50, 50, 'G', { parent: 'f' }, { id: 'g' })] });
    expect(validateOp(board, { type: 'set', id: 'f', patch: { parent: 'g' } })).toMatch(/inside/);
    expect(validateOp(board, { type: 'insertText', id: 's', at: 99, text: plain('x') })).toMatch(/range/);
    expect(validateOp(board, { type: 'set', id: 's', patch: { shape: 'ellipse' } })).toMatch(/has no/);
    // An edit of an element that is gone is fine: it does nothing.
    expect(validateOp(board, { type: 'set', id: 'gone', patch: { x: 1 } })).toBeNull();
  });

  it('merges concurrent typing in one sticky by character', () => {
    const board = Board.create();
    applyOp(board, { type: 'create', elements: [makeSticky(0, 0, {}, { id: 's', text: 'abc' })] });
    const a: Op = { type: 'insertText', id: 's', at: 1, text: plain('X') };
    const b: Op = { type: 'insertText', id: 's', at: 2, text: plain('Y') };
    applyOp(board, b);
    applyOp(board, transform(a, b, true));
    expect(board.get('s')!.text!.text).toBe('aXbYc');
    // Text typed inside a range someone deletes survives.
    const del: Op = { type: 'deleteText', id: 's', from: 0, to: 5 };
    const ins: Op = { type: 'insertText', id: 's', at: 2, text: plain('keep') };
    applyOp(board, ins);
    applyOp(board, transform(del, ins, true));
    expect(board.get('s')!.text!.text).toBe('keep');
  });

  it('keeps both people’s changes to different properties', () => {
    const a: Op = { type: 'set', id: 's', patch: { x: 5, fill: '#fff' } };
    const b: Op = { type: 'set', id: 's', patch: { y: 9, fill: '#000' } };
    expect(transform(a, b, false)).toEqual({ type: 'set', id: 's', patch: { x: 5 } });
    expect(transform(a, b, true)).toEqual(a);
    expect(transform(a, { type: 'delete', ids: ['s'] }, true)).toEqual({ type: 'batch', ops: [] });
  });
});

type Room = ReturnType<typeof createBoardRoom>;
type Client = ReturnType<typeof createBoardClient>;

function simulate(seed: number, clients: number, steps: number): { room: Room; clients: Client[]; rejects: number } {
  const random = rng(seed);
  const makeId = counterIds(`x${seed}_`);
  const start = Board.create();
  applyOp(start, { type: 'create', elements: [makeFrame(0, 0, 1000, 800, 'Start', {}, { id: 'f0' }), makeSticky(50, 50, { parent: 'f0' }, { id: 's0', text: 'hello' })] });
  const room = createBoardRoom(start.toSnapshot(), 0);
  const toRoom: { from: string; msg: ClientMessage<Op, BoardPresence> }[] = [];
  const toClient = new Map<string, ServerMessage<Op, unknown, BoardPresence>[]>();
  let rejects = 0;
  const list: Client[] = [];
  for (let i = 0; i < clients; i++) {
    const id = `c${i}`;
    toClient.set(id, []);
    room.join({ clientId: id, userId: `u${i}`, name: `User ${i}`, color: '#000000', canEdit: true });
    const client = createBoardClient({ sessionId: `s${i}`, send: (msg) => toRoom.push({ from: id, msg: JSON.parse(JSON.stringify(msg)) }) });
    list.push(client);
    client.start();
  }
  const route = (out: Outgoing<Op, unknown, BoardPresence>[]) => {
    for (const o of out) {
      if (o.msg.type === 'reject') rejects++;
      const copy = JSON.parse(JSON.stringify(o.msg)) as ServerMessage<Op, unknown, BoardPresence>;
      if (o.to) toClient.get(o.to)!.push(copy);
      else for (const [id, q] of toClient) if (id !== o.except && room.isReady(id)) q.push(copy);
    }
  };
  const deliverRoom = () => {
    const m = toRoom.shift();
    if (m) route(room.receive(m.from, m.msg));
  };
  const deliverClient = (i: number) => {
    const m = toClient.get(`c${i}`)!.shift();
    if (m) list[i]!.receive(m as never);
  };
  for (let step = 0; step < steps; step++) {
    const r = random();
    const i = Math.floor(random() * clients);
    const client = list[i]!;
    if (r < 0.45 && client.state) {
      const op = randomOp(client.state, random, makeId);
      if (op) client.apply(op);
    } else if (r < 0.75) deliverRoom();
    else deliverClient(i);
  }
  for (let guard = 0; guard < 100_000 && (toRoom.length || [...toClient.values()].some((q) => q.length)); guard++) {
    deliverRoom();
    for (let i = 0; i < clients; i++) while (toClient.get(`c${i}`)!.length) deliverClient(i);
  }
  return { room, clients: list, rejects };
}

describe('BoardRoom simulation', () => {
  it('converges with no refused batches across many random sessions', () => {
    // BOARD_FUZZ_SEEDS raises the count for a longer local run.
    const env = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env ?? {};
    const seeds = Number(env.BOARD_FUZZ_SEEDS ?? 40);
    for (let seed = 1; seed <= seeds; seed++) {
      const { room, clients, rejects } = simulate(seed, 4, 500);
      const expected = snap(room.state);
      for (const c of clients) expect(snap(c.state!)).toBe(expected);
      expect(rejects).toBe(0);
      expect(isWellFormedSnapshot(room.state.toSnapshot())).toBe(true);
    }
  });
});

describe('geometry', () => {
  it('routes an elbow connector around both shapes', () => {
    const board = Board.create();
    const a = makeShape('rectangle', 0, 0, 100, 100, {}, { id: 'a' });
    const b = makeShape('rectangle', 300, 0, 100, 100, {}, { id: 'b' });
    applyOp(board, { type: 'create', elements: [a, b] });
    // Out of a's left side and into b's right side: the route has to go around.
    const conn = makeConnector({ x: 0, y: 50, el: 'a', side: 'left' }, { x: 400, y: 50, el: 'b', side: 'right' }, {}, { id: 'c' });
    applyOp(board, { type: 'create', elements: [conn] });
    const g = connectorGeometry(board, board.get('c')!);
    expect(g.points[0]).toEqual({ x: 0, y: 50 });
    expect(g.points.at(-1)).toEqual({ x: 400, y: 50 });
    for (let i = 1; i < g.points.length; i++) {
      const p = g.points[i - 1]!;
      const q = g.points[i]!;
      expect(p.x === q.x || p.y === q.y).toBe(true);
      // No segment runs through the middle of either box.
      const midX = (p.x + q.x) / 2;
      const midY = (p.y + q.y) / 2;
      for (const box of [a, b]) expect(midX > box.x + 1 && midX < box.x + box.w - 1 && midY > box.y + 1 && midY < box.y + box.h - 1).toBe(false);
    }
    expect(elbowRoute({ p: { x: 0, y: 0 }, dir: null, box: null }, { p: { x: 10, y: 10 }, dir: null, box: null }).length).toBeGreaterThan(1);
  });

  it('finds the topmost element under the pointer and indexes moves', () => {
    const board = Board.create();
    applyOp(board, { type: 'create', elements: [makeSticky(0, 0, {}, { id: 'low' }), makeSticky(50, 50, { after: 'a0' }, { id: 'high' })] });
    const index = new SpatialIndex(board);
    index.rebuild();
    expect(index.hit({ x: 100, y: 100 }, 2)?.id).toBe('high');
    applyOp(board, { type: 'set', id: 'high', patch: { x: 5000 } });
    index.sync(board.takeDirty());
    expect(index.hit({ x: 100, y: 100 }, 2)?.id).toBe('low');
    expect(index.inRect({ x: 4900, y: 0, w: 400, h: 400 }).map((e) => e.id)).toEqual(['high']);
  });

  it('moves frames with their contents, groups, stacks and reparents', () => {
    const board = Board.create();
    applyOp(board, { type: 'create', elements: [makeFrame(0, 0, 500, 500, 'F', {}, { id: 'f' }), makeSticky(10, 10, { parent: 'f' }, { id: 's' }), makeSticky(800, 10, {}, { id: 't' })] });
    applyOp(board, moveOps(board, ['f'], 100, 0));
    expect(board.get('s')!.x).toBe(110);
    applyOp(board, { type: 'set', id: 't', patch: { x: 150, y: 100 } });
    applyOp(board, reparentOps(board, ['t']));
    expect(board.get('t')!.parent).toBe('f');
    applyOp(board, groupOps(board, ['s', 't'], 'g'));
    expect(board.get('s')!.parent).toBe('g');
    applyOp(board, stackOps(board, ['g'], 'back'));
    applyOp(board, ungroupOps(board, 'g'));
    expect(board.get('g')).toBeUndefined();
    expect(board.get('s')!.parent).toBe('f');
    applyOp(board, deleteOps(board, ['f']));
    expect(board.size).toBe(0);
  });

  it('lays out a mind map', () => {
    const board = Board.create();
    const root = makeShape('rounded', 0, 0, 200, 80, {}, { id: 'r' });
    root.mindmap = { root: 'r' };
    applyOp(board, { type: 'create', elements: [root] });
    applyOp(board, addMindMapChild(board, 'r', { node: 'n1', line: 'l1' }));
    applyOp(board, addMindMapChild(board, 'r', { node: 'n2', line: 'l2' }));
    applyOp(board, mindMapLayoutOps(board, 'r'));
    const n1 = board.get('n1')!;
    const n2 = board.get('n2')!;
    expect(n1.x).toBe(root.x + root.w + 80);
    expect(Math.abs(n1.y - n2.y)).toBeGreaterThanOrEqual(n1.h);
  });
});

describe('text layout', () => {
  it('wraps lines and maps positions to carets and back', () => {
    const style = { fontFamily: 'Helvetica', fontSize: 16, color: '#000', align: 'left' as const };
    const layout = layoutText(plain('The quick brown fox jumps over the lazy dog'), style, 100, measurer);
    expect(layout.lines.length).toBeGreaterThan(2);
    const caret = caretRect(layout, 10);
    expect(offsetAt(layout, caret.x, caret.y + 2)).toBe(10);
    expect(layoutText(plain('a\nb'), style, 100, measurer).lines.length).toBe(2);
  });
});

describe('legacy WeldFlow whiteboards', () => {
  const legacy = [
    { id: '1', type: 'rectangle', x: 0, y: 0, width: 100, height: 60, color: '#ffffff', strokeColor: '#000000', borderRadius: 6 },
    { id: '2', type: 'circle', x: 300, y: 50, radiusX: 40, radiusY: 30, color: 'transparent' },
    { id: '3', type: 'sticky', x: 0, y: 200, width: 200, height: 200, text: 'Hello', color: '#fff9b1' },
    { id: '4', type: 'text', x: 400, y: 300, text: 'Title', fontSize: 24, fontWeight: 'bold', textAlign: 'center', color: '#111111' },
    { id: '5', type: 'arrow', x: 100, y: 30, endX: 260, endY: 50, arrowType: 'elbow', startElementId: '1', startConnectionPoint: 'right', endElementId: '2', endConnectionPoint: 'left' },
    {
      id: '6',
      type: 'path',
      x: 0,
      y: 0,
      points: Array.from({ length: 21 }, (_, i) => ({ x: i * 10, y: 500 })),
      strokeColor: '#ff0000',
      strokeWidth: 3,
      erasedPaths: [{ points: [{ x: 100, y: 500 }], size: 30 }],
    },
    { id: 'bad id!', type: 'sticky', x: 900, y: 900, text: 'x' },
    { type: 'unknown' },
  ];

  it('converts every old element type, splitting erased strokes', () => {
    const snapshot = convertLegacyWhiteboard(legacy);
    expect(isWellFormedSnapshot(snapshot)).toBe(true);
    const board = Board.fromSnapshot(snapshot);
    expect(board.get('2')).toMatchObject({ type: 'shape', shape: 'ellipse', x: 260, y: 20, w: 80, h: 60 });
    expect(board.get('4')).toMatchObject({ type: 'text', textAlign: 'center' });
    expect(board.get('4')!.text!.marks).toEqual([[5, { b: true }]]);
    expect(board.get('5')).toMatchObject({ type: 'connector', route: 'elbow', start: { el: '1', side: 'right' }, end: { el: '2', side: 'left' } });
    expect([...board.elements.values()].filter((e) => e.type === 'pen').length).toBe(2);
    expect([...board.elements.values()].some((e) => e.type === 'sticky' && e.text?.text === 'x')).toBe(true);
  });

  it('exports the legacy shape and turns an unchanged write into nothing', () => {
    const board = Board.fromSnapshot(convertLegacyWhiteboard(legacy));
    const exported = toLegacyElements(board);
    expect(exported.find((e) => e.id === '2')).toMatchObject({ type: 'circle', x: 300, y: 50, radiusX: 40 });
    expect(legacyWriteOps(board, JSON.parse(JSON.stringify(exported)))).toEqual({ type: 'batch', ops: [] });
    const moved = exported.map((e) => (e.id === '3' ? { ...e, x: 50, text: 'Changed' } : e)).filter((e) => e.id !== '1');
    const op = legacyWriteOps(board, moved);
    expect(validateOp(board, op)).toBeNull();
    applyOp(board, op);
    expect(board.get('3')).toMatchObject({ x: 50, text: { text: 'Changed' } });
    expect(board.get('1')).toBeUndefined();
  });
});

describe('fragments, imports, templates, export', () => {
  it('copies and pastes with fresh ids, keeping connectors and frames together', () => {
    const board = Board.create();
    applyOp(board, {
      type: 'create',
      elements: [
        makeFrame(0, 0, 500, 500, 'F', {}, { id: 'f' }),
        makeSticky(10, 10, { parent: 'f' }, { id: 'a' }),
        makeSticky(250, 10, { parent: 'f' }, { id: 'b' }),
        makeConnector({ x: 0, y: 0, el: 'a', side: 'right' }, { x: 0, y: 0, el: 'b', side: 'left' }, { parent: 'f' }, { id: 'c' }),
      ],
    });
    const text = fragmentToText(makeFragment(board, ['f']));
    const fragment = fragmentFromText(text)!;
    const { op, ids } = placeFragment(board, fragment, { x: 1000, y: 0, makeId: counterIds('p') });
    expect(validateOp(board, op)).toBeNull();
    applyOp(board, op);
    expect(board.size).toBe(8);
    const frame = board.get(ids[0]!)!;
    expect(frame.x).toBe(1000);
    const conn = [...board.elements.values()].find((e) => e.type === 'connector' && e.parent === frame.id)!;
    expect(board.get(conn.start!.el!)!.parent).toBe(frame.id);
  });

  it('imports Excalidraw scenes and CSV as stickies', () => {
    const { fragment, skipped } = fromExcalidraw(
      {
        elements: [
          { id: 'r', type: 'rectangle', x: 10, y: 10, width: 100, height: 50, strokeColor: '#1e1e1e', backgroundColor: 'transparent' },
          { id: 't', type: 'text', x: 0, y: 0, width: 50, height: 20, text: 'in box', containerId: 'r' },
          { id: 'a', type: 'arrow', x: 110, y: 35, width: 100, height: 0, points: [[0, 0], [100, 0]], startBinding: { elementId: 'r' } },
          { id: 'i', type: 'image', x: 0, y: 0, width: 1, height: 1 },
        ],
      },
      counterIds('x'),
    );
    expect(skipped).toBe(1);
    expect(fragment.elements.every(isElement)).toBe(true);
    expect(fragment.elements.find((e) => e.type === 'shape')!.text!.text).toBe('in box');
    expect(parseCells('a,"b, c"\n1;2')).toEqual([['a', 'b, c'], ['1;2']]);
    expect(stickiesFromText('one\ntwo\nthree', counterIds('s')).elements.length).toBe(3);
  });

  it('builds every template as valid elements', () => {
    for (const t of BUILT_IN_TEMPLATES) {
      const f = t.build({ makeId: counterIds(`${t.id}-`), label: (_k, en) => en });
      expect(f.elements.length).toBeGreaterThan(0);
      for (const el of f.elements) expect(isElement(el)).toBe(true);
      const board = Board.create();
      const { op } = placeFragment(board, f, { x: 0, y: 0, makeId: counterIds('n') });
      expect(validateOp(board, op)).toBeNull();
    }
  });

  it('exports SVG and plain text', () => {
    const board = Board.create();
    applyOp(board, { type: 'create', elements: [makeFrame(0, 0, 600, 400, 'Ideas & <plans>', {}, { id: 'f' }), makeSticky(20, 20, { parent: 'f' }, { id: 's', text: 'Ship it' })] });
    const items = boardDisplay(board, { measurer });
    const svg = displayToSvg(items, { view: elementBounds(board, board.get('f')!) });
    expect(svg.startsWith('<svg')).toBe(true);
    expect(svg).toContain('Ideas &amp; &lt;plans&gt;');
    expect(boardToPlainText(board)).toContain('Ship it');
  });
});
