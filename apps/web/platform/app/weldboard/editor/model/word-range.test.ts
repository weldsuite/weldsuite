import { describe, expect, it } from 'vitest';
import { wordRangeAt } from './text-editing';

describe('wordRangeAt (double-click in board text)', () => {
  const text = 'Hello big world.';

  it('selects the word the position is in', () => {
    expect(wordRangeAt(text, 1)).toEqual({ from: 0, to: 5 });
    expect(wordRangeAt(text, 7)).toEqual({ from: 6, to: 9 });
  });

  it("takes the word whose end the position is at, not the space after it", () => {
    expect(wordRangeAt(text, 5)).toEqual({ from: 0, to: 5 });
    expect(wordRangeAt(text, 15)).toEqual({ from: 10, to: 15 });
  });

  it('selects the whole of a single-word text', () => {
    expect(wordRangeAt('ertherrtje', 4)).toEqual({ from: 0, to: 10 });
    expect(wordRangeAt('ertherrtje', 10)).toEqual({ from: 0, to: 10 });
  });

  it('selects nothing in empty text', () => {
    expect(wordRangeAt('', 0)).toEqual({ from: 0, to: 0 });
  });
});
