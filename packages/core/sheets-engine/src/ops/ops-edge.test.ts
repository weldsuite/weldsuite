import { describe, expect, it } from 'vitest';
import { MAX_COLS, MAX_ROWS } from '../address';
import { Engine } from '../calc/engine';
import { Sheet, Workbook, type WorkbookSnapshot } from '../model/workbook';
import { applyOp } from './apply';
import { transform } from './transform';
import type { Op } from './types';

const OPTIONS = { now: () => 0, random: () => 0.5, timezoneOffset: () => 0 };

function snapshotWith(...setup: Op[]): WorkbookSnapshot {
  const wb = new Workbook();
  wb.sheets.push(new Sheet('s1', 'Sheet1'), new Sheet('s2', 'Data'));
  const engine = new Engine(wb, OPTIONS);
  for (const op of setup) applyOp(engine, op);
  return engine.toSnapshot();
}

const engineFrom = (snap: WorkbookSnapshot) => Engine.fromSnapshot(JSON.parse(JSON.stringify(snap)) as WorkbookSnapshot, OPTIONS);
const state = (e: Engine) => JSON.parse(JSON.stringify(e.toSnapshot())) as WorkbookSnapshot;

function converge(snap: WorkbookSnapshot, a: Op, b: Op) {
  const server = engineFrom(snap);
  applyOp(server, a);
  applyOp(server, transform(b, a, true));
  const client = engineFrom(snap);
  applyOp(client, b);
  applyOp(client, transform(a, b, false));
  return { server: state(server), client: state(client), serverEngine: server };
}

/** Both server orders: a then b, and b then a. */
function expectConverges(snap: WorkbookSnapshot, a: Op, b: Op) {
  const one = converge(snap, a, b);
  expect(one.client, 'a first on the server').toEqual(one.server);
  const two = converge(snap, b, a);
  expect(two.client, 'b first on the server').toEqual(two.server);
  return { aFirst: one.serverEngine, bFirst: two.serverEngine };
}

describe('undo of structural changes', () => {
  it('treats a move onto itself as nothing to undo', () => {
    const engine = engineFrom(snapshotWith({ type: 'setCells', sheetId: 's1', cells: [[3, 0, { v: 'a' }], [5, 0, { v: 'b' }]] }));
    const before = state(engine);
    const inverse = applyOp(engine, { type: 'moveDims', sheetId: 's1', sheetName: 'Sheet1', axis: 'row', from: 5, count: 2, to: 5 });
    expect(state(engine)).toEqual(before);
    applyOp(engine, inverse);
    expect(state(engine)).toEqual(before);
  });

  it('puts defined names back when a row delete is undone', () => {
    const engine = engineFrom(snapshotWith({ type: 'setNames', names: [{ name: 'x', formula: 'Sheet1!$A$5' }] }));
    const inverse = applyOp(engine, { type: 'deleteDims', sheetId: 's1', sheetName: 'Sheet1', axis: 'row', at: 4, count: 1 });
    expect(engine.workbook.names[0]!.formula).toBe('#REF!');
    applyOp(engine, inverse);
    expect(engine.workbook.names[0]!.formula).toBe('Sheet1!$A$5');
  });

  it('merges again on undo when a move had split a merge', () => {
    const engine = engineFrom(snapshotWith({ type: 'merge', sheetId: 's1', ranges: [{ r1: 2, c1: 1, r2: 4, c2: 2 }] }));
    const before = state(engine);
    const inverse = applyOp(engine, { type: 'moveDims', sheetId: 's1', sheetName: 'Sheet1', axis: 'row', from: 3, count: 1, to: 0 });
    expect(engine.workbook.sheets[0]!.merges).toEqual([]);
    applyOp(engine, inverse);
    expect(state(engine)).toEqual(before);
  });
});

