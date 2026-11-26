import { describe, expect, it } from 'vitest';
import {
  Board,
  MAX_ELEMENTS,
  NOOP,
  applyOp,
  emptySnapshot,
  makeCard,
  makeConnector,
  makeFrame,
  makeShape,
  makeSticky,
  makeText,
  unbatch,
  validateOp,
  type BoardElement,
  type BoardSnapshot,
  type Op,
} from '@weldsuite/board-engine';
import type { BoardAiInput } from '@weldsuite/app-api-client/schemas/boards';
import { TASKABLE, boardEngine, boardEngineNamespace, gzipCheckpoint, taskFields } from './engine-ops';

const NOW = 1_700_000_000_000;

const byId = (a: BoardElement, b: BoardElement) => (a.id < b.id ? -1 : 1);

/** A snapshot holding these elements, sorted by id as a snapshot keeps them. */
const snapshotOf = (...elements: BoardElement[]): BoardSnapshot => ({ ...emptySnapshot(), elements: [...elements].sort(byId) });

/** The live board as the JSON text the room hands over. */
const live = (...elements: BoardElement[]) => JSON.stringify(snapshotOf(...elements));

const boardOf = (json: string) => Board.fromSnapshot(JSON.parse(json) as BoardSnapshot);

const note = (id: string, text: string, extra: Partial<BoardElement> = {}): BoardElement => ({ ...makeSticky(0, 0, { createdBy: 'alice' }, { id, text }), ...extra });

/** A checkpoint's bytes read back: gunzipped JSON. */
async function unzip(bytes: Uint8Array): Promise<{ revision: number; board: BoardSnapshot }> {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
  return JSON.parse(await new Response(stream).text()) as { revision: number; board: BoardSnapshot };
}

/** The board a checkpoint result holds, checked to be at revision 0. */
async function boardIn(result: { ok: true; checkpoint: Uint8Array } | { ok: false }): Promise<BoardSnapshot> {
  if (!result.ok) throw new Error('expected a checkpoint');
  const { revision, board } = await unzip(result.checkpoint);
  expect(revision).toBe(0);
  return board;
}

/** The elements an op creates, inside a batch too. */
const created = (op: Op | null) => (op ? unbatch(op).flatMap((o) => (o.type === 'create' ? o.elements : [])) : []);

const input = (action: BoardAiInput['action'], extra: Partial<BoardAiInput> = {}): BoardAiInput => ({ action, ...extra });

/** A frame with a two-line note in it, a loose note, a locked note, an empty note, a card, a wide shape, a text and a line. */
function workshop(): string {
  return live(
    makeFrame(0, 0, 800, 600, 'Ideas', {}, { id: 'frame' }),
    { ...note('n_spec', 'Write spec\nWith examples', { parent: 'frame' }), x: 100, y: 200, order: 'a3' },
    note('n_ship', 'Ship it'),
    note('n_locked', 'Frozen', { locked: true }),
    note('n_empty', '   '),
    makeCard(900, 0, 'Billing page', {}, { id: 'card', description: 'Rework' }),
    makeShape('rectangle', 900, 300, 600, 100, {}, { id: 'wide', text: 'Decide' }),
    makeText(0, 700, 'A heading', {}, { id: 'text' }),
    makeConnector({ x: 0, y: 0 }, { x: 10, y: 10 }, {}, { id: 'line' }),
  );
}

describe('gzipCheckpoint', () => {
  it('stores the board at revision 0, gzipped', async () => {
    const board = snapshotOf(note('n1', 'Hello'));
    const bytes = await gzipCheckpoint(board);
    expect([bytes[0], bytes[1]]).toEqual([0x1f, 0x8b]);
    expect(await unzip(bytes)).toEqual({ revision: 0, board });
  });
});

