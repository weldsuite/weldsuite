import { readingOrderIds, type BoardElement } from '@weldsuite/board-engine';
import type { BoardController } from './board-controller';

/** Pans (never zooms) so the element is in view, when it is not already. */
export function revealElement(c: BoardController, el: BoardElement): void {
  const v = c.visible();
  const inside = el.x >= v.x && el.y >= v.y && el.x + el.w <= v.x + v.w && el.y + el.h <= v.y + v.h;
  if (inside) return;
  const zoom = c.camera.zoom;
  c.setCamera({ zoom, x: el.x + el.w / 2 - c.viewport.width / (2 * zoom), y: el.y + el.h / 2 - c.viewport.height / (2 * zoom) }, true);
}

/**
 * Tab and Shift+Tab: select the next (or previous) element in reading order,
 * frames before what they hold, then rows top to bottom. Past the last (or
 * before the first) the selection clears and the key is not handled, so the
 * browser moves focus out of the board: the canvas never traps keyboard users.
 */
export function focusStep(c: BoardController, dir: 1 | -1): boolean {
  const order = readingOrderIds(c.board);
  if (!order.length) return false;
  const current = c.selection.size === 1 ? order.indexOf([...c.selection][0]!) : -1;
  const next = current === -1 ? (dir === 1 ? 0 : order.length - 1) : current + dir;
  if (next < 0 || next >= order.length) {
    c.select([]);
    return false;
  }
  const el = c.board.get(order[next]!)!;
  c.select([el.id]);
  revealElement(c, el);
  return true;
}
