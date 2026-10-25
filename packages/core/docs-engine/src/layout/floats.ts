/**
 * Floating images: an image with a wrap other than `inline` leaves the line
 * it is anchored in (its object character takes no width there) and sits at
 * an offset from its paragraph's top-left instead. Text then wraps beside it
 * (`square`), skips past it (`topBottom`), or ignores it (`behind`, `front`).
 *
 * Floats are local to their paragraph: a paragraph shorter than its floats
 * gets the difference as extra space after it, so the next paragraph starts
 * below them.
 */

import type { ImageObject, ObjectData } from '../model/objects';
import type { FloatLayout } from './types';

/** Space kept between a floating image and the text around it, points. */
export const FLOAT_GAP = 9;
/** Narrowest band of text kept beside a float; narrower, the line moves below it. */
const MIN_BAND = 36;

export function isFloating(obj: ObjectData): boolean {
  return obj.kind === 'image' && !!obj.wrap && obj.wrap !== 'inline';
}

/** Where a paragraph's floating images go, in the paragraph box (`width` wide). */
export function placeFloats(images: { offset: number; image: ImageObject }[], width: number): FloatLayout[] {
  return images.map(({ offset, image }) => {
    const w = Math.max(1, Math.min(image.width, width));
    const h = image.height * (w / image.width);
    const x = Math.max(0, Math.min(image.offsetX ?? 0, width - w));
    const wrap = image.wrap as FloatLayout['wrap'];
    const f: FloatLayout = { offset, image, wrap, x, y: Math.max(0, image.offsetY ?? 0), width: w, height: h };
    if (wrap === 'square') f.side = x + w / 2 > width / 2 ? 'right' : 'left';
    return f;
  });
}

/** Where a line starting at `top` may go: how far down it moves, and the band it may fill. */
export interface LineBand {
  pad: number;
  left: number;
  right: number;
}

export class FloatBands {
  private readonly blocking: FloatLayout[];

  constructor(
    floats: FloatLayout[],
    private readonly width: number,
  ) {
    this.blocking = floats.filter((f) => f.wrap === 'square' || f.wrap === 'topBottom');
  }

  /** Bottom of the lowest float text keeps clear of (0 without any). */
  get bottom(): number {
    let b = 0;
    for (const f of this.blocking) b = Math.max(b, f.y + f.height);
    return b;
  }

  at(top: number): LineBand {
    let y = top;
    // Each move can land beside another float; there are only so many.
    for (let pass = 0; pass <= this.blocking.length; pass++) {
      const band = this.bandAt(y);
      if (band.skipTo === null) return { pad: y - top, left: band.left, right: band.right };
      y = band.skipTo;
    }
    return { pad: y - top, left: 0, right: this.width };
  }

  private bandAt(y: number): { left: number; right: number; skipTo: number | null } {
    let left = 0;
    let right = this.width;
    let skipTo: number | null = null;
    for (const f of this.blocking) {
      const below = f.y + f.height + FLOAT_GAP;
      if (y >= below || y + 1 <= f.y) continue;
      if (f.wrap === 'topBottom') skipTo = Math.max(skipTo ?? 0, below);
      else if (f.side === 'left') left = Math.max(left, f.x + f.width + FLOAT_GAP);
      else right = Math.min(right, f.x - FLOAT_GAP);
    }
    if (skipTo === null && right - left < MIN_BAND && (left > 0 || right < this.width)) skipTo = this.nextClear(y);
    return { left, right, skipTo };
  }

  /** The nearest bottom (plus gap) of a float overlapping `y`. */
  private nextClear(y: number): number {
    let next = Infinity;
    for (const f of this.blocking) {
      const below = f.y + f.height + FLOAT_GAP;
      if (y < below && y + 1 > f.y) next = Math.min(next, below);
    }
    return next === Infinity ? y : next;
  }
}
