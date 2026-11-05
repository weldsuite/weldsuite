/**
 * Copy style and paste style (the style painter): the look of the selected
 * element is kept on the controller, and put on whatever is selected later.
 * Ctrl/Cmd+Alt+C copies, Ctrl/Cmd+Alt+P pastes; the context toolbar has both.
 */

import { isNoop, pasteStyleOps, styleOf } from '@weldsuite/board-engine';
import type { BoardController } from './board-controller';

/** Keeps the first selected element's style; false when nothing is selected. */
export function copyStyle(c: BoardController): boolean {
  const first = c.selected[0];
  if (!first) return false;
  c.copiedStyle = styleOf(first);
  c.changed();
  return true;
}

/** Puts the kept style on the selection; false when there is none to put, or nothing changed. */
export function pasteStyle(c: BoardController): boolean {
  if (!c.copiedStyle || c.readOnly || c.selection.size === 0) return false;
  const op = pasteStyleOps(c.board, c.selection, c.copiedStyle);
  if (isNoop(op)) return false;
  return c.apply(op);
}
