import { describe, expect, it } from 'vitest';
import { colorFor } from './people';

describe('colorFor', () => {
  it('gives a person the same colour every time, from the palette', () => {
    expect(colorFor('alice')).toBe(colorFor('alice'));
    expect(colorFor('alice')).toMatch(/^#[0-9a-f]{6}$/);
    const colors = new Set(['alice', 'bob', 'carol', 'dave', 'erin', 'frank', 'grace', 'heidi'].map(colorFor));
    expect(colors.size).toBeGreaterThan(1);
    expect(colorFor('')).toMatch(/^#[0-9a-f]{6}$/);
  });
});
