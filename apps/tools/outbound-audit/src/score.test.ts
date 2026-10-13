import { describe, expect, it } from 'vitest';
import { suspicionScore } from './score';

const base = { volume: 1_000, firstContactShare: 0.9, topTemplateReach: 500, flaggedShare: 0.5, bounceShare: null };

describe('suspicionScore', () => {
  it('is 0 for a workspace that only answers people who wrote in, whatever the volume', () => {
    expect(suspicionScore({ ...base, volume: 50_000, firstContactShare: 0 }).score).toBe(0);
  });

  it('is 0 without any volume', () => {
    expect(suspicionScore({ volume: 0, firstContactShare: null, topTemplateReach: 0, flaggedShare: null, bounceShare: null })).toMatchObject({
      score: 0,
      firstContactAssumed: false,
    });
  });

  it('multiplies volume, first-contact share, template reach, content and bounces', () => {
    const result = suspicionScore(base);
    const expected = 10 * Math.log10(1_001) * 0.9 * (1 + Math.log10(501)) * 1.5;
    expect(result.score).toBeCloseTo(expected, 1);
    expect(result.factors).toEqual({ volume: 3, firstContact: 0.9, template: 3.7, content: 1.5, bounce: 1 });
  });

  it('ranks one template to many strangers above the same volume of varied mail', () => {
    const blast = suspicionScore({ ...base, topTemplateReach: 900 }).score;
    const varied = suspicionScore({ ...base, topTemplateReach: 2 }).score;
    expect(blast).toBeGreaterThan(varied * 2);
  });

  it('weighs bounces when Cloudflare data is present', () => {
    const clean = suspicionScore({ ...base, bounceShare: 0 });
    const bouncing = suspicionScore({ ...base, bounceShare: 0.2 });
    expect(clean.factors.bounce).toBe(1);
    expect(bouncing.factors.bounce).toBe(3);
    expect(bouncing.score).toBeCloseTo(clean.score * 3, 0);
  });

  it('assumes a 0.5 first-contact share when only WeldConnect sent (recipients unknown)', () => {
    const result = suspicionScore({ volume: 200, firstContactShare: null, topTemplateReach: 0, flaggedShare: null, bounceShare: null });
    expect(result.firstContactAssumed).toBe(true);
    expect(result.factors.firstContact).toBe(0.5);
    expect(result.score).toBeGreaterThan(0);
  });
});