describe('newBoard', () => {
  it('starts empty when no snapshot was sent', async () => {
    expect(await boardIn(await boardEngine.newBoard())).toEqual(emptySnapshot());
    expect(await boardIn(await boardEngine.newBoard(null))).toEqual(emptySnapshot());
  });

  it('takes a well-formed snapshot, made canonical', async () => {
    const sent = { elements: [note('n_b', 'Second'), note('n_a', 'First')], props: { background: '#fafafa' }, version: 1 };
    const board = await boardIn(await boardEngine.newBoard(JSON.stringify(sent)));
    expect(board.elements.map((e) => e.id)).toEqual(['n_a', 'n_b']);
    expect(board.props).toEqual({ background: '#fafafa' });
    expect(board).toEqual(Board.fromSnapshot(sent).toSnapshot());
    expect(Object.keys(board)).toEqual(['version', 'props', 'elements']);
  });

  it('refuses what is not a board snapshot', async () => {
    const sticky = note('n1', 'x');
    const broken = [
      'null',
      '42',
      '"a board"',
      '[]',
      '{}',
      JSON.stringify({ ...snapshotOf(sticky), version: 2 }),
      JSON.stringify({ ...emptySnapshot(), elements: [sticky, sticky] }),
      JSON.stringify({ ...emptySnapshot(), elements: [{ ...sticky, type: 'hologram' }] }),
      JSON.stringify({ ...emptySnapshot(), elements: [{ ...sticky, colour: 'red' }] }),
      JSON.stringify({ ...emptySnapshot(), votes: { alice: [42] } }),
    ];
    for (const sent of broken) expect(await boardEngine.newBoard(sent)).toEqual({ ok: false });
  });

  it('refuses a snapshot with more elements than a board holds', async () => {
    const elements = Array.from({ length: MAX_ELEMENTS + 1 }, (_, i) => ({ id: `e${i}`, type: 'shape', order: 'a0', x: 0, y: 0, w: 1, h: 1 }));
    expect(await boardEngine.newBoard(JSON.stringify({ ...emptySnapshot(), elements }))).toEqual({ ok: false });
  });
});

describe('copyBoard', () => {
  it('copies the content, leaving comment pins and the session behind', async () => {
    const source = {
      version: 1,
      props: { background: '#eef', grid: 'lines', locked: true, timer: { duration: 60_000 }, voting: { id: 'v1' }, privateMode: true },
      elements: [
        { id: 'c_pin', type: 'comment', order: 'a5', x: 10, y: 10, w: 32, h: 32, createdBy: 'bob', thread: 't_1' },
        note('n1', 'Keep me'),
      ],
      votes: { alice: ['n1'] },
    };
    const board = await boardIn(await boardEngine.copyBoard(JSON.stringify(source)));
    expect(board).toEqual({ version: 1, props: { background: '#eef', grid: 'lines', locked: true }, elements: [note('n1', 'Keep me')] });
  });
});

describe('importBoard', () => {
  it('reads text lines as sticky notes, with fresh ids', async () => {
    const result = await boardEngine.importBoard('text', 'Alpha\nBeta\n\nGamma\n');
    expect(result).toMatchObject({ ok: true, skipped: 0 });
    const board = await boardIn(result);
    expect(board.elements.map((e) => e.type)).toEqual(['sticky', 'sticky', 'sticky']);
    expect(board.elements.map((e) => e.text?.text).sort()).toEqual(['Alpha', 'Beta', 'Gamma']);
    for (const el of board.elements) expect(el.id).toMatch(/^el_[a-z0-9]+$/);
  });

  it('reads CSV with one column of notes per CSV column', async () => {
    const board = await boardIn(await boardEngine.importBoard('csv', 'a,b\nc,d'));
    const at = Object.fromEntries(board.elements.map((e) => [e.text!.text, { x: e.x, y: e.y }]));
    expect(Object.keys(at).sort()).toEqual(['a', 'b', 'c', 'd']);
    expect(at.a!.x).toBe(at.c!.x);
    expect(at.b!.x).toBe(at.d!.x);
    expect(at.b!.x).toBeGreaterThan(at.a!.x);
    expect(at.a!.y).toBe(at.b!.y);
    expect(at.c!.y).toBeGreaterThan(at.a!.y);
  });

  it('reads an Excalidraw scene and counts what could not come across', async () => {
    const scene = {
      elements: [
        { id: 'r1', type: 'rectangle', x: 10, y: 20, width: 100, height: 50 },
        { id: 'img', type: 'image', x: 0, y: 0, width: 10, height: 10 },
        { id: 'gone', type: 'rectangle', x: 0, y: 0, width: 10, height: 10, isDeleted: true },
      ],
    };
    const result = await boardEngine.importBoard('excalidraw', JSON.stringify(scene));
    expect(result).toMatchObject({ ok: true, skipped: 1 });
    const board = await boardIn(result);
    expect(board.elements).toHaveLength(1);
    expect(board.elements[0]).toMatchObject({ type: 'shape', w: 100, h: 50 });
  });

  it('refuses an Excalidraw file that is not JSON', async () => {
    expect(await boardEngine.importBoard('excalidraw', '{ not json')).toEqual({ ok: false });
  });

  it('takes a WeldBoard export, wrapped or bare, and refuses a broken one', async () => {
    const snapshot = snapshotOf(note('n_b', 'B'), note('n_a', 'A'));
    for (const content of [JSON.stringify({ kind: 'weldboard', snapshot }), JSON.stringify(snapshot)]) {
      const result = await boardEngine.importBoard('weldboard', content);
      expect(result).toMatchObject({ ok: true, skipped: 0 });
      expect(await boardIn(result)).toEqual(Board.fromSnapshot(snapshot).toSnapshot());
    }
    expect(await boardEngine.importBoard('weldboard', JSON.stringify({ kind: 'weldboard', snapshot: {} }))).toEqual({ ok: false });
    expect(await boardEngine.importBoard('weldboard', 'not json')).toEqual({ ok: false });
  });
});

