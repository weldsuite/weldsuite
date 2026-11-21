import { describe, expect, it } from 'vitest';
import { elbowRoute, type ResolvedEnd } from './connectors';
import type { Point } from './path';

const free = (p: Point): ResolvedEnd => ({ p, dir: null, box: null });

/** A route's shape: its points relative to where it starts. */
function shapeOf(start: Point, end: Point): string {
  return elbowRoute(free(start), free(end))
    .map((p) => `${Math.round(p.x - start.x)},${Math.round(p.y - start.y)}`)
    .join(' ');
}

describe('an elbow line being moved', () => {
  it('keeps one shape wherever it is on the board', () => {
    // Where a line drawn on a real board started and ended: two routes of equal length fit it.
    const start = { x: 199.62576421060692, y: -432.35887772339123 };
    const end = { x: 396.89056041625884, y: -195.64112227660883 };
    const shapes = new Set<string>();
    for (let dx = -1000; dx <= 1000; dx += 37.3) {
      for (let dy = -800; dy <= 800; dy += 41.7) {
        shapes.add(shapeOf({ x: start.x + dx, y: start.y + dy }, { x: end.x + dx, y: end.y + dy }));
      }
    }
    expect([...shapes]).toEqual(['0,0 197,0 197,237']);
  });
});
