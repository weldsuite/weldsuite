/**
 * Copy style, paste style: the look of one element put on others. Only the
 * keys each target's type takes are set, so a sticky's colour can go onto a
 * shape and its font onto a text, but nothing lands where it has no meaning.
 */

import type { Board } from './board';
import type { BoardElement } from './types';
import { keyAllowed } from './schema';
import type { Op } from '../ops/types';

/** The keys that make an element's look. */
export const STYLE_KEYS = [
  'fill',
  'stroke',
  'strokeWidth',
  'strokeStyle',
  'opacity',
  'fontFamily',
  'fontSize',
  'textColor',
  'textAlign',
  'vAlign',
  'radius',
  'route',
  'startCap',
  'endCap',
  'pen',
] as const;
export type StyleKey = (typeof STYLE_KEYS)[number];

export type ElementStyle = Partial<Pick<BoardElement, StyleKey>>;

/** The style an element has (keys it does not set are left out). */
export function styleOf(el: BoardElement): ElementStyle {
  const out: Record<string, unknown> = {};
  for (const key of STYLE_KEYS) {
    const value = el[key];
    if (value !== undefined && value !== null) out[key] = structuredClone(value);
  }
  return out as ElementStyle;
}

/** The ops that put `style` on the elements `ids` (locked ones stay as they are). */
export function pasteStyleOps(board: Board, ids: Iterable<string>, style: ElementStyle): Op {
  const ops: Op[] = [];
  for (const id of ids) {
    const el = board.get(id);
    if (!el || el.locked) continue;
    const patch: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(style)) {
      if (!keyAllowed(el.type, key)) continue;
      if (JSON.stringify((el as unknown as Record<string, unknown>)[key]) === JSON.stringify(value)) continue;
      patch[key] = value;
    }
    if (Object.keys(patch).length) ops.push({ type: 'set', id, patch });
  }
  return ops.length === 1 ? ops[0]! : { type: 'batch', ops };
}