describe('convertLegacy', () => {
  it('makes an empty board of a whiteboard without elements', async () => {
    for (const elements of [null, 'null', '{"not":"a list"}', '[]']) {
      expect(await boardIn(await boardEngine.convertLegacy(elements, 'bob'))).toEqual({ version: 1, props: {}, elements: [] });
    }
  });

  it('converts the old elements, credited to whoever last edited them', async () => {
    const old = [
      { id: 's1', type: 'sticky', x: 10, y: 20, width: 150, text: 'Hi', color: '#fef08a' },
      { id: 'r1', type: 'rectangle', x: 0, y: 0, width: 50, height: 40 },
    ];
    const board = await boardIn(await boardEngine.convertLegacy(JSON.stringify(old), 'bob'));
    expect(board.elements.map((e) => e.id)).toEqual(['r1', 's1']);
    expect(board.elements[0]).toMatchObject({ type: 'shape', shape: 'rectangle', x: 0, y: 0, w: 50, h: 40, createdBy: 'bob' });
    expect(board.elements[1]).toMatchObject({ type: 'sticky', x: 10, y: 20, w: 150, h: 150, fill: '#fef08a', text: { text: 'Hi' }, createdBy: 'bob' });

    const anonymous = await boardIn(await boardEngine.convertLegacy(JSON.stringify(old), null));
    expect(anonymous.elements.some((e) => 'createdBy' in e)).toBe(false);
  });
});

describe('taskFields', () => {
  it('takes the first line as the title and the rest as the description', () => {
    expect(taskFields(note('n', '  Write spec \n\nWith examples\n  and tests  '))).toEqual({ title: 'Write spec', description: 'With examples\n  and tests' });
    expect(taskFields(note('n', 'Ship it'))).toEqual({ title: 'Ship it' });
  });

  it('falls back to the title of an element without text', () => {
    const link: BoardElement = { id: 'l', type: 'link', order: 'a0', x: 0, y: 0, w: 10, h: 10, title: 'Pricing page' };
    expect(taskFields(link)).toEqual({ title: 'Pricing page' });
  });

  it('has nothing for an element without text', () => {
    expect(taskFields(note('n', ''))).toBeNull();
    expect(taskFields(note('n', ' \n\t '))).toBeNull();
    expect(taskFields(makeConnector({ x: 0, y: 0 }, { x: 1, y: 1 }))).toBeNull();
  });

  it('cuts the title to 500 characters and the description to 10,000', () => {
    const fields = taskFields(note('n', `${'t'.repeat(600)}\n${'d'.repeat(12_000)}`))!;
    expect(fields.title).toHaveLength(500);
    expect(fields.description).toHaveLength(10_000);
  });
});

describe('TASKABLE', () => {
  it('is the element types with text that can become tasks', () => {
    expect([...TASKABLE].sort()).toEqual(['card', 'shape', 'sticky', 'text']);
  });
});

describe('taskPlan', () => {
  it('lists the elements that become tasks once each, in the order asked', () => {
    const ids = ['n_ship', 'n_spec', 'n_ship', 'frame', 'n_locked', 'n_empty', 'missing', 'line', 'card', 'wide', 'text'];
    expect(boardEngine.taskPlan(workshop(), ids)).toEqual([
      { elementId: 'n_ship', title: 'Ship it' },
      { elementId: 'n_spec', title: 'Write spec', description: 'With examples' },
      { elementId: 'card', title: 'Billing page' },
      { elementId: 'wide', title: 'Decide' },
      { elementId: 'text', title: 'A heading' },
    ]);
    expect(boardEngine.taskPlan(workshop(), [])).toEqual([]);
  });
});

