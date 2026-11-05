/**
 * Copy and paste. A copied selection goes to the clipboard twice: as
 * readable text (for other apps) and as the exact fragment inside the HTML
 * (for pasting back into any board without loss).
 */

import {
  deleteOps,
  fragmentFromText,
  fragmentToText,
  makeFragment,
  makeSticky,
  makeText,
  placeFragment,
  selectionBounds,
  stickiesFromText,
  plainText,
  type Fragment,
  type Point,
} from '@weldsuite/board-engine';
import type { BoardController } from './board-controller';
import { insertText, selectedText } from './text-editing';

const MARKER = 'data-weldboard-fragment';

function readable(c: BoardController, ids: Iterable<string>): string {
  const lines: string[] = [];
  for (const id of ids) {
    const el = c.board.get(id);
    if (!el) continue;
    const t = plainText(el.text) || el.name || el.title || '';
    if (t) lines.push(t);
  }
  return lines.join('\n');
}

export function encodeClipboard(c: BoardController): { text: string; html: string } | null {
  if (c.editing) {
    const sel = selectedText(c);
    return sel ? { text: sel.text, html: '' } : null;
  }
  if (!c.selection.size) return null;
  const fragment = makeFragment(c.board, c.selection);
  const text = readable(c, c.selection);
  const html = `<span ${MARKER}="${encodeURIComponent(fragmentToText(fragment))}">${escapeHtml(text).replace(/\n/g, '<br>')}</span>`;
  return { text, html };
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function fragmentFromHtml(html: string): Fragment | null {
  const m = new RegExp(`${MARKER}="([^"]+)"`).exec(html);
  if (!m) return null;
  try {
    return fragmentFromText(decodeURIComponent(m[1]!));
  } catch {
    return null;
  }
}

/** Puts a fragment on the board centred on `at`, selecting what was pasted. */
export function pasteFragment(c: BoardController, fragment: Fragment, at: Point): void {
  const placed = placeFragment(c.board, fragment, {
    x: Math.round(at.x - fragment.width / 2),
    y: Math.round(at.y - fragment.height / 2),
    createdBy: c.options.userId,
    now: Date.now(),
  });
  c.apply(placed.op, { select: placed.ids });
}

/** Pastes plain text: into the text being edited, or as a text box (one line) or sticky notes (several). */
export function pasteText(c: BoardController, text: string, at: Point): void {
  if (c.editing) {
    insertText(c, text);
    return;
  }
  const trimmed = text.trim();
  if (!trimmed) return;
  const fragment = fragmentFromText(trimmed);
  if (fragment) {
    pasteFragment(c, fragment, at);
    return;
  }
  const lines = trimmed.split(/\r?\n/).filter((l) => l.trim());
  if (lines.length > 1 || trimmed.includes('\t')) {
    pasteFragment(c, stickiesFromText(trimmed, () => `p${Math.random().toString(36).slice(2, 12)}`), at);
    return;
  }
  const order = c.board.topOrder(null);
  const el = trimmed.length > 60 ? makeSticky(at.x - 100, at.y - 100, { after: order, createdBy: c.options.userId, now: Date.now() }, { text: trimmed }) : makeText(at.x - 140, at.y - 16, trimmed, { after: order, createdBy: c.options.userId, now: Date.now() });
  c.apply({ type: 'create', elements: [el] }, { select: [el.id] });
}

/** Cut: copy, then delete what was copied. */
export function cutSelection(c: BoardController): void {
  if (c.editing) return;
  c.apply(deleteOps(c.board, c.selection), { select: [] });
}

/** Duplicates the selection next to itself. */
export function duplicateSelection(c: BoardController): void {
  if (!c.selection.size || c.readOnly) return;
  const b = selectionBounds(c.board, c.selection);
  if (!b) return;
  const fragment = makeFragment(c.board, c.selection);
  const placed = placeFragment(c.board, fragment, { x: b.x + 24, y: b.y + 24, createdBy: c.options.userId, now: Date.now() });
  c.apply(placed.op, { select: placed.ids });
}
