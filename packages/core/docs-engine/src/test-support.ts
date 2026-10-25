/**
 * Helpers shared by the tests: a seeded random source, a counter for ids,
 * and comparing documents by their (deterministic) snapshots.
 */

import type { DocModel } from './model/document';
import { stableKey } from './model/styles';

export function rng(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    // xorshift32
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) / 0x100000000;
  };
}

export function counterIds(prefix = 'id'): () => string {
  let n = 0;
  return () => `${prefix}${++n}`;
}

export function snapshotKey(doc: DocModel): string {
  return stableKey(doc.toSnapshot());
}