describe('taskCards', () => {
  it('puts a task card where each element was, and removes the element', () => {
    const json = workshop();
    const before = boardOf(json);
    const created = [
      { elementId: 'n_spec', taskId: 'tsk_1' },
      { elementId: 'missing', taskId: 'tsk_2' },
      { elementId: 'card', taskId: 'tsk_3' },
      { elementId: 'wide', taskId: 'tsk_4' },
    ];
    const { op } = boardEngine.taskCards(json, created, 'alice', NOW);
    if (op.type !== 'batch') throw new Error('expected a batch');
    expect(op.ops.map((o) => o.type)).toEqual(['create', 'delete', 'create', 'delete', 'create', 'delete']);
    expect(op.ops.filter((o) => o.type === 'delete')).toEqual([
      { type: 'delete', ids: ['n_spec'] },
      { type: 'delete', ids: ['card'] },
      { type: 'delete', ids: ['wide'] },
    ]);

    const cards = op.ops.flatMap((o) => (o.type === 'create' ? o.elements : []));
    expect(cards.map((c) => c.record)).toEqual([
      { kind: 'task', id: 'tsk_1' },
      { kind: 'task', id: 'tsk_3' },
      { kind: 'task', id: 'tsk_4' },
    ]);
    // Width kept between 240 and 400: a 200 note, a 300 card, a 600 shape.
    expect(cards.map((c) => c.w)).toEqual([240, 300, 400]);
    for (const [i, id] of ['n_spec', 'card', 'wide'].entries()) {
      const el = before.get(id)!;
      expect(cards[i]).toMatchObject({ type: 'record', x: el.x, y: el.y, h: 96, order: el.order, createdBy: 'alice', createdAt: NOW });
      expect(cards[i]!.id).not.toBe(id);
    }
    expect(cards[0]!.parent).toBe('frame');
    expect('parent' in cards[1]!).toBe(false);
    expect(new Set(cards.map((c) => c.id)).size).toBe(3);

    expect(validateOp(before, op)).toBeNull();
    applyOp(before, op);
    expect(['n_spec', 'card', 'wide'].map((id) => before.get(id))).toEqual([undefined, undefined, undefined]);
    expect(cards.every((c) => before.get(c.id)?.type === 'record')).toBe(true);
  });

  it('is an empty batch when no task was made', () => {
    expect(boardEngine.taskCards(workshop(), [], 'alice', NOW)).toEqual({ op: { type: 'batch', ops: [] } });
  });
});

describe('render', () => {
  it('draws an empty board as an 800 by 600 view', () => {
    const { svg, elements, drawn } = boardEngine.render(live(), 400);
    expect({ elements, drawn }).toEqual({ elements: 0, drawn: 0 });
    // The view padded by 48 on each side: 896 × 696 drawn 400 wide.
    expect(svg).toMatch(/^<svg [^>]*width="400" height="311" viewBox="-48 -48 896 696"/);
    expect(svg).toContain('fill="#ffffff"');
    expect(svg.endsWith('</svg>')).toBe(true);
  });

  it('frames the drawing to the board’s content', () => {
    const { svg, elements, drawn } = boardEngine.render(live({ ...note('n1', 'Hello there'), x: 100, y: 50 }), 1000);
    expect({ elements, drawn }).toEqual({ elements: 1, drawn: 1 });
    expect(svg).toMatch(/^<svg [^>]*width="1000" height="1000" viewBox="52 2 296 296"/);
    expect(svg).toContain('Hello');
  });

  it('draws the first 5000 elements of a bigger board, and counts them all', () => {
    const shapes = Array.from({ length: 5001 }, (_, i) => makeShape('rectangle', i * 10, 0, 8, 8, {}, { id: `s${String(i).padStart(5, '0')}` }));
    const { elements, drawn } = boardEngine.render(live(...shapes), 800);
    expect({ elements, drawn }).toEqual({ elements: 5001, drawn: 5000 });
  });
});

