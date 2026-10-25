/**
 * Scale benchmark: a sheet of N rows (two number columns, a formula column
 * reading them, a running total and a few whole-column aggregates), timed
 * through what users do to it. Run with
 *
 *   pnpm --filter @weldsuite/sheets-engine bench [rows ...]
 *
 * (default 100000 and 1000000 rows). Numbers are wall-clock on this machine;
 * the heap figures need --expose-gc, which the script sets.
 */

import { applyOp } from '../src/ops/apply';
import { Engine } from '../src/calc/engine';
import { Workbook, Sheet } from '../src/model/workbook';

declare const process: {
  argv: string[];
  memoryUsage(): { heapUsed: number };
  hrtime: { bigint(): bigint };
};
/** Set by node --expose-gc. */
const gc = (globalThis as { gc?: () => void }).gc;

const SHEET = 'sheet1';

function heapMb(): number {
  gc?.();
  return process.memoryUsage().heapUsed / 2 ** 20;
}

function time<T>(label: string, rows: number, fn: () => T): T {
  const start = process.hrtime.bigint();
  const out = fn();
  const ms = Number(process.hrtime.bigint() - start) / 1e6;
  results.push({ rows, label, ms });
  return out;
}

const results: { rows: number; label: string; ms: number; note?: string }[] = [];

/** A: quantity, B: price, C: =A*B, D: running total =D(r-1)+C(r); F1..F3: whole-column aggregates. */
function workbook(rows: number): Workbook {
  const wb = new Workbook();
  const sheet = new Sheet(SHEET, 'Data');
  sheet.rowCount = rows + 1;
  sheet.colCount = 6;
  for (let r = 0; r < rows; r++) {
    const n = r + 1;
    sheet.cells.set(r, 0, { v: (r % 97) + 1 });
    sheet.cells.set(r, 1, { v: ((r * 7) % 89) / 4 });
    sheet.cells.set(r, 2, { v: null, f: `A${n}*B${n}` });
    sheet.cells.set(r, 3, { v: null, f: r === 0 ? `C1` : `D${n - 1}+C${n}` });
  }
  sheet.cells.set(0, 5, { v: null, f: 'SUM(C:C)' });
  sheet.cells.set(1, 5, { v: null, f: 'AVERAGE(B:B)' });
  sheet.cells.set(2, 5, { v: null, f: 'COUNTIF(A:A,">50")' });
  wb.sheets.push(sheet);
  return wb;
}

function run(rows: number): void {
  const before = heapMb();
  const wb = time('build cells', rows, () => workbook(rows));
  const engine = time('load (graph + full calc)', rows, () => new Engine(wb));
  const heap = heapMb() - before;
  results.push({ rows, label: 'heap after load', ms: NaN, note: `${heap.toFixed(0)} MB (${((heap * 2 ** 20) / (rows * 4)).toFixed(0)} B/cell)` });

  const total = engine.getValue(SHEET, 0, 5);
  time('edit A[last] (one formula + total)', rows, () => {
    applyOp(engine, { type: 'setCells', sheetId: SHEET, cells: [[rows - 1, 0, { v: 5 }]] });
  });
  time('edit A1 (running total: every row)', rows, () => {
    applyOp(engine, { type: 'setCells', sheetId: SHEET, cells: [[0, 0, { v: 7 }]] });
  });
  time('insert row at 10', rows, () => {
    applyOp(engine, { type: 'insertDims', sheetId: SHEET, sheetName: 'Data', axis: 'row', at: 10, count: 1 });
  });
  time('delete row at 10', rows, () => {
    applyOp(engine, { type: 'deleteDims', sheetId: SHEET, sheetName: 'Data', axis: 'row', at: 10, count: 1 });
  });
  time('insert column at E (after the data)', rows, () => {
    applyOp(engine, { type: 'insertDims', sheetId: SHEET, sheetName: 'Data', axis: 'col', at: 4, count: 1 });
  });
  const snapshot = time('snapshot (toJSON)', rows, () => engine.toSnapshot());
  const json = time('JSON.stringify', rows, () => JSON.stringify(snapshot));
  results.push({ rows, label: 'snapshot size', ms: NaN, note: `${(json.length / 2 ** 20).toFixed(1)} MB` });
  const parsed = time('JSON.parse', rows, () => JSON.parse(json));
  const reloaded = time('fromSnapshot (load)', rows, () => Engine.fromSnapshot(parsed));
  const same = reloaded.getValue(SHEET, 0, 6) === engine.getValue(SHEET, 0, 6);
  results.push({ rows, label: 'reloaded total matches', ms: NaN, note: `${same} (before edits: ${String(total)})` });
}

const sizes = process.argv.slice(2).map(Number).filter((n) => n > 0);
for (const rows of sizes.length ? sizes : [100_000, 1_000_000]) run(rows);

const pad = (s: string, n: number) => s.padEnd(n);
console.log(`${pad('rows', 10)}${pad('step', 40)}result`);
for (const r of results) {
  const value = r.note ?? `${r.ms.toFixed(0)} ms`;
  console.log(`${pad(r.rows.toLocaleString('en'), 10)}${pad(r.label, 40)}${value}`);
}
