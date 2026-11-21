/**
 * A failed page renders inside the shell. A page missing after a redeploy
 * reloads into the new build, unless a call is live: then it waits.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('@/lib/i18n/provider', () => ({
  useI18n: () => ({
    t: {
      common: {
        actions: { back: 'Back' },
        rootError: {
          updating: 'Updating to the latest version…',
          title: 'Something went wrong',
          description: 'An unexpected error occurred.',
          tryAgain: 'Try again',
          goHome: 'Go home',
        },
        appUpdate: {
          title: 'WeldSuite has been updated',
          pageAfterCall: 'This page needs the new version.',
          reloadNow: 'Reload now',
        },
      },
    },
  }),
}));

const router = { history: { back: vi.fn() }, navigate: vi.fn() };
vi.mock('@tanstack/react-router', () => ({ useRouter: () => router }));

const logError = vi.fn();
vi.mock('@/lib/logger', () => ({
  log: { error: (...args: unknown[]) => logError(...args), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import { RouteErrorFallback } from './route-error-fallback';
import { holdStaleChunkReload } from '@/lib/chunk-reload';

const STALE = new TypeError('Failed to fetch dynamically imported module: https://app.weldsuite.org/assets/page-abc.js');
const originalLocation = window.location;
let reload: ReturnType<typeof vi.fn>;
let release: (() => void) | null = null;

beforeEach(() => {
  vi.clearAllMocks();
  sessionStorage.clear();
  reload = vi.fn();
  Object.defineProperty(window, 'location', { configurable: true, value: { ...originalLocation, reload } });
});

afterEach(() => {
  // Ending the call runs the waiting reload after a grace period: run it now,
  // while location.reload is still the mock.
  vi.useFakeTimers();
  release?.();
  release = null;
  vi.runAllTimers();
  vi.useRealTimers();
  Object.defineProperty(window, 'location', { configurable: true, value: originalLocation });
});

function renderFallback(error: Error, reset = vi.fn()) {
  render(<RouteErrorFallback error={error} info={{ componentStack: '' }} reset={reset} />);
  return reset;
}

describe('RouteErrorFallback', () => {
  it('reloads into the new build when no call is live', () => {
    renderFallback(STALE);
    expect(screen.getByText('Updating to the latest version…')).toBeInTheDocument();
    expect(reload).toHaveBeenCalledTimes(1);
    expect(logError).not.toHaveBeenCalled();
  });

  it('waits for the call to end, and offers to reload now', async () => {
    release = holdStaleChunkReload();
    await act(async () => {});
    renderFallback(STALE);

    expect(screen.getByText('WeldSuite has been updated')).toBeInTheDocument();
    expect(reload).not.toHaveBeenCalled();

    await userEvent.setup().click(screen.getByRole('button', { name: 'Reload now' }));
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('shows other errors inside the shell, with a retry', async () => {
    const reset = renderFallback(new Error('boom'));
    expect(screen.getByRole('heading', { name: 'Something went wrong' })).toBeInTheDocument();
    expect(logError).toHaveBeenCalledWith('Unhandled route error', expect.objectContaining({ message: 'boom' }));

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(reset).toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Go home' }));
    expect(router.navigate).toHaveBeenCalledWith({ to: '/' });
    expect(reload).not.toHaveBeenCalled();
  });
});
