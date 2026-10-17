import { describe, expect, it } from 'vitest';
import { MAX_SCALE, MIN_SCALE, PHONE, SCREEN, crispScale } from './phone';

const whole = (x: number) => Math.abs(x - Math.round(x)) < 1e-6;
const onWholePixels = (scale: number, dpr: number) => whole(PHONE.width * scale * dpr) && whole(PHONE.height * scale * dpr);

describe('crispScale', () => {
  it('puts the whole frame on whole screen pixels, on Retina and at 1x', () => {
    for (const dpr of [1, 2, 3]) {
      for (let fit = 0.3; fit <= 1.2; fit += 0.01) {
        expect(onWholePixels(crispScale(fit, dpr), dpr)).toBe(true);
      }
    }
  });

  it('is as large as fits, up to a little under real size', () => {
    expect(crispScale(2, 2)).toBe(MAX_SCALE);
    expect(crispScale(0.8, 2)).toBe(0.75);
    expect(crispScale(0.86, 1)).toBe(0.75);
  });

  it('never gets unreadably small', () => {
    expect(crispScale(0.1, 2)).toBe(MIN_SCALE);
  });
});

describe('SCREEN', () => {
  it('fits the frame with even bezels and concentric corners', () => {
    const bezel = 1 + 19; // devices.css frame border + padding
    expect(SCREEN.width).toBe(PHONE.width - 2 * bezel);
    expect(SCREEN.height).toBe(PHONE.height - 2 * bezel);
    expect(SCREEN.radius).toBe(68 - bezel);
  });
});
