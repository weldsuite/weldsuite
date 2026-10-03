import { describe, it, expect } from 'vitest';
import { placeCardNearAnchor } from './popover-position';

const viewport = { width: 1440, height: 900 };
const card = { width: 360, height: 420 };

describe('placeCardNearAnchor', () => {
  it('goes left of the anchor with its top aligned when there is room', () => {
    const anchor = { left: 900, top: 120, right: 1100, bottom: 160 };
    expect(placeCardNearAnchor({ anchor, card, viewport })).toEqual({ x: 900 - 360 - 8, y: 120 });
  });

  it('keeps the bottom of a tall card inside the viewport (Save stays visible)', () => {
    const anchor = { left: 900, top: 700, right: 1100, bottom: 740 };
    const pos = placeCardNearAnchor({ anchor, card, viewport });
    expect(pos.y + card.height).toBeLessThanOrEqual(viewport.height - 8);
    expect(pos.y).toBeGreaterThanOrEqual(8);
  });

  it('never covers the anchor: falls back below it when the left side is too narrow', () => {
    const anchor = { left: 100, top: 100, right: 300, bottom: 140 };
    const pos = placeCardNearAnchor({ anchor, card, viewport: { width: 500, height: 900 }, order: ['left', 'below'] });
    expect(pos.y).toBeGreaterThanOrEqual(anchor.bottom + 8);
    expect(pos.x).toBeGreaterThanOrEqual(8);
    expect(pos.x + card.width).toBeLessThanOrEqual(500 - 8);
  });

  it('opens below a toolbar button, right-aligned to it', () => {
    const anchor = { left: 1300, top: 10, right: 1420, bottom: 46 };
    const pos = placeCardNearAnchor({ anchor, card, viewport, order: ['below'], align: 'end' });
    expect(pos).toEqual({ x: 1420 - 360, y: 54 });
  });

  it('clamps horizontally inside the viewport', () => {
    const anchor = { left: 1300, top: 10, right: 1500, bottom: 46 };
    const pos = placeCardNearAnchor({ anchor, card, viewport, order: ['below'], align: 'end' });
    expect(pos.x + card.width).toBeLessThanOrEqual(viewport.width - 8);
  });

  it('flips above when there is no room below', () => {
    const anchor = { left: 600, top: 800, right: 800, bottom: 840 };
    const pos = placeCardNearAnchor({ anchor, card, viewport, order: ['below', 'above'] });
    expect(pos.y).toBe(800 - 8 - 420);
  });

  it('pins to the top margin when the card is taller than the viewport', () => {
    const pos = placeCardNearAnchor({
      anchor: { left: 600, top: 300, right: 800, bottom: 340 },
      card: { width: 360, height: 1200 },
      viewport,
    });
    expect(pos.y).toBe(8);
  });
});