describe('transform convergence (review cases)', () => {
  it('merge against unmerge', () => {
    const snap = snapshotWith({ type: 'merge', sheetId: 's1', ranges: [{ r1: 0, c1: 2, r2: 1, c2: 2 }] });
    const { aFirst, bFirst } = expectConverges(
      snap,
      { type: 'merge', sheetId: 's1', ranges: [{ r1: 0, c1: 0, r2: 1, c2: 1 }] },
      { type: 'unmerge', sheetId: 's1', ranges: [{ r1: 0, c1: 0, r2: 1, c2: 2 }] },
    );
    expect(aFirst.workbook.sheets[0]!.merges).toEqual([]);
    expect(bFirst.workbook.sheets[0]!.merges).toEqual([{ r1: 0, c1: 0, r2: 1, c2: 1 }]);
  });

  it('formatting a range while rows are inserted inside it leaves the new rows alone', () => {
    const snap = snapshotWith();
    const { aFirst } = expectConverges(
      snap,
      { type: 'formatRanges', sheetId: 's1', ranges: [{ r1: 0, c1: 0, r2: 4, c2: 0 }], patch: { bold: true } },
      { type: 'insertDims', sheetId: 's1', sheetName: 'Sheet1', axis: 'row', at: 2, count: 1 },
    );
    expect(aFirst.workbook.style(aFirst.workbook.sheets[0]!, 2, 0)).toBeUndefined();
    expect(aFirst.workbook.style(aFirst.workbook.sheets[0]!, 5, 0)?.bold).toBe(true);
  });

  it('explicit row styles against whole-row formatting', () => {
    const snap = snapshotWith();
    expectConverges(
      snap,
      { type: 'setStyles', sheetId: 's1', cells: [], rows: [[3, '{"italic":true}']] },
      { type: 'formatRanges', sheetId: 's1', ranges: [{ r1: 3, c1: 0, r2: 3, c2: MAX_COLS - 1 }], patch: { bold: true } },
    );
  });

  it('a cleared cell under a styled column against formatting it', () => {
    const snap = snapshotWith(
      { type: 'formatRanges', sheetId: 's1', ranges: [{ r1: 0, c1: 0, r2: MAX_ROWS - 1, c2: 0 }], patch: { fill: '#ff0000' } },
      { type: 'setStyles', sheetId: 's1', cells: [[0, 0, '{"italic":true}']] },
    );
    expectConverges(
      snap,
      { type: 'setStyles', sheetId: 's1', cells: [[0, 0, null]] },
      { type: 'formatRanges', sheetId: 's1', ranges: [{ r1: 0, c1: 0, r2: 0, c2: 0 }], patch: { bold: true } },
    );
  });

  it('names scoped to a sheet that is deleted at the same time', () => {
    const snap = snapshotWith();
    const { aFirst, bFirst } = expectConverges(
      snap,
      { type: 'setNames', names: [{ name: 'loc', formula: 'Data!A1', sheetId: 's2' }, { name: 'all', formula: '1' }] },
      { type: 'deleteSheet', sheetId: 's2', sheetName: 'Data' },
    );
    expect(aFirst.workbook.names.map((n) => n.name)).toEqual(['all']);
    expect(bFirst.workbook.names.map((n) => n.name)).toEqual(['all']);
  });

  it('workbook names against rows inserted on the first sheet', () => {
    const snap = snapshotWith();
    expectConverges(
      snap,
      { type: 'setNames', names: [{ name: 'n', formula: 'A5' }, { name: 'q', formula: 'Sheet1!A5' }] },
      { type: 'insertDims', sheetId: 's1', sheetName: 'Sheet1', axis: 'row', at: 0, count: 1 },
    );
  });
});

