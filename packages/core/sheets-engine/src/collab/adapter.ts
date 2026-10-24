/**
 * WeldSheets as a document for @weldsuite/collab: the engine is the state, a
 * workbook snapshot the snapshot, and the ops are the engine's own.
 */

import type { OtAdapter } from '@weldsuite/collab';
import type { Range } from '../address';
import { Engine, type EngineOptions } from '../calc/engine';
import type { WorkbookSnapshot } from '../model/workbook';
import { applyOp } from '../ops/apply';
import { isWellFormedOp } from '../ops/shape';
import { transform } from '../ops/transform';
import { normalize, type Op } from '../ops/types';
import { validateOp } from '../ops/validate';

/** Where someone is in the workbook, shown to everyone else. Never persisted. */
export interface Presence {
  sheetId: string;
  active: { row: number; col: number };
  ranges: Range[];
  /** True while they are typing into the active cell. */
  editing?: boolean;
}

export type SheetsAdapter = OtAdapter<Engine, Op, WorkbookSnapshot, Presence>;

/** The adapter the sheet room and client run on; `engineOptions` go to every engine it loads. */
export function sheetsAdapter(engineOptions?: EngineOptions): SheetsAdapter {
  return {
    load: (snapshot) => Engine.fromSnapshot(snapshot, engineOptions),
    snapshot: (engine) => engine.toSnapshot(),
    apply: (engine, op) => applyOp(engine, op),
    transform: (a, b, aWins) => transform(a, b, aWins),
    normalize: (op) => normalize(op),
    batch: (ops) => ({ type: 'batch', ops }),
    unbatch: (op) => (op.type === 'batch' ? op.ops : [op]),
    isWellFormedOp: (v): v is Op => isWellFormedOp(v),
    validate: (engine, op) => validateOp(engine.workbook, op),
    isPresence,
  };
}

/** Ranges one presence may carry (the platform sends at most 10). */
const MAX_PRESENCE_RANGES = 50;
const MAX_SHEET_ID = 200;

function isPresence(v: unknown): v is Presence {
  if (typeof v !== 'object' || v === null) return false;
  const p = v as Record<string, unknown>;
  const active = p.active as Record<string, unknown> | null;
  return (
    isText(p.sheetId, MAX_SHEET_ID) &&
    typeof active === 'object' &&
    active !== null &&
    isCount(active.row) &&
    isCount(active.col) &&
    Array.isArray(p.ranges) &&
    p.ranges.length <= MAX_PRESENCE_RANGES &&
    p.ranges.every(isRangeLike) &&
    (p.editing === undefined || typeof p.editing === 'boolean')
  );
}

function isRangeLike(v: unknown): boolean {
  if (typeof v !== 'object' || v === null) return false;
  const r = v as Record<string, unknown>;
  return isCount(r.r1) && isCount(r.c1) && isCount(r.r2) && isCount(r.c2);
}

function isCount(v: unknown): boolean {
  return Number.isInteger(v) && (v as number) >= 0;
}

function isText(v: unknown, max: number): boolean {
  return typeof v === 'string' && v.length > 0 && v.length <= max;
}
