import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const reloadApp = vi.fn().mockResolvedValue(true);
let desktopApi: { reloadApp: typeof reloadApp } | null = null;

vi.mock('@/lib/desktop', () => ({
  getDesktop: () => desktopApi,
}));

vi.mock('@/lib/logger', () => ({
  log: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

vi.mock('@/lib/chunk-reload', () => ({
  isStaleChunkError: () => false,
  reloadForStaleChunk: () => false,
}));

import { RootErrorFallback, goHomeFromError } from './root-error-fallback';

describe('goHomeFromError', () => {
  const originalLocation = window.location;

  beforeEach(() => {
    vi.clearAllMocks();
    desktopApi = null;
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { ...originalLocation, assign: vi.fn() },
    });
  });

  afterEach(() => {
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: originalLocation,
    });
  });

  it('hard-navigates to / in the browser', () => {
    goHomeFromError();
    expect(window.location.assign).toHaveBeenCalledWith('/');
    expect(reloadApp).not.toHaveBeenCalled();
  });

  it('calls desktop reloadApp when running inside the shell', () => {
    desktopApi = { reloadApp };
    goHomeFromError();
    expect(reloadApp).toHaveBeenCalledTimes(1);
    expect(window.location.assign).not.toHaveBeenCalled();
  });
});

describe('RootErrorFallback', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    desktopApi = null;
  });

  it('renders escape actions and hard-navigates home on click', async () => {
    const user = userEvent.setup();
    const assign = vi.fn();
    const originalLocation = window.location;
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { ...originalLocation, assign },
    });

    render(
      <RootErrorFallback
        error={new Error('boom')}
        info={{ componentStack: '' }}
        reset={vi.fn()}
      />,
    );

    expect(screen.getByRole('heading', { name: /something went wrong/i })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /go home/i }));
    expect(assign).toHaveBeenCalledWith('/');

    Object.defineProperty(window, 'location', {
      configurable: true,
      value: originalLocation,
    });
  });
});
