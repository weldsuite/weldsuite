import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { LINK_OPEN_DELAY_MS, UrlLink, toHref } from './url-link';

describe('toHref', () => {
  it('keeps an http(s) address as it is', () => {
    expect(toHref('https://example.com/a?b=1')).toBe('https://example.com/a?b=1');
    expect(toHref('http://example.com')).toBe('http://example.com');
  });

  it('adds https to a bare domain', () => {
    expect(toHref('  example.com ')).toBe('https://example.com');
  });

  it('refuses other schemes and non-addresses', () => {
    expect(toHref('javascript:alert(1)')).toBeNull();
    expect(toHref('mailto:someone@example.com')).toBeNull();
    expect(toHref('not a link')).toBeNull();
    expect(toHref('   ')).toBeNull();
  });
});

describe('UrlLink', () => {
  let open: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    open = vi.fn();
    vi.stubGlobal('open', open);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  const renderLink = (onEdit = vi.fn(), onCellClick = vi.fn()) => {
    const { unmount } = render(
      <div role="presentation" onClick={onCellClick}>
        <UrlLink href="https://example.com" onEdit={onEdit}>
          https://example.com
        </UrlLink>
      </div>,
    );
    return { link: screen.getByRole('link'), onEdit, onCellClick, unmount };
  };

  it('opens the link in a new tab on a single click, after the double-click wait', () => {
    const { link, onEdit, onCellClick } = renderLink();

    fireEvent.click(link, { detail: 1 });
    expect(open).not.toHaveBeenCalled();

    vi.advanceTimersByTime(LINK_OPEN_DELAY_MS);
    expect(open).toHaveBeenCalledTimes(1);
    expect(open).toHaveBeenCalledWith('https://example.com', '_blank', 'noopener,noreferrer');
    expect(onEdit).not.toHaveBeenCalled();
    // The click must not reach the cell, which would start editing.
    expect(onCellClick).not.toHaveBeenCalled();
  });

  it('edits on a double click and does not open the link', () => {
    const { link, onEdit } = renderLink();

    fireEvent.click(link, { detail: 1 });
    fireEvent.click(link, { detail: 2 });
    vi.advanceTimersByTime(LINK_OPEN_DELAY_MS * 4);

    expect(onEdit).toHaveBeenCalledTimes(1);
    expect(open).not.toHaveBeenCalled();
  });

  it('leaves a Cmd/Ctrl click to the browser', () => {
    const { link, onEdit } = renderLink();

    const notPrevented = fireEvent.click(link, { detail: 1, metaKey: true });
    vi.advanceTimersByTime(LINK_OPEN_DELAY_MS * 4);

    expect(notPrevented).toBe(true);
    expect(open).not.toHaveBeenCalled();
    expect(onEdit).not.toHaveBeenCalled();
  });

  it('does not open the link once the cell has unmounted', () => {
    const { link, unmount } = renderLink();

    fireEvent.click(link, { detail: 1 });
    unmount();
    vi.advanceTimersByTime(LINK_OPEN_DELAY_MS * 4);

    expect(open).not.toHaveBeenCalled();
  });
});