describe('legacyElements', () => {
  it('reads the board as WeldFlow elements, leaving out types WeldFlow did not have', () => {
    const json = live(
      { ...note('s', 'Hi'), x: 10, y: 20 },
      makeShape('ellipse', 0, 0, 100, 50, {}, { id: 'c', fill: '#fee2e2' }),
      makeFrame(0, 0, 400, 400, 'Frame', {}, { id: 'f' }),
      makeCard(500, 0, 'Card', {}, { id: 'card' }),
    );
    const out = boardEngine.legacyElements(json) as { id: string }[];
    expect(out.map((e) => e.id).sort()).toEqual(['c', 's']);
    expect(out.find((e) => e.id === 's')).toEqual({ id: 's', type: 'sticky', x: 10, y: 20, width: 200, height: 200, text: 'Hi', color: note('s', '').fill, fontSize: 22 });
    expect(out.find((e) => e.id === 'c')).toMatchObject({ type: 'circle', x: 50, y: 25, radiusX: 50, radiusY: 25, color: '#fee2e2' });
  });
});

describe('legacyWrite', () => {
  const board = () =>
    live(
      note('s', 'Hi'),
      makeShape('ellipse', 0, 0, 100, 50, {}, { id: 'c' }),
      makeFrame(0, 0, 400, 400, 'Frame', {}, { id: 'f' }),
    );

  it('changes nothing when the caller sends back what it read', () => {
    const json = board();
    expect(boardEngine.legacyWrite(json, boardEngine.legacyElements(json))).toEqual({ op: null });
  });

  it('turns changed, new and left-out elements into ops, leaving what WeldFlow cannot show alone', () => {
    const json = board();
    const read = boardEngine.legacyElements(json) as { id: string; text?: string }[];
    const sent = [
      ...read.filter((e) => e.id !== 'c').map((e) => (e.id === 's' ? { ...e, text: 'Hello' } : e)),
      { id: 'r_new', type: 'rectangle', x: 500, y: 0, width: 10, height: 10 },
    ];
    const { op } = boardEngine.legacyWrite(json, sent);
    const ops = unbatch(op!);
    expect(ops).toContainEqual({ type: 'set', id: 's', patch: { text: { text: 'Hello', marks: [] } } });
    expect(created(op).map((e) => e.id)).toEqual(['r_new']);
    expect(ops).toContainEqual({ type: 'delete', ids: ['c'] });
    expect(ops).toHaveLength(3);
    expect(validateOp(boardOf(json), op!)).toBeNull();
  });
});

describe('boardFromLegacy', () => {
  it('makes a board of WeldFlow elements and reads them back as the board has them', async () => {
    const sent = [
      { id: 's1', type: 'sticky', x: 0, y: 0, text: 'One' },
      { id: 'bad id!', type: 'text', x: 10, y: 50, text: 'Two' },
      { type: 42 },
      'junk',
    ];
    const result = await boardEngine.boardFromLegacy(sent, 'carol');
    const board = await boardIn(result);
    expect(board.elements.map((e) => [e.id, e.type, e.text?.text, e.createdBy])).toEqual([
      ['lg1_badid', 'text', 'Two', 'carol'],
      ['s1', 'sticky', 'One', 'carol'],
    ]);
    const back = result.elements as { id: string; type: string; text: string }[];
    expect(back.map((e) => [e.id, e.type, e.text]).sort()).toEqual([
      ['lg1_badid', 'text', 'Two'],
      ['s1', 'sticky', 'One'],
    ]);
  });
});

describe('readAs', () => {
  const json = () => live(makeFrame(0, 0, 800, 600, 'Ideas', {}, { id: 'frame' }), note('n1', 'Dark mode', { parent: 'frame' }), makeConnector({ x: 0, y: 0 }, { x: 5, y: 5 }, {}, { id: 'line' }));

  it('reads the live board as an outline, up to the limit asked', () => {
    const outline = boardEngine.readAs({ liveJson: json() }, 'outline') as { elements: unknown[]; count: number };
    expect(outline.count).toBe(3);
    expect(outline.elements).toEqual([
      { id: 'frame', type: 'frame', text: 'Ideas', x: 0, y: 0, w: 800, h: 600 },
      { id: 'n1', type: 'sticky', text: 'Dark mode', x: 0, y: 0, w: 200, h: 200, parent: 'frame' },
    ]);
    expect(boardEngine.readAs({ liveJson: json() }, 'outline', null)).toEqual(outline);
    expect(boardEngine.readAs({ liveJson: json() }, 'outline', 1)).toEqual({ elements: [outline.elements[0]], count: 3 });
  });

  it('reads the live board as text or as its snapshot', () => {
    expect(boardEngine.readAs({ liveJson: json() }, 'text')).toEqual({ text: '# Ideas\n\nDark mode' });
    expect(boardEngine.readAs({ liveJson: json() }, 'snapshot')).toEqual({ snapshot: boardOf(json()).toSnapshot() });
  });

  it('reads an old whiteboard’s elements, or none', () => {
    expect(boardEngine.readAs({ legacyJson: null }, 'outline')).toEqual({ elements: [], count: 0 });
    const legacyJson = JSON.stringify([{ id: 's1', type: 'sticky', x: 0, y: 0, text: 'From WeldFlow' }]);
    expect(boardEngine.readAs({ legacyJson }, 'text')).toEqual({ text: 'From WeldFlow' });
    const { snapshot } = boardEngine.readAs({ legacyJson }, 'snapshot') as { snapshot: BoardSnapshot };
    expect(snapshot.elements.map((e) => e.id)).toEqual(['s1']);
  });
});

