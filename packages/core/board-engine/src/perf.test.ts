/**
 * The engine's performance budgets (docs/plans/weldboard.md, phase 11):
 * a 50,000-element board loads in under 2 s, an op applies in under 1 ms, and
 * at 10,000 elements a viewport's worth of drawing is found and listed well
 * inside a 60 fps frame (16 ms), which is what panning needs.
 *
 * Each budget is checked on the median of a few runs, with the budget itself
 * as the bound, so a slow CI machine has the plan's margin and no more.
 */

import { describe, expect, it } from 'vitest';
import { Board } from './model/board';
import { STICKY_COLORS, makeConnector, makeFrame, makeShape, makeSticky } from './model/defaults';
import { keysBetween } from './model/order';
import { applyOp } from './ops/apply';
import { validateOp } from './ops/validate';
import { SpatialIndex } from './geometry/spatial';
import { emptySnapshot } from './serialize/snapshot';
import type { BoardElement, BoardSnapshot } from './model/types';
import { elementDisplay } from './display/display';
import { CachedMeasurer, MetricsMeasurer } from '@weldsuite/docs-engine';

/** A board like a busy workshop: frames of sticky notes, shapes and the arrows between them. */
function bigSnapshot(count: number): BoardSnapshot {
  const elements: BoardElement[] = [];
  const keys = keysBetween(null, null, count);
  const perFrame = 100;
  let k = 0;
  for (let f = 0; elements.length < count; f++) {
    const fx = (f % 20) * 2600;
    const fy = Math.floor(f / 20) * 2600;
    const frame = makeFrame(fx, fy, 2500, 2500, `Frame ${f}`, { order: keys[k++]! }, { id: `f${f}` });
    elements.push(frame);
    const inner = keysBetween(null, null, perFrame);
    for (let i = 0; i < perFrame && elements.length < count; i++) {
      const x = fx + 40 + (i % 10) * 240;
      const y = fy + 40 + Math.floor(i / 10) * 240;
      const id = `n${f}_${i}`;
      elements.push(
        i % 3 === 0
          ? makeShape('rounded', x, y, 200, 100, { order: inner[i]!, parent: frame.id }, { id, text: `Step ${i}` })
          : makeSticky(x, y, { order: inner[i]!, parent: frame.id }, { id, text: `Idea ${f}.${i}: something worth discussing`, color: STICKY_COLORS[i % 12] }),
      );
      if (i % 7 === 6 && elements.length < count) {
        const prev = `n${f}_${i - 1}`;
        elements.push(makeConnector({ x, y, el: prev, side: 'auto' }, { x: x + 100, y: y + 100, el: id, side: 'auto' }, { order: keys[k++]! }, { id: `c${f}_${i}` }));
      }
    }
  }
  return { ...emptySnapshot(), elements: elements.slice(0, count) };
}

function median(run: () => number, times = 5): number {
  const samples = Array.from({ length: times }, run).sort((a, b) => a - b);
  return samples[Math.floor(times / 2)]!;
}

const time = (fn: () => void) => {
  const start = performance.now();
  fn();
  return performance.now() - start;
};

describe('performance budgets', () => {
  it('loads a 50,000-element board in under 2 s', () => {
    const snapshot = bigSnapshot(50_000);
    const json = JSON.stringify(snapshot);
    const ms = median(() => time(() => Board.fromSnapshot(JSON.parse(json) as BoardSnapshot)), 3);
    expect(Board.fromSnapshot(snapshot).size).toBe(50_000);
    expect(ms).toBeLessThan(2000);
  }, 60_000);

  it('applies an op in under 1 ms on a 50,000-element board, checks included', () => {
    const board = Board.fromSnapshot(bigSnapshot(50_000));
    const ops = Array.from({ length: 500 }, (_, i) => ({ type: 'set' as const, id: `n${i % 400}_${i % 100}`, patch: { x: i, y: i } }));
    const perOp = median(() => time(() => ops.forEach((op) => validateOp(board, op) === null && applyOp(board, op))) / ops.length);
    expect(perOp).toBeLessThan(1);
  }, 60_000);

  it('finds and draws a viewport of a 10,000-element board inside a 60 fps frame', () => {
    const board = Board.fromSnapshot(bigSnapshot(10_000));
    const index = new SpatialIndex(board);
    index.rebuild();
    const measurer = new CachedMeasurer(new MetricsMeasurer());
    // A 1920x1080 screen at 50% zoom, panned across the board; the editor
    // caches each element's drawing, so a frame is the query plus the
    // drawings of what scrolled into view (all of it here, the worst case).
    const frame = (step: number) => {
      const ids = index.query({ x: step * 400, y: step * 200, w: 3840, h: 2160 });
      for (const id of ids) elementDisplay(board, board.get(id)!, { measurer });
    };
    frame(0);
    const ms = median(() => time(() => frame(1)));
    expect(index.query({ x: 400, y: 200, w: 3840, h: 2160 }).size).toBeGreaterThan(50);
    expect(ms).toBeLessThan(16);
  }, 60_000);
});