describe('convergence fuzz over merges, styles and names', () => {
  it('converges for random concurrent ops', () => {
    const snap = snapshotWith(
      { type: 'setCells', sheetId: 's1', cells: [[0, 0, { v: 1 }], [1, 0, { f: 'A1*2' }], [2, 1, { v: 'x' }]] },
      { type: 'merge', sheetId: 's1', ranges: [{ r1: 4, c1: 0, r2: 5, c2: 1 }] },
      { type: 'formatRanges', sheetId: 's1', ranges: [{ r1: 0, c1: 0, r2: MAX_ROWS - 1, c2: 2 }], patch: { fill: '#eeeeee' } },
    );
    let seed = 7;
    const rand = (n: number) => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed % n;
    };
    const range = () => {
      const r = rand(6);
      const c = rand(4);
      return { r1: r, c1: c, r2: r + rand(3), c2: c + rand(2) };
    };
    const style = () => (rand(2) ? '{"bold":true}' : null);
    const randomOp = (): Op => {
      const axis = rand(2) ? 'row' : 'col';
      switch (rand(10)) {
        case 0:
          return { type: 'insertDims', sheetId: 's1', sheetName: 'Sheet1', axis, at: rand(7), count: 1 + rand(2) };
        case 1:
          return { type: 'deleteDims', sheetId: 's1', sheetName: 'Sheet1', axis, at: rand(7), count: 1 + rand(2) };
        case 2:
          return { type: 'merge', sheetId: 's1', ranges: [range()] };
        case 3:
          return { type: 'unmerge', sheetId: 's1', ranges: [range()] };
        case 4:
          return { type: 'formatRanges', sheetId: 's1', ranges: [range()], patch: rand(2) ? { italic: true } : { bold: null, color: '#ff0000' } };
        case 5:
          return { type: 'formatRanges', sheetId: 's1', ranges: [{ r1: rand(5), c1: 0, r2: 5, c2: MAX_COLS - 1 }], patch: { bold: true } };
        case 6:
          return { type: 'setStyles', sheetId: 's1', cells: [[rand(6), rand(4), style()]], rows: [[rand(6), style()]], cols: [[rand(4), style()]] };
        case 7:
          return { type: 'setNames', names: [{ name: 'n', formula: `Sheet1!A${1 + rand(6)}` }, { name: 'm', formula: `A${1 + rand(6)}`, sheetId: 's1' }] };
        case 8:
          return { type: 'setCells', sheetId: 's1', cells: [[rand(6), rand(4), { f: `A${1 + rand(6)}+1` }]] };
        default:
          return { type: 'moveDims', sheetId: 's1', sheetName: 'Sheet1', axis, from: rand(3), count: 1, to: 5 + rand(2) };
      }
    };
    // A range format patches the style a cell inherits from its row/column, so it
    // cannot commute with a concurrent change to that row/column style. Clients
    // rebase instead (see transform.ts), so only contents are compared then.
    const setsAxisStyles = (op: Op) =>
      (op.type === 'setStyles' && !!(op.rows?.length || op.cols?.length)) ||
      (op.type === 'formatRanges' && op.ranges.some((r) => r.c2 === MAX_COLS - 1 || r.r2 === MAX_ROWS - 1));
    const inheritRace = (x: Op, y: Op) => setsAxisStyles(x) && y.type === 'formatRanges';
    const stripStyles = (s: WorkbookSnapshot) => {
      for (const sheet of s.sheets) {
        for (const cell of sheet.cells) delete cell[2].s;
        sheet.cells = sheet.cells.filter((c) => c[2].v !== null || c[2].f !== undefined);
        delete sheet.rows.styles;
        delete sheet.cols.styles;
      }
    };
    for (let i = 0; i < 400; i++) {
      const a = randomOp();
      const b = randomOp();
      const { server, client } = converge(snap, a, b);
      if (a.type === 'moveDims' || b.type === 'moveDims') {
        // A move racing a delete across a merged range is resolved by checksum resync, not OT.
        for (const s of [...server.sheets, ...client.sheets]) delete s.merges;
      }
      if (inheritRace(a, b) || inheritRace(b, a)) {
        stripStyles(server);
        stripStyles(client);
      }
      expect(client, `a=${JSON.stringify(a)} b=${JSON.stringify(b)}`).toEqual(server);
    }
  });
});
