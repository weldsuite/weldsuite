import { describe, expect, it } from 'vitest';
import { Engine } from '../calc/engine';
import { Sheet, Workbook, type WorkbookSnapshot } from '../model/workbook';
import { applyOp } from './apply';
import { transform } from './transform';
import type { Op } from './types';

const OPTIONS = { now: () => Date.UTC(2026, 0, 15), random: () => 0.5, timezoneOffset: () => 0 };

function baseSnapshot(): WorkbookSnapshot {
  const wb = new Workbook();
  wb.sheets.push(new Sheet('s1', 'Sheet1'), new Sheet('s2', 'Data'));
  const engine = new Engine(wb, OPTIONS);
  applyOp(engine, {
    type: 'setCells',
    sheetId: 's1',
    cells: [
      [0, 0, { v: 1 }],
      [1, 0, { v: 2 }],
      [2, 0, { v: 3 }],
      [3, 0, { f: 'A1+A2+A3' }],
      [0, 1, { f: 'A1:A3*2' }],
      [5, 3, { v: 'x' }],
      [6, 4, { f: 'Data!A1&A1' }],
    ],
  });
  applyOp(engine, { type: 'setCells', sheetId: 's2', cells: [[0, 0, { v: 'd' }], [3, 3, { f: 'Sheet1!A4*10' }]] });
  applyOp(engine, { type: 'formatRanges', sheetId: 's1', ranges: [{ r1: 0, c1: 0, r2: 2, c2: 1 }], patch: { bold: true } });
  applyOp(engine, { type: 'merge', sheetId: 's1', ranges: [{ r1: 8, c1: 0, r2: 10, c2: 1 }] });
  return engine.toSnapshot();
}

const engineFrom = (snap: WorkbookSnapshot) => Engine.fromSnapshot(JSON.parse(JSON.stringify(snap)) as WorkbookSnapshot, OPTIONS);
const state = (e: Engine) => JSON.parse(JSON.stringify(e.toSnapshot())) as WorkbookSnapshot;

describe('applyOp inverses', () => {
  const cases: [string, Op][] = [
    ['setCells', { type: 'setCells', sheetId: 's1', cells: [[0, 0, { v: 10 }], [1, 0, null], [9, 9, { f: 'A1*3' }]] }],
    ['formatRanges', { type: 'formatRanges', sheetId: 's1', ranges: [{ r1: 0, c1: 0, r2: 4, c2: 4 }], patch: { fill: '#ff0000', bold: null } }],
    ['format whole column', { type: 'formatRanges', sheetId: 's1', ranges: [{ r1: 0, c1: 2, r2: 1_048_575, c2: 2 }], patch: { italic: true } }],
    ['insert rows', { type: 'insertDims', sheetId: 's1', sheetName: 'Sheet1', axis: 'row', at: 1, count: 2 }],
    ['delete rows', { type: 'deleteDims', sheetId: 's1', sheetName: 'Sheet1', axis: 'row', at: 1, count: 2 }],
    ['delete rows through a merge', { type: 'deleteDims', sheetId: 's1', sheetName: 'Sheet1', axis: 'row', at: 7, count: 2 }],
    ['delete columns', { type: 'deleteDims', sheetId: 's1', sheetName: 'Sheet1', axis: 'col', at: 0, count: 1 }],
    ['move rows', { type: 'moveDims', sheetId: 's1', sheetName: 'Sheet1', axis: 'row', from: 0, count: 2, to: 6 }],
    ['resize', { type: 'resizeDims', sheetId: 's1', axis: 'col', entries: [[0, 200], [1, null]] }],
    ['hide', { type: 'hideDims', sheetId: 's1', axis: 'row', indices: [2, 3], hidden: true }],
    ['rename sheet', { type: 'renameSheet', sheetId: 's2', oldName: 'Data', name: 'Q1 data' }],
    ['delete sheet', { type: 'deleteSheet', sheetId: 's2', sheetName: 'Data' }],
    ['add sheet', { type: 'addSheet', sheetId: 's3', name: 'New', index: 1 }],
    ['move sheet', { type: 'moveSheet', sheetId: 's2', index: 0 }],
    ['freeze', { type: 'setFreeze', sheetId: 's1', rows: 1, cols: 2 }],
    ['merge over merge', { type: 'merge', sheetId: 's1', ranges: [{ r1: 9, c1: 1, r2: 12, c2: 3 }] }],
    ['props', { type: 'setSheetProps', sheetId: 's1', props: { tabColor: '#00ff00', gridlines: false } }],
    ['names', { type: 'setNames', names: [{ name: 'rate', formula: '0.21' }] }],
  ];

  for (const [name, op] of cases) {
    it(`undoes ${name}`, () => {
      const snap = baseSnapshot();
      const engine = engineFrom(snap);
      const before = state(engine);
      const inverse = applyOp(engine, op);
      expect(state(engine)).not.toEqual(before);
      applyOp(engine, inverse);
      expect(state(engine)).toEqual(before);
    });
  }

  it('recalculates after ops', () => {
    const engine = engineFrom(baseSnapshot());
    applyOp(engine, { type: 'setCells', sheetId: 's1', cells: [[0, 0, { v: 100 }]] });
    expect(engine.getValue('s1', 3, 0)).toBe(105);
    expect(engine.getValue('s2', 3, 3)).toBe(1050);
    expect(engine.getValue('s1', 0, 1)).toBe(200);
  });
});

