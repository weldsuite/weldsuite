export interface AnchorRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface Size {
  width: number;
  height: number;
}

export type PopoverSide = 'left' | 'right' | 'below' | 'above';

function clamp(value: number, min: number, max: number): number {
  // A card taller / wider than the viewport pins to the top-left margin.
  return Math.max(min, Math.min(value, max));
}

/**
 * Viewport position (top-left corner, for a `position: fixed` card) next to an
 * anchor element, kept fully inside the viewport and never on top of the anchor.
 *
 * The first side in `order` with room wins: `left` / `right` align the card's
 * top with the anchor's top, `below` / `above` align its right edge (`align:
 * 'end'`) or left edge (`'start'`) with the anchor's. When no side has room the
 * card goes below the anchor, shifted up as far as the viewport allows.
 */
export function placeCardNearAnchor(opts: {
  anchor: AnchorRect;
  card: Size;
  viewport: Size;
  order?: PopoverSide[];
  align?: 'start' | 'end';
  gap?: number;
  margin?: number;
}): { x: number; y: number } {
  const { anchor, card, viewport, order = ['left', 'right', 'below', 'above'], align = 'start', gap = 8, margin = 8 } = opts;
  const maxX = viewport.width - card.width - margin;
  const maxY = viewport.height - card.height - margin;
  const alignedX = clamp(align === 'end' ? anchor.right - card.width : anchor.left, margin, maxX);
  const sideY = clamp(anchor.top, margin, maxY);

  for (const side of order) {
    if (side === 'left') {
      const x = anchor.left - card.width - gap;
      if (x >= margin) return { x, y: sideY };
    } else if (side === 'right') {
      const x = anchor.right + gap;
      if (x <= maxX) return { x, y: sideY };
    } else if (side === 'below') {
      const y = anchor.bottom + gap;
      if (y <= maxY) return { x: alignedX, y };
    } else {
      const y = anchor.top - gap - card.height;
      if (y >= margin) return { x: alignedX, y };
    }
  }
  return { x: alignedX, y: clamp(anchor.bottom + gap, margin, maxY) };
}
