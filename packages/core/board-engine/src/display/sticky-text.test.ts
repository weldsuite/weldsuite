import { MetricsMeasurer } from '@weldsuite/docs-engine';
import { describe, expect, it } from 'vitest';
import { makeSticky } from '../model/defaults';
import { elementTextBox, elementTextLayout, STICKY_AUTHOR_SPACE, stickyHeightFor } from './display';

const measurer = new MetricsMeasurer();

describe('sticky note text', () => {
  it('keeps room for the author only while names are shown', () => {
    const sticky = { ...makeSticky(0, 0, {}, { text: 'Idea' }), createdBy: 'alice' };
    const hidden = elementTextBox(sticky, false)!;
    const shown = elementTextBox(sticky, true)!;
    expect(shown.h).toBe(hidden.h - STICKY_AUTHOR_SPACE);
    // Centred in the whole sticky when names are hidden.
    expect(hidden.y - sticky.y).toBeCloseTo(sticky.y + sticky.h - (hidden.y + hidden.h));
  });

  it('keeps no room for a name the sticky does not have', () => {
    const sticky = makeSticky(0, 0, {}, { text: 'Idea' });
    expect(elementTextBox(sticky, true)).toEqual(elementTextBox(sticky, false));
  });

  it('grows a sticky so its text fits at a bigger size, and never shrinks it', () => {
    const sticky = { ...makeSticky(0, 0, {}, { text: 'A longer sticky note that needs a few lines' }), fontSize: 48 };
    const options = { measurer, showAuthors: false };
    expect(elementTextLayout(sticky, options)!.layout.fontSize).toBeLessThan(48);

    const h = stickyHeightFor(sticky, 48, options);
    expect(h).toBeGreaterThan(sticky.h);
    expect(elementTextLayout({ ...sticky, h }, options)!.layout.fontSize).toBe(48);

    expect(stickyHeightFor({ ...sticky, text: makeSticky(0, 0, {}, { text: 'Hi' }).text }, 22, options)).toBe(sticky.h);
  });

  it('shrinks a word too wide for the sticky rather than splitting it, and grows only for the size it gets', () => {
    const sticky = { ...makeSticky(0, 0, {}, { text: 'Internationalisation plan' }), fontSize: 48 };
    const options = { measurer, showAuthors: false };
    const grown = { ...sticky, h: stickyHeightFor(sticky, 48, options) };
    const { layout } = elementTextLayout(grown, options)!;
    expect(layout.fontSize).toBeLessThan(48);
    const firstLine = layout.lines[0]!;
    expect(grown.text!.text.slice(firstLine.start, firstLine.end).trim()).toBe('Internationalisation');
    // The shrunk text fits the square, so it doesn't grow for a size the text can't get.
    expect(grown.h).toBe(sticky.h);
  });
});