describe('place', () => {
  const spec = {
    items: [
      { key: 'a', type: 'sticky' as const, text: 'A' },
      { key: 'b', type: 'shape' as const, text: 'B' },
    ],
    lines: [{ from: 'a', to: 'b' }],
  };

  it('lays a spec out around the point given, credited, with its keys', () => {
    const placed = boardEngine.place(live(), spec, 'alice', NOW, { x: 1000, y: 1000 });
    const elements = created(placed.op);
    expect(elements.map((e) => e.type).sort()).toEqual(['connector', 'shape', 'sticky']);
    expect(placed.all.sort()).toEqual(elements.map((e) => e.id).sort());
    expect(placed.ids.every((id) => placed.all.includes(id))).toBe(true);
    const byKey = (key: string) => elements.find((e) => e.id === placed.keys[key]);
    expect(byKey('a')?.text?.text).toBe('A');
    expect(byKey('b')?.text?.text).toBe('B');
    expect(elements.every((e) => e.createdBy === 'alice' && e.createdAt === NOW)).toBe(true);
    // Centred on the point.
    const left = Math.min(...elements.map((e) => e.x));
    const right = Math.max(...elements.map((e) => e.x + e.w));
    expect(Math.abs((left + right) / 2 - 1000)).toBeLessThanOrEqual(1);
    expect(validateOp(Board.fromSnapshot(emptySnapshot()), placed.op)).toBeNull();
  });

  it('without a point, goes right of what is on the board', () => {
    const json = live(note('n1', 'Already here'));
    for (const at of [undefined, null]) {
      const elements = created(boardEngine.place(json, spec, 'alice', NOW, at).op);
      expect(Math.min(...elements.map((e) => e.x))).toBeGreaterThanOrEqual(400);
    }
  });

  it('places nothing for an empty spec', () => {
    expect(boardEngine.place(live(), {}, 'alice', NOW)).toEqual({ op: NOOP, ids: [], all: [], keys: {} });
  });
});

describe('edit', () => {
  const json = () => live(note('n1', 'Old'), note('n_locked', 'Frozen', { locked: true }), note('n2', 'Other'));

  it('changes elements by id, and skips missing and locked ones', () => {
    const result = boardEngine.edit(json(), [
      { id: 'n1', text: 'New', color: 'blue' },
      { id: 'missing', text: 'x' },
      { id: 'n_locked', text: 'x' },
      { id: 'n2', delete: true },
    ]);
    expect(result.changed).toEqual(['n1', 'n2']);
    expect(result.skipped).toEqual(['missing', 'n_locked']);
    const board = boardOf(json());
    expect(validateOp(board, result.op!)).toBeNull();
    applyOp(board, result.op!);
    expect(board.get('n1')?.text?.text).toBe('New');
    expect(board.get('n1')?.fill).not.toBe(note('n1', '').fill);
    expect(board.get('n2')).toBeUndefined();
  });

  it('answers no op when nothing would change', () => {
    expect(boardEngine.edit(json(), [{ id: 'n1', x: 0, y: 0 }])).toEqual({ op: null, changed: ['n1'], skipped: [] });
    expect(boardEngine.edit(json(), [{ id: 'missing', text: 'x' }])).toEqual({ op: null, changed: [], skipped: ['missing'] });
  });
});