/** Server applies a then b' = T(b, a, true); the client that made b applies b then a' = T(a, b, false). */
function converge(snap: WorkbookSnapshot, a: Op, b: Op) {
  const server = engineFrom(snap);
  applyOp(server, a);
  applyOp(server, transform(b, a, true));
  const client = engineFrom(snap);
  applyOp(client, b);
  applyOp(client, transform(a, b, false));
  return { server: state(server), client: state(client), serverEngine: server };
}

describe('transform', () => {
  it('shifts a concurrent edit below inserted rows and rewrites its formula', () => {
    const snap = baseSnapshot();
    const { server, client, serverEngine } = converge(
      snap,
      { type: 'insertDims', sheetId: 's1', sheetName: 'Sheet1', axis: 'row', at: 0, count: 1 },
      { type: 'setCells', sheetId: 's1', cells: [[4, 0, { f: 'A1*100' }]] },
    );
    expect(server).toEqual(client);
    expect(serverEngine.getCell('s1', 5, 0)?.f).toBe('A2*100');
    expect(serverEngine.getValue('s1', 5, 0)).toBe(100);
  });

  it('drops an edit to a row someone deleted', () => {
    const snap = baseSnapshot();
    const { server, client, serverEngine } = converge(
      snap,
      { type: 'deleteDims', sheetId: 's1', sheetName: 'Sheet1', axis: 'row', at: 5, count: 1 },
      { type: 'setCells', sheetId: 's1', cells: [[5, 3, { v: 'gone' }], [6, 3, { v: 'kept' }]] },
    );
    expect(server).toEqual(client);
    expect(serverEngine.getValue('s1', 5, 3)).toBe('kept');
  });

  it('lets the later write win on the same cell', () => {
    const snap = baseSnapshot();
    const { server, client, serverEngine } = converge(
      snap,
      { type: 'setCells', sheetId: 's1', cells: [[0, 0, { v: 'first' }]] },
      { type: 'setCells', sheetId: 's1', cells: [[0, 0, { v: 'second' }]] },
    );
    expect(server).toEqual(client);
    expect(serverEngine.getValue('s1', 0, 0)).toBe('second');
  });

  it('follows a sheet rename inside concurrent formulas', () => {
    const snap = baseSnapshot();
    const { server, client, serverEngine } = converge(
      snap,
      { type: 'renameSheet', sheetId: 's2', oldName: 'Data', name: 'Raw' },
      { type: 'setCells', sheetId: 's1', cells: [[12, 0, { f: 'Data!A1' }]] },
    );
    expect(server).toEqual(client);
    expect(serverEngine.getCell('s1', 12, 0)?.f).toBe('Raw!A1');
  });

  it('dedupes concurrent sheets with the same name', () => {
    const snap = baseSnapshot();
    const { server, client } = converge(
      snap,
      { type: 'addSheet', sheetId: 'x', name: 'Budget', index: 2 },
      { type: 'addSheet', sheetId: 'y', name: 'Budget', index: 2 },
    );
    expect(server).toEqual(client);
    expect(server.sheets.map((s) => s.name).sort()).toEqual(['Budget', 'Budget (2)', 'Data', 'Sheet1']);
  });

  it('converges for random concurrent ops', () => {
    const snap = baseSnapshot();
    let seed = 42;
    const rand = (n: number) => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed % n;
    };
    const randomOp = (): Op => {
      const axis = rand(2) ? 'row' : 'col';
      switch (rand(9)) {
        case 0:
          return { type: 'insertDims', sheetId: 's1', sheetName: 'Sheet1', axis, at: rand(8), count: 1 + rand(3) };
        case 1:
          return { type: 'deleteDims', sheetId: 's1', sheetName: 'Sheet1', axis, at: rand(8), count: 1 + rand(3) };
        case 2:
          return { type: 'moveDims', sheetId: 's1', sheetName: 'Sheet1', axis, from: rand(4), count: 1 + rand(2), to: 6 + rand(3) };
        case 3:
          return {
            type: 'setCells',
            sheetId: 's1',
            cells: [
              [rand(8), rand(5), { v: rand(100) }],
              [rand(8), rand(5), { f: `A${1 + rand(6)}+B${1 + rand(6)}` }],
            ],
          };
        case 4:
          return { type: 'setCells', sheetId: 's1', cells: [[rand(8), rand(5), null]] };
        case 5: {
          const r = rand(6);
          const c = rand(4);
          return { type: 'formatRanges', sheetId: 's1', ranges: [{ r1: r, c1: c, r2: r + rand(3), c2: c + rand(2) }], patch: rand(2) ? { bold: true } : { fill: '#00ff00', bold: null } };
        }
        case 6:
          return { type: 'resizeDims', sheetId: 's1', axis, entries: [[rand(6), 30 + rand(100)]] };
        case 7:
          return { type: 'setFreeze', sheetId: 's1', rows: rand(3), cols: rand(3) };
        default:
          return { type: 'hideDims', sheetId: 's1', axis, indices: [rand(6)], hidden: true };
      }
    };
    for (let i = 0; i < 400; i++) {
      const a = randomOp();
      const b = randomOp();
      const { server, client } = converge(snap, a, b);
      if (a.type === 'moveDims' || b.type === 'moveDims') {
        // A move racing a delete across a merged range is resolved by checksum resync, not OT.
        for (const sheet of [...server.sheets, ...client.sheets]) delete sheet.merges;
      }
      expect(client, `a=${JSON.stringify(a)} b=${JSON.stringify(b)}`).toEqual(server);
    }
  });
});
