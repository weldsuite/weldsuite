import { describe, expect, it } from 'vitest';
import { colorFor, newTabId } from './people';

describe('colorFor', () => {
  it('gives a person the same colour every time, from the palette', () => {
    expect(colorFor('alice')).toBe(colorFor('alice'));
    expect(colorFor('alice')).toMatch(/^#[0-9a-f]{6}$/);
    const colors = new Set(['alice', 'bob', 'carol', 'dave', 'erin', 'frank', 'grace', 'heidi'].map(colorFor));
    expect(colors.size).toBeGreaterThan(1);
  });
});

describe('newTabId', () => {
  it('makes tab ids in the editor’s format, a new one each time', () => {
    const id = newTabId();
    expect(id).toMatch(/^sh_[0-9a-f]{16}$/);
    expect(newTabId()).not.toBe(id);
  });
});
