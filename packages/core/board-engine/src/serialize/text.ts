/**
 * A board as plain text, in reading order: frames with their contents,
 * then the rest. Used for search, AI summaries and WeldAgent's reads.
 */

import type { Board } from '../model/board';
import type { BoardElement } from '../model/types';

/** An element's text: what it says, a frame's title, a card's description, a link's title, a file's name. */
export function elementText(el: BoardElement): string {
  const parts: string[] = [];
  if (el.text?.text) parts.push(el.text.text);
  if (el.type === 'frame' && el.name) parts.push(el.name);
  if (el.description) parts.push(el.description);
  if (el.title) parts.push(el.title);
  if (el.fileName) parts.push(el.fileName);
  return parts.join('\n').trim();
}

function readingOrder(a: BoardElement, b: BoardElement): number {
  // Rows of roughly 80 units, then left to right.
  const ra = Math.round(a.y / 80);
  const rb = Math.round(b.y / 80);
  return ra - rb || a.x - b.x;
}

export function boardToPlainText(board: Board, maxLength = 200_000): string {
  const map = board.childrenMap();
  const lines: string[] = [];
  const visit = (parent: string | null, depth: number) => {
    const kids = [...(map.get(parent) ?? [])].map((e) => board.get(e.id)!).filter(Boolean).sort(readingOrder);
    for (const el of kids) {
      if (el.type === 'frame') {
        lines.push(`${'#'.repeat(Math.min(6, depth + 1))} ${el.name || 'Frame'}`);
        visit(el.id, depth + 1);
        continue;
      }
      if (el.type === 'group') {
        visit(el.id, depth);
        continue;
      }
      const t = elementText(el);
      if (t) lines.push(t);
    }
  };
  visit(null, 0);
  const out = lines.join('\n\n');
  return out.length > maxLength ? out.slice(0, maxLength) : out;
}

/**
 * Every element's id in reading order: frames before what they hold, then
 * rows top to bottom, left to right. Groups are walked, not listed. Keyboard
 * focus and the screen-reader outline follow it.
 */
export function readingOrderIds(board: Board): string[] {
  const map = board.childrenMap();
  const out: string[] = [];
  const visit = (parent: string | null) => {
    const kids = [...(map.get(parent) ?? [])].map((e) => board.get(e.id)!).filter(Boolean).sort(readingOrder);
    for (const el of kids) {
      if (el.type !== 'group' && el.type !== 'comment') out.push(el.id);
      if (el.type === 'frame' || el.type === 'group') visit(el.id);
    }
  };
  visit(null);
  return out;
}

/** Element-by-element text with ids, for agents that need to point at things. */
export function boardOutline(board: Board, limit = 500): { id: string; type: string; text: string; x: number; y: number; w: number; h: number; parent?: string }[] {
  const out: { id: string; type: string; text: string; x: number; y: number; w: number; h: number; parent?: string }[] = [];
  for (const el of board.paintOrder()) {
    if (out.length >= limit) break;
    if (el.type === 'connector' || el.type === 'group' || el.type === 'pen') continue;
    const parent = board.effectiveParent(el);
    out.push({
      id: el.id,
      type: el.type === 'shape' ? `shape:${el.shape ?? 'rectangle'}` : el.type,
      text: elementText(el).slice(0, 500),
      x: Math.round(el.x),
      y: Math.round(el.y),
      w: Math.round(el.w),
      h: Math.round(el.h),
      ...(parent ? { parent } : {}),
    });
  }
  return out;
}

/** Lower case, without accents, for matching what people type against what is on the board. */
function fold(s: string): string {
  return s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
}

/**
 * Elements whose text contains `query` (any case, accents ignored), in
 * reading order: frames before what they hold, then rows top to bottom.
 * Find on the board walks these.
 */
export function findOnBoard(board: Board, query: string, limit = 1000): string[] {
  const needle = fold(query.trim());
  if (!needle) return [];
  const map = board.childrenMap();
  const out: string[] = [];
  const visit = (parent: string | null) => {
    const kids = [...(map.get(parent) ?? [])].map((e) => board.get(e.id)!).filter(Boolean).sort(readingOrder);
    for (const el of kids) {
      if (out.length >= limit) return;
      if (el.type !== 'group' && fold(elementText(el)).includes(needle)) out.push(el.id);
      if (el.type === 'frame' || el.type === 'group') visit(el.id);
    }
  };
  visit(null);
  return out;
}
