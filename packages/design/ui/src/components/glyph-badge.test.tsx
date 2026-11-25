import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { GLYPH_TONES, GlyphBadge } from './glyph-badge';

describe('GlyphBadge', () => {
  afterEach(cleanup);

  it('names the kind for screen readers and keeps the letter out of the accessible name', () => {
    render(<GlyphBadge glyph="E" tone="violet" label="Epic" />);
    const badge = screen.getByRole('img', { name: 'Epic' });
    expect(badge.getAttribute('title')).toBe('Epic');
    expect(badge.textContent).toBe('E');
    expect(badge.querySelector('[aria-hidden="true"]')?.textContent).toBe('E');
  });

  it('sizes medium by default and small on request', () => {
    const { rerender } = render(<GlyphBadge glyph="B" tone="red" label="Bug" />);
    expect(screen.getByRole('img').className).toContain('size-5');
    rerender(<GlyphBadge glyph="B" tone="red" label="Bug" size="sm" />);
    expect(screen.getByRole('img').className).toContain('size-4');
  });

  it('has a colour for every tone', () => {
    for (const tone of GLYPH_TONES) {
      render(<GlyphBadge glyph="X" tone={tone} label={tone} />);
      expect(screen.getByRole('img', { name: tone }).className).not.toBe('');
    }
    expect(screen.getByRole('img', { name: 'neutral' }).className).toContain('bg-muted');
  });

  it('passes extra classes and attributes on to the span', () => {
    render(<GlyphBadge glyph="T" tone="blue" label="Task" className="mt-1" data-testid="badge" />);
    expect(screen.getByTestId('badge').className).toContain('mt-1');
  });
});
