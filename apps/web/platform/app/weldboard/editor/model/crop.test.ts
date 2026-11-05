import { describe, expect, it } from 'vitest';
import { croppedHeight, dragCrop, FULL_CROP, MIN_CROP } from './crop';

describe('crop box', () => {
  it('moves inside the image', () => {
    const half = { x: 0.25, y: 0.25, w: 0.5, h: 0.5 };
    expect(dragCrop(half, 'move', 0.1, -0.1)).toEqual({ x: 0.35, y: 0.15, w: 0.5, h: 0.5 });
    expect(dragCrop(half, 'move', 1, 1)).toEqual({ x: 0.5, y: 0.5, w: 0.5, h: 0.5 });
  });

  it('resizes by a corner, never past the image or below the smallest size', () => {
    expect(dragCrop(FULL_CROP, 'nw', 0.2, 0.1)).toEqual({ x: 0.2, y: 0.1, w: 0.8, h: 0.9 });
    expect(dragCrop(FULL_CROP, 'se', -2, -2)).toMatchObject({ w: MIN_CROP, h: MIN_CROP });
    expect(dragCrop(FULL_CROP, 'ne', 0.5, -0.5)).toEqual(FULL_CROP);
  });

  it('keeps the kept part in proportion', () => {
    // The left half of a 400×200 image is square.
    expect(croppedHeight(300, { x: 0, y: 0, w: 0.5, h: 1 }, { w: 400, h: 200 })).toBe(300);
    expect(croppedHeight(300, FULL_CROP, { w: 400, h: 200 })).toBe(150);
  });
});
