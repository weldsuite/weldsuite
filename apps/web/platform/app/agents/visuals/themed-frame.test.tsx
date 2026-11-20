import { afterEach, describe, expect, it } from 'vitest';
import { act, render, waitFor } from '@testing-library/react';
import { ThemedFrame } from './themed-frame';

function frameDoc(container: HTMLElement): Document {
  const frame = container.querySelector('iframe');
  if (!frame?.contentDocument) throw new Error('no frame document');
  return frame.contentDocument;
}

afterEach(() => {
  document.head.querySelectorAll('[data-test-style]').forEach((node) => node.remove());
  document.documentElement.className = '';
});

describe('ThemedFrame', () => {
  it('renders its children inside the frame, at the width asked for', async () => {
    const { container } = render(
      <ThemedFrame theme="light" width={375} title="Light 375px">
        <p>Inside the frame</p>
      </ThemedFrame>,
    );
    const frame = container.querySelector('iframe')!;
    expect(frame.title).toBe('Light 375px');
    expect(frame.style.width).toBe('375px');
    await waitFor(() => expect(frameDoc(container).body.textContent).toContain('Inside the frame'));
    // Not in the page itself.
    expect(container.textContent).not.toContain('Inside the frame');
  });

  it('takes the app root classes but its own theme', async () => {
    document.documentElement.className = 'dark font-sans';
    const { container, rerender } = render(
      <ThemedFrame theme="light" width={400} title="frame">
        <span />
      </ThemedFrame>,
    );
    await waitFor(() => expect(frameDoc(container).body.className).toContain('bg-background'));
    const root = frameDoc(container).documentElement;
    expect(root.classList.contains('font-sans')).toBe(true);
    expect(root.classList.contains('dark')).toBe(false);
    expect(root.style.overflow).toBe('hidden');

    rerender(
      <ThemedFrame theme="dark" width={400} title="frame">
        <span />
      </ThemedFrame>,
    );
    await waitFor(() => expect(frameDoc(container).documentElement.classList.contains('dark')).toBe(true));
    expect(frameDoc(container).documentElement.style.colorScheme).toBe('dark');
  });

  it('copies the app stylesheets in and follows changes to them', async () => {
    const style = document.createElement('style');
    style.setAttribute('data-test-style', '');
    style.textContent = '.a { color: red; }';
    document.head.append(style);

    const { container } = render(
      <ThemedFrame theme="light" width={400} title="frame">
        <span />
      </ThemedFrame>,
    );
    await waitFor(() => expect(frameDoc(container).head.innerHTML).toContain('.a { color: red; }'));

    await act(async () => {
      const later = document.createElement('style');
      later.setAttribute('data-test-style', '');
      later.textContent = '.b { color: blue; }';
      document.head.append(later);
    });
    await waitFor(() => expect(frameDoc(container).head.innerHTML).toContain('.b { color: blue; }'));
  });
});
