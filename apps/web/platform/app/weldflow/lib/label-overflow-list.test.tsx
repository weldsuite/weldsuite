import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render } from '@testing-library/react';
import { LabelOverflowList } from './label-overflow-list';

describe('LabelOverflowList', () => {
  let resizeObserverCb: ResizeObserverCallback | null = null;

  beforeEach(() => {
    resizeObserverCb = null;
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(cb: ResizeObserverCallback) {
          resizeObserverCb = cb;
        }
        observe() {}
        disconnect() {}
        unobserve() {}
      },
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('does not grow to fill the row (leaves space for the task title)', () => {
    const { container } = render(
      <LabelOverflowList
        labels={[
          { id: '1', name: 'Design', color: '#3b82f6' },
          { id: '2', name: 'Backend', color: '#22c55e' },
          { id: '3', name: 'Urgent', color: '#ef4444' },
        ]}
      />,
    );

    const root = container.firstElementChild as HTMLElement;
    expect(root.className).toContain('max-w-[40%]');
    expect(root.className.split(/\s+/)).toContain('shrink');
    expect(root.className.split(/\s+/)).not.toContain('flex-1');
    // ResizeObserver was wired so overflow measurement still runs.
    expect(resizeObserverCb).not.toBeNull();
  });

  it('allows callers to override the default sizing classes', () => {
    const { container } = render(
      <LabelOverflowList
        className="flex-none max-w-[180px]"
        labels={[{ id: '1', name: 'Design', color: '#3b82f6' }]}
      />,
    );

    const root = container.firstElementChild as HTMLElement;
    expect(root.className.split(/\s+/)).toContain('flex-none');
    expect(root.className).toContain('max-w-[180px]');
  });
});
