import { afterEach, describe, expect, it, vi } from 'vitest';
import { OTP_REJECTION_LIMIT, randomOtp } from './portal-tokens';

/** A random source that hands out the given values in order. */
function sequence(...values: number[]) {
  let i = 0;
  return (buffer: Uint32Array) => {
    buffer[0] = values[i++] ?? 0;
  };
}

describe('randomOtp', () => {
  afterEach(() => vi.restoreAllMocks());

  it('is always six digits, zero padded', () => {
    for (let i = 0; i < 2_000; i++) expect(randomOtp()).toMatch(/^\d{6}$/);
  });

  it('draws from the platform CSPRNG by default', () => {
    const spy = vi.spyOn(crypto, 'getRandomValues');
    randomOtp();
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('maps a draw to its remainder mod 10^6', () => {
    expect(randomOtp(sequence(0))).toBe('000000');
    expect(randomOtp(sequence(7))).toBe('000007');
    expect(randomOtp(sequence(1_000_000))).toBe('000000');
    expect(randomOtp(sequence(123_456_789))).toBe('456789');
    expect(randomOtp(sequence(OTP_REJECTION_LIMIT - 1))).toBe('999999');
  });

  it('rejects the draws that would bias the result and draws again', () => {
    // 2^32 is not a multiple of 10^6: the last 967296 draws would favour codes 000000-967295.
    expect(OTP_REJECTION_LIMIT % 1_000_000).toBe(0);
    expect(2 ** 32 - OTP_REJECTION_LIMIT).toBeLessThan(1_000_000);
    expect(2 ** 32 - OTP_REJECTION_LIMIT).toBe(967_296);

    const fill = vi.fn(sequence(OTP_REJECTION_LIMIT, 2 ** 32 - 1, 4_294_000_001, 42));
    expect(randomOtp(fill)).toBe('000042');
    expect(fill).toHaveBeenCalledTimes(4);
  });

  it('gives every code exactly the same number of accepted draws', () => {
    // Accepted draws are 0 .. LIMIT-1, an exact multiple of 10^6, so each
    // residue is hit LIMIT / 10^6 times: no code is more likely than another.
    const perCode = OTP_REJECTION_LIMIT / 1_000_000;
    expect(Number.isInteger(perCode)).toBe(true);
    expect(perCode).toBe(4_294);
    // Spot-check the two ends of the residue range and the boundary.
    const firstDraw = (code: number) => code; // smallest draw with this residue
    const lastDraw = (code: number) => code + (perCode - 1) * 1_000_000; // largest accepted draw with this residue
    for (const code of [0, 1, 967_295, 967_296, 999_999]) {
      expect(lastDraw(code)).toBeLessThan(OTP_REJECTION_LIMIT);
      expect(lastDraw(code) + 1_000_000).toBeGreaterThanOrEqual(OTP_REJECTION_LIMIT);
      expect(randomOtp(sequence(firstDraw(code)))).toBe(String(code).padStart(6, '0'));
      expect(randomOtp(sequence(lastDraw(code)))).toBe(String(code).padStart(6, '0'));
    }
  });

  it('gives up instead of looping forever when the random source is broken', () => {
    const stuck = (buffer: Uint32Array) => {
      buffer[0] = 2 ** 32 - 1;
    };
    expect(() => randomOtp(stuck)).toThrow('Random source');
  });
});
