import { describe, expect, it } from 'vitest';
import { stackCards } from './margin-cards';

const tops = (m: Map<string, number>) => Object.fromEntries(m);

describe('stackCards', () => {
  it('puts each card level with its text when there is room', () => {
    const m = stackCards(
      [
        { id: 'a', want: 100, height: 50 },
        { id: 'b', want: 300, height: 50 },
      ],
      null,
    );
    expect(tops(m)).toEqual({ a: 100, b: 300 });
  });

  it('pushes a card down below the one above it', () => {
    const m = stackCards(
      [
        { id: 'a', want: 100, height: 80 },
        { id: 'b', want: 120, height: 50 },
        { id: 'c', want: 150, height: 50 },
      ],
      null,
    );
    expect(tops(m)).toEqual({ a: 100, b: 188, c: 246 });
  });

  it('puts the picked card at its text and moves the ones above it up', () => {
    const m = stackCards(
      [
        { id: 'a', want: 100, height: 80 },
        { id: 'b', want: 120, height: 50 },
        { id: 'c', want: 300, height: 50 },
      ],
      'b',
    );
    expect(tops(m)).toEqual({ a: 32, b: 120, c: 300 });
  });

  it('keeps the cards below the picked one clear of it', () => {
    const m = stackCards(
      [
        { id: 'a', want: 100, height: 80 },
        { id: 'b', want: 120, height: 100 },
        { id: 'c', want: 150, height: 50 },
      ],
      'b',
    );
    expect(m.get('b')).toBe(120);
    expect(m.get('c')).toBe(228);
    expect(m.get('a')).toBe(32);
  });

  it('follows the card before for a card whose text is gone', () => {
    const m = stackCards(
      [
        { id: 'a', want: 100, height: 50 },
        { id: 'gone', want: null, height: 40 },
      ],
      null,
    );
    expect(tops(m)).toEqual({ a: 100, gone: 158 });
  });

  it('leaves the layout alone when the picked card has no place in the text', () => {
    const m = stackCards(
      [
        { id: 'a', want: 100, height: 50 },
        { id: 'gone', want: null, height: 40 },
      ],
      'gone',
    );
    expect(tops(m)).toEqual({ a: 100, gone: 158 });
  });
});
