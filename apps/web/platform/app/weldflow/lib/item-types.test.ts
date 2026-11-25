import { describe, expect, it } from 'vitest';
import { isContainerType, itemTypeGlyph, itemTypeOf, parseQuickCreate } from './item-types';

describe('itemTypeOf', () => {
  it('reads the known types as they are', () => {
    expect(itemTypeOf('epic')).toBe('epic');
    expect(itemTypeOf('Bug')).toBe('bug');
    expect(itemTypeOf('spike')).toBe('spike');
  });

  it('maps old and unknown values onto the closest type', () => {
    expect(itemTypeOf('improvement')).toBe('task');
    expect(itemTypeOf(null)).toBe('task');
    expect(itemTypeOf('pbi')).toBe('story');
    expect(itemTypeOf('feature', { featureLevel: false })).toBe('story');
    expect(itemTypeOf('feature', { featureLevel: true })).toBe('feature');
  });

  it('reads a task with a parent as a subtask', () => {
    expect(itemTypeOf('bug', { hasParent: true })).toBe('subtask');
  });
});

describe('itemTypeGlyph', () => {
  it('letters a story by the project naming', () => {
    expect(itemTypeGlyph('story', 'pbi')).toBe('P');
    expect(itemTypeGlyph('story', 'story')).toBe('U');
    expect(itemTypeGlyph('epic', 'pbi')).toBe('E');
  });
});

describe('isContainerType', () => {
  it('holds items for epics and features only', () => {
    expect(isContainerType('epic')).toBe(true);
    expect(isContainerType('feature')).toBe(true);
    expect(isContainerType('story')).toBe(false);
  });
});

describe('parseQuickCreate', () => {
  it('splits a known prefix off the title', () => {
    expect(parseQuickCreate('/bug Login fails on Safari')).toEqual({ type: 'bug', title: 'Login fails on Safari' });
    expect(parseQuickCreate('/PBI Export to CSV')).toEqual({ type: 'story', title: 'Export to CSV' });
  });

  it('keeps an unknown prefix in the title', () => {
    expect(parseQuickCreate('/later fix this')).toEqual({ type: null, title: '/later fix this' });
    expect(parseQuickCreate('  Plain title ')).toEqual({ type: null, title: 'Plain title' });
  });
});
