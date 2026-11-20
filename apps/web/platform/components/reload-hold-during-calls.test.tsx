/**
 * A new frontend version does not reload the page while a WeldChat call, a
 * WeldMeet meeting or a phone call is live; it reloads once the call ends.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render } from '@testing-library/react';

vi.mock('@/lib/i18n/provider', () => ({
  useI18n: () => ({
    t: {
      common: {
        appUpdate: {
          title: 'WeldSuite has been updated',
          reloadAfterCall: 'The page reloads to the new version when your call ends.',
        },
      },
    },
  }),
}));

const toastInfo = vi.fn();
vi.mock('sonner', () => ({ toast: { info: (...args: unknown[]) => toastInfo(...args) } }));

let phoneStatus: string | undefined;
vi.mock('@/contexts/call-context', () => ({
  useCallSafe: () => (phoneStatus ? { callState: { status: phoneStatus } } : null),
}));

import { ReloadHoldDuringCalls } from './reload-hold-during-calls';
import { ActiveCallProvider, useRegisterActiveCall } from '@/contexts/active-call-context';
import { HELD_RELOAD_GRACE_MS, reloadForStaleChunk } from '@/lib/chunk-reload';

function LiveChatCall({ live }: Readonly<{ live: boolean }>) {
  useRegisterActiveCall('chat', live ? { id: 'call_1', label: 'the call', leave: async () => undefined } : null);
  return null;
}

function Shell({ chatLive }: Readonly<{ chatLive: boolean }>) {
  return (
    <ActiveCallProvider>
      <ReloadHoldDuringCalls />
      <LiveChatCall live={chatLive} />
    </ActiveCallProvider>
  );
}

const originalLocation = window.location;
let reload: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  sessionStorage.clear();
  phoneStatus = undefined;
  reload = vi.fn();
  Object.defineProperty(window, 'location', { configurable: true, value: { ...originalLocation, reload } });
});

afterEach(() => {
  vi.useRealTimers();
  Object.defineProperty(window, 'location', { configurable: true, value: originalLocation });
});

describe('ReloadHoldDuringCalls', () => {
  it('holds the update reload during a chat call and runs it once the call ends', async () => {
    const view = render(<Shell chatLive />);

    let outcome: string | undefined;
    await act(async () => {
      outcome = reloadForStaleChunk();
    });
    expect(outcome).toBe('deferred');
    expect(reload).not.toHaveBeenCalled();
    expect(toastInfo).toHaveBeenCalledTimes(1);
    expect(toastInfo).toHaveBeenCalledWith(
      'WeldSuite has been updated',
      expect.objectContaining({ description: 'The page reloads to the new version when your call ends.' }),
    );

    view.rerender(<Shell chatLive={false} />);
    await act(async () => {
      vi.advanceTimersByTime(HELD_RELOAD_GRACE_MS);
    });
    expect(reload).toHaveBeenCalledTimes(1);
    view.unmount();
  });

  it('holds it during a phone call too', async () => {
    phoneStatus = 'connected';
    const view = render(<Shell chatLive={false} />);
    expect(reloadForStaleChunk()).toBe('deferred');
    view.unmount();
    await act(async () => {
      vi.advanceTimersByTime(HELD_RELOAD_GRACE_MS);
    });
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('reloads right away when no call is live', () => {
    const view = render(<Shell chatLive={false} />);
    expect(reloadForStaleChunk()).toBe('reloading');
    expect(reload).toHaveBeenCalledTimes(1);
    expect(toastInfo).not.toHaveBeenCalled();
    view.unmount();
  });
});