describe('aiPrepare', () => {
  it('refuses before the AI layer without a prompt, or without notes', () => {
    expect(boardEngine.aiPrepare(workshop(), input('mindmap', { prompt: '  ' }))).toEqual({
      refused: { code: 'PROMPT_REQUIRED', message: 'Say what to make', status: 400 },
    });
    expect(boardEngine.aiPrepare(workshop(), input('cluster', { elementIds: ['line', 'missing'] }))).toEqual({
      refused: { code: 'NOTHING_TO_DO', message: 'Select some notes with text first', status: 400 },
    });
  });

  it('refuses after the AI layer when there is too little to work on', () => {
    expect(boardEngine.aiPrepare(workshop(), input('cluster', { elementIds: ['n_ship'] }))).toEqual({
      refusedAfterAi: { code: 'NOTHING_TO_DO', message: 'Select at least two notes to group', status: 400 },
    });
    expect(boardEngine.aiPrepare(live(), input('summarize'))).toEqual({
      refusedAfterAi: { code: 'NOTHING_TO_DO', message: 'There is no text on the board to summarise', status: 400 },
    });
  });

  it('says what to ask the model', () => {
    const prepared = boardEngine.aiPrepare(workshop(), input('mindmap', { prompt: 'Launch' }));
    expect(prepared).toMatchObject({ ask: { task: 'draft', schemaName: 'mindmap', user: 'Make a mind map about: Launch' } });
    const cluster = boardEngine.aiPrepare(workshop(), input('cluster', { elementIds: ['n_ship', 'card'] }));
    expect(cluster).toMatchObject({ ask: { task: 'classify', schemaName: 'themes', user: '<notes>\nn1: Ship it\nn2: Billing page\n</notes>' } });
  });

  it('lets through an error that is not a refusal', () => {
    expect(() => boardEngine.aiPrepare(workshop(), { action: 'dance' } as unknown as BoardAiInput)).toThrow(TypeError);
  });
});

describe('aiPlan', () => {
  it('places the model’s answer as the ops to commit', () => {
    const plan = boardEngine.aiPlan(live(), input('stickies', { prompt: 'Retro' }), { groups: [{ notes: ['One', 'Two'] }] }, 'alice', NOW);
    if ('refused' in plan) throw new Error('expected a plan');
    const elements = created(plan.op);
    expect(elements.map((e) => e.text?.text)).toEqual(['One', 'Two']);
    expect(plan.elementIds).toEqual(elements.map((e) => e.id));
    expect(elements.every((e) => e.createdBy === 'alice' && e.createdAt === NOW)).toBe(true);
    expect('text' in plan).toBe(false);
  });

  it('turns a summary into text, with no ops', () => {
    expect(boardEngine.aiPlan(workshop(), input('summarize'), { title: 'Workshop', markdown: '# Points' }, 'alice', NOW)).toEqual({
      op: null,
      elementIds: [],
      text: '# Points',
      title: 'Workshop',
    });
  });

  it('answers no op when the model sorted no note it was given', () => {
    const answer = { themes: [{ title: 'Nothing', notes: ['n9'] }] };
    expect(boardEngine.aiPlan(workshop(), input('cluster', { elementIds: ['n_ship', 'card'] }), answer, 'alice', NOW)).toEqual({ op: null, elementIds: [] });
  });

  it('refuses an answer with nothing to place', () => {
    expect(boardEngine.aiPlan(live(), input('stickies', { prompt: 'x' }), {}, 'alice', NOW)).toEqual({
      refused: { code: 'AI_REQUEST_FAILED', message: 'The AI answered with nothing to place', status: 502 },
    });
  });

  it('lets through an error that is not a refusal', () => {
    expect(() => boardEngine.aiPlan(live(), { action: 'dance' } as unknown as BoardAiInput, {}, 'alice', NOW)).toThrow(TypeError);
  });
});

describe('boardEngineNamespace', () => {
  it('hands out the engine as a namespace binding, whatever the name', () => {
    const ns = boardEngineNamespace();
    expect(ns.idFromName('board-1')).toEqual({ name: 'board-1' });
    expect(ns.get()).toBe(boardEngine);
    expect(Object.keys(ns.get()).sort()).toEqual(
      ['aiPlan', 'aiPrepare', 'boardFromLegacy', 'convertLegacy', 'copyBoard', 'edit', 'importBoard', 'legacyElements', 'legacyWrite', 'newBoard', 'place', 'readAs', 'render', 'taskCards', 'taskPlan'],
    );
  });
});
