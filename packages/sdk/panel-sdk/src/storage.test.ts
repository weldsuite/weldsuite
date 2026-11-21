import { afterEach, describe, expect, it, vi } from 'vitest';
import { nextSeq, resetSeqMemory } from './storage';

afterEach(() => {
  vi.unstubAllGlobals();
  resetSeqMemory();
});

describe('nextSeq', () => {
  it('counts across calls with working storage', () => {
    localStorage.clear();
    expect([nextSeq('wpk_a', 'ses_1'), nextSeq('wpk_a', 'ses_1'), nextSeq('wpk_a', 'ses_1')]).toEqual([0, 1, 2]);
  });

  it('never repeats a number when storage throws', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('denied');
      },
    });
    expect([nextSeq('wpk_b', 'ses_1'), nextSeq('wpk_b', 'ses_1'), nextSeq('wpk_b', 'ses_1')]).toEqual([0, 1, 2]);
  });

  it('starts again at 0 for a new session', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => null,
      setItem: () => {
        throw new Error('denied');
      },
    });
    nextSeq('wpk_c', 'ses_1');
    expect(nextSeq('wpk_c', 'ses_2')).toBe(0);
  });

  it('uses the larger of the stored and the in-memory count', () => {
    localStorage.clear();
    nextSeq('wpk_d', 'ses_1');
    localStorage.setItem('weldpanel:wpk_d:rec', JSON.stringify({ s: 'ses_1', r: 1, q: 5 }));
    expect(nextSeq('wpk_d', 'ses_1')).toBe(5);
  });
});
