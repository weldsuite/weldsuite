import { describe, expect, it } from 'vitest';
import { clampBox, moveBox, placeField, resizeBox, scaleFor } from './geometry';

const A4 = { width: 595, height: 842 };

describe('WeldSign field geometry', () => {
  it('scales a page to its container, at most 2x', () => {
    expect(scaleFor(595, 1190)).toBe(2);
    expect(scaleFor(595, 595)).toBe(1);
    expect(scaleFor(595, 5000)).toBe(2);
    expect(scaleFor(0, 500)).toBe(1);
  });

  it('places a field centred on the drop point', () => {
    expect(placeField('signature', { x: 300, y: 400 }, A4)).toEqual({ x: 220, y: 376, width: 160, height: 48 });
  });

  it('keeps a dropped field on the page near an edge', () => {
    expect(placeField('signature', { x: 590, y: 840 }, A4)).toEqual({ x: 435, y: 794, width: 160, height: 48 });
    expect(placeField('checkbox', { x: 0, y: 0 }, A4)).toEqual({ x: 0, y: 0, width: 16, height: 16 });
  });

  it('moves by screen pixels at the current scale and stops at the page edge', () => {
    const box = { x: 100, y: 100, width: 160, height: 48 };
    expect(moveBox(box, 20, 40, 2, A4)).toEqual({ x: 110, y: 120, width: 160, height: 48 });
    expect(moveBox(box, 10_000, -10_000, 1, A4)).toEqual({ x: 435, y: 0, width: 160, height: 48 });
  });

  it('resizes from the corner, never below the minimum or past the page', () => {
    const box = { x: 500, y: 100, width: 60, height: 20 };
    expect(resizeBox(box, 20, 10, 1, A4)).toEqual({ x: 500, y: 100, width: 80, height: 30 });
    expect(resizeBox(box, 500, 0, 1, A4).width).toBe(95);
    expect(resizeBox(box, -500, -500, 1, A4)).toMatchObject({ width: 8, height: 8 });
  });

  it('clamps an oversize box to the page', () => {
    expect(clampBox({ x: -5, y: -5, width: 1000, height: 10 }, A4)).toEqual({ x: 0, y: 0, width: 595, height: 10 });
  });
});
