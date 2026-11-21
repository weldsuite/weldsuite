import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useScrollEdgeFade } from './use-scroll-edge-fade';

function List({ attach = true }: Readonly<{ attach?: boolean }>) {
  const ref = useScrollEdgeFade<HTMLDivElement>();
  return (
    <div ref={attach ? ref : undefined} data-testid="list">
      <span>first</span>
    </div>
  );
}

/** jsdom has no layout: give the list a size and a scroll position by hand. */
function setScroll(el: HTMLElement, metrics: { scrollTop: number; clientHeight: number; scrollHeight: number }) {
  for (const [key, value] of Object.entries(metrics)) {
    Object.defineProperty(el, key, { value, configurable: true });
  }
}

afterEach(cleanup);

describe('useScrollEdgeFade', () => {
  it('marks no edge while everything fits', () => {
    render(<List />);
    const list = screen.getByTestId('list');

    expect(list).not.toHaveAttribute('data-fade-top');
    expect(list).not.toHaveAttribute('data-fade-bottom');
  });

  it('marks the edges that have content scrolled out of view', () => {
    render(<List />);
    const list = screen.getByTestId('list');

    setScroll(list, { scrollTop: 0, clientHeight: 100, scrollHeight: 300 });
    fireEvent.scroll(list);
    expect(list).not.toHaveAttribute('data-fade-top');
    expect(list).toHaveAttribute('data-fade-bottom');

    setScroll(list, { scrollTop: 100, clientHeight: 100, scrollHeight: 300 });
    fireEvent.scroll(list);
    expect(list).toHaveAttribute('data-fade-top');
    expect(list).toHaveAttribute('data-fade-bottom');

    setScroll(list, { scrollTop: 200, clientHeight: 100, scrollHeight: 300 });
    fireEvent.scroll(list);
    expect(list).toHaveAttribute('data-fade-top');
    expect(list).not.toHaveAttribute('data-fade-bottom');
  });

  it('checks again when items are added to the list', async () => {
    render(<List />);
    const list = screen.getByTestId('list');

    setScroll(list, { scrollTop: 0, clientHeight: 100, scrollHeight: 300 });
    list.append(document.createElement('span'));

    await waitFor(() => expect(list).toHaveAttribute('data-fade-bottom'));
  });

  it('stops listening once unmounted', () => {
    const { unmount } = render(<List />);
    const list = screen.getByTestId('list');
    unmount();

    setScroll(list, { scrollTop: 0, clientHeight: 100, scrollHeight: 300 });
    fireEvent.scroll(list);
    expect(list).not.toHaveAttribute('data-fade-bottom');
  });

  it('does nothing when the ref is not attached', () => {
    render(<List attach={false} />);
    expect(screen.getByTestId('list')).not.toHaveAttribute('data-fade-bottom');
  });
});
