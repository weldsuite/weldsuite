import { describe, expect, it } from 'vitest';
import type { DisplayItem } from '@weldsuite/docs-engine';
import { linkLabel, normalizeLink } from './link-popover';
import { shortcutLabel, splitShortcut } from './model/keyboard';
import { drawnIndents } from './ruler';
import { inkFor, splitHeaderItems } from './view/page-view';

describe('shortcutLabel', () => {
  it('writes shortcuts the Mac way, with ⌘ ⌥ ⇧ and no plus signs', () => {
    expect(shortcutLabel('Undo (Ctrl+Z)', true)).toBe('Undo (⌘Z)');
    expect(shortcutLabel('Add comment (Ctrl+Alt+M)', true)).toBe('Add comment (⌘⌥M)');
    expect(shortcutLabel('Strikethrough (Alt+Shift+5)', true)).toBe('Strikethrough (⌥⇧5)');
    expect(shortcutLabel('Left align (Ctrl+Shift+L)', true)).toBe('Left align (⌘⇧L)');
    // A label built with ⌘ already reads the same.
    expect(shortcutLabel('⌘+Alt+0', true)).toBe('⌘⌥0');
    expect(shortcutLabel('Shift+Enter', true)).toBe('⇧Enter');
    // A plus key stays.
    expect(shortcutLabel('Ctrl++', true)).toBe('⌘+');
  });

  it('leaves labels alone elsewhere', () => {
    expect(shortcutLabel('Undo (Ctrl+Z)', false)).toBe('Undo (Ctrl+Z)');
    expect(shortcutLabel('Add comment (Ctrl+Alt+M)', false)).toBe('Add comment (Ctrl+Alt+M)');
  });
});

describe('splitShortcut', () => {
  it('takes the shortcut out of a name, for a menu that shows it at the right', () => {
    expect(splitShortcut('Left align (Ctrl+Shift+L)')).toEqual({ name: 'Left align', shortcut: 'Ctrl+Shift+L' });
    expect(splitShortcut('Strikethrough (Alt+Shift+5)')).toEqual({ name: 'Strikethrough', shortcut: 'Alt+Shift+5' });
  });

  it('keeps a name without a shortcut, or with other words in brackets, whole', () => {
    expect(splitShortcut('Single')).toEqual({ name: 'Single' });
    expect(splitShortcut('Heading (large)')).toEqual({ name: 'Heading (large)' });
  });
});

describe('inkFor', () => {
  it('draws the caret black on a white page, whatever the app theme', () => {
    expect(inkFor('#ffffff')).toBe('#000000');
    expect(inkFor('#fff')).toBe('#000000');
  });

  it('draws it white on a dark page', () => {
    expect(inkFor('#1f2937')).toBe('#ffffff');
    expect(inkFor('#000')).toBe('#ffffff');
  });

  it('treats a colour that is not a hex code as light', () => {
    expect(inkFor('white')).toBe('#000000');
  });
});

describe('drawnIndents', () => {
  it('puts the markers where the text is drawn: an indent into the margin is drawn at the margin', () => {
    expect(drawnIndents({ indentLeft: -113.39, indentRight: -10 })).toEqual({ left: 0, first: 0, right: 0 });
    expect(drawnIndents({ indentLeft: 92.13, indentFirst: -85.04, indentRight: 55.56 })).toEqual({ left: 92.13, first: 92.13 - 85.04, right: 55.56 });
    expect(drawnIndents({ indentLeft: 20, indentFirst: -36 })).toEqual({ left: 20, first: 0, right: 0 });
  });

  it('places a list item by its list level, the first line at the bullet', () => {
    expect(drawnIndents({ indentLeft: 200, list: { id: 'l', level: 0 } }, { indent: 36, hanging: 18 })).toEqual({ left: 36, first: 18, right: 0 });
  });
});

describe('links', () => {
  it('turns what people type into a link target', () => {
    expect(normalizeLink('example.com')).toBe('https://example.com');
    expect(normalizeLink('ann@example.com')).toBe('mailto:ann@example.com');
    expect(normalizeLink('+31 20 123 4567')).toBe('tel:+31201234567');
    expect(normalizeLink('#heading')).toBe('#heading');
    expect(normalizeLink('not a link')).toBeNull();
  });

  it('shows an address without its scheme', () => {
    expect(linkLabel('https://example.com/a')).toBe('example.com/a');
    expect(linkLabel('mailto:ann@example.com')).toBe('ann@example.com');
  });
});

describe('splitHeaderItems', () => {
  it('keeps the header and footer being edited apart from the faded page text', () => {
    const text = (story: string) => ({ kind: 'text', story, text: story }) as unknown as DisplayItem;
    const rule = { kind: 'line' } as unknown as DisplayItem;
    const { area, rest } = splitHeaderItems([text('body'), text('hdr:final:default'), rule, text('ftr:final:default')]);
    expect(area.map((i) => (i as { story: string }).story)).toEqual(['hdr:final:default', 'ftr:final:default']);
    expect(rest).toHaveLength(2);
  });
});
