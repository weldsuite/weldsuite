/**
 * `usePlaceCall`: the call row is created with `deskConversationId` for a
 * WeldDesk conversation, and where telephony is configured a call is only made
 * once the softphone is signed in. `useVoipInitialization`: a client that was
 * ready and is gone is signed in again, once.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';

vi.mock('@weldsuite/i18n/client', () => ({ useTranslations: () => (key: string) => key }));
vi.mock('@/lib/auth', () => ({ useOrganization: () => ({ organization: { id: 'org_1' } }) }));
const fetchVoiceToken = vi.hoisted(() => vi.fn());
vi.mock('@/hooks/queries', () => ({ useFetchVoiceToken: () => ({ mutateAsync: fetchVoiceToken }) }));
const toast = vi.hoisted(() => ({ error: vi.fn() }));
vi.mock('sonner', () => ({ toast }));

const call = vi.hoisted(() => ({
  startCall: vi.fn(),
  voipConfigured: false,
  isVoipReady: true,
  voipConnection: 'ready' as string,
  initializeVoip: vi.fn(),
  waitForVoipReady: vi.fn(),
}));
vi.mock('@/contexts/call-context', () => ({ useCall: () => call }));

const client = vi.hoisted(() => ({ post: vi.fn() }));
vi.mock('@/lib/api/use-app-api', () => ({
  useAppApiClient: () => ({ getClient: async () => client }),
}));

import { useEnsureVoipReady, usePlaceCall, useVoipInitialization } from './call-dialing';

const dialParams = { toNumber: '+31612345678', fromNumber: '+31200000000', enableRecording: true };

beforeEach(() => {
  call.startCall.mockReset();
  call.startCall.mockResolvedValue({ success: true });
  call.voipConfigured = false;
  call.isVoipReady = true;
  call.voipConnection = 'ready';
  call.initializeVoip.mockReset();
  call.initializeVoip.mockResolvedValue(undefined);
  call.waitForVoipReady.mockReset();
  call.waitForVoipReady.mockResolvedValue(true);
  fetchVoiceToken.mockReset();
  fetchVoiceToken.mockResolvedValue({ token: 'shared-token' });
  toast.error.mockReset();
  client.post.mockReset();
  client.post.mockResolvedValue({ data: { id: 'call_1' } });
});

describe('usePlaceCall', () => {
  it('creates the call row on the desk conversation, then dials', async () => {
    const { result } = renderHook(() => usePlaceCall());
    await act(async () => {
      await result.current.dial({ ...dialParams, deskConversationId: 'dconv_1' });
    });
    expect(client.post).toHaveBeenCalledWith(
      '/calls',
      expect.objectContaining({ direction: 'outbound', toNumber: '+31612345678', deskConversationId: 'dconv_1' }),
    );
    expect(call.startCall).toHaveBeenCalledWith(expect.objectContaining({ callId: 'call_1', toNumber: '+31612345678' }));
  });

  it('leaves the field out for a call that is not about a conversation', async () => {
    const { result } = renderHook(() => usePlaceCall());
    await act(async () => {
      await result.current.dial(dialParams);
    });
    const body = client.post.mock.calls[0][1] as Record<string, unknown>;
    expect('deskConversationId' in body).toBe(false);
  });

  it('does not dial when the call row cannot be created', async () => {
    client.post.mockRejectedValue(new Error('Insufficient credits'));
    const { result } = renderHook(() => usePlaceCall());
    await act(async () => {
      await result.current.dial({ ...dialParams, deskConversationId: 'dconv_1' });
    });
    expect(call.startCall).not.toHaveBeenCalled();
  });

  it('signs the softphone in first when telephony is configured and there is no ready client', async () => {
    call.voipConfigured = true;
    call.isVoipReady = false;
    call.voipConnection = 'idle';
    const { result } = renderHook(() => usePlaceCall());
    await act(async () => {
      await result.current.dial(dialParams);
    });
    expect(call.initializeVoip).toHaveBeenCalledWith('shared-token');
    expect(call.waitForVoipReady).toHaveBeenCalled();
    expect(client.post).toHaveBeenCalledTimes(1);
    expect(call.startCall).toHaveBeenCalledTimes(1);
  });

  it('makes no call, and no call row, when it cannot sign in', async () => {
    call.voipConfigured = true;
    call.isVoipReady = false;
    call.voipConnection = 'idle';
    call.waitForVoipReady.mockResolvedValue(false);
    const { result } = renderHook(() => usePlaceCall());
    await act(async () => {
      await result.current.dial(dialParams);
    });
    expect(toast.error).toHaveBeenCalled();
    expect(client.post).not.toHaveBeenCalled();
    expect(call.startCall).not.toHaveBeenCalled();
  });

  it('does not sign in where telephony is not configured (the simulated dialer)', async () => {
    call.voipConfigured = false;
    call.isVoipReady = false;
    call.voipConnection = 'idle';
    const { result } = renderHook(() => usePlaceCall());
    await act(async () => {
      await result.current.dial(dialParams);
    });
    expect(fetchVoiceToken).not.toHaveBeenCalled();
    expect(call.startCall).toHaveBeenCalledTimes(1);
  });
});

describe('useEnsureVoipReady', () => {
  it('is ready at once when the client is', async () => {
    const { result } = renderHook(() => useEnsureVoipReady());
    await expect(result.current()).resolves.toBe(true);
    expect(fetchVoiceToken).not.toHaveBeenCalled();
  });

  it('waits for a login that is already on its way instead of starting another', async () => {
    call.isVoipReady = false;
    call.voipConnection = 'connecting';
    const { result } = renderHook(() => useEnsureVoipReady());
    await expect(result.current()).resolves.toBe(true);
    expect(fetchVoiceToken).not.toHaveBeenCalled();
    expect(call.waitForVoipReady).toHaveBeenCalled();
  });

  it('is false without a token or when signing in throws', async () => {
    call.isVoipReady = false;
    call.voipConnection = 'idle';
    fetchVoiceToken.mockResolvedValueOnce({});
    const { result } = renderHook(() => useEnsureVoipReady());
    await expect(result.current()).resolves.toBe(false);
    call.initializeVoip.mockRejectedValueOnce(new Error('socket'));
    await expect(result.current()).resolves.toBe(false);
  });
});

describe('useVoipInitialization', () => {
  interface Props {
    isVoipReady: boolean;
    connection: 'idle' | 'connecting' | 'ready' | 'closed' | 'error';
    credential: 'shared' | 'member' | null;
  }
  const initializeVoip = vi.fn();
  const fetchToken = vi.fn();
  // Stable, like the real one: the hook signs in again whenever it changes.
  const t = ((key: string) => key) as never;

  function setup(initial: Props) {
    return renderHook(
      (props: Props) =>
        useVoipInitialization({
          enabled: true,
          voipConfigured: true,
          initializeVoip,
          fetchVoiceToken: fetchToken as never,
          t,
          ...props,
        }),
      { initialProps: initial },
    );
  }

  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    initializeVoip.mockReset();
    initializeVoip.mockResolvedValue(undefined);
    fetchToken.mockReset();
    fetchToken.mockResolvedValue({ token: 'shared-token' });
  });

  it('signs in again after the client it signed in was dropped', async () => {
    const hook = setup({ isVoipReady: false, connection: 'idle', credential: null });
    await act(async () => {});
    expect(initializeVoip).toHaveBeenCalledTimes(1);

    hook.rerender({ isVoipReady: true, connection: 'ready', credential: 'shared' });
    await act(async () => {});
    // The member's own login replaced it, then was dropped (switch off, watchdog): no client.
    hook.rerender({ isVoipReady: false, connection: 'idle', credential: null });
    await act(async () => {});
    expect(initializeVoip).toHaveBeenCalledTimes(2);
  });

  it('stays out of the way while the member login is in place, whatever the socket does', async () => {
    const hook = setup({ isVoipReady: true, connection: 'ready', credential: 'member' });
    await act(async () => {});
    hook.rerender({ isVoipReady: false, connection: 'closed', credential: 'member' });
    await act(async () => {});
    expect(initializeVoip).not.toHaveBeenCalled();
  });

  it('retries a drop only once: a login that keeps failing does not loop', async () => {
    const hook = setup({ isVoipReady: true, connection: 'ready', credential: 'shared' });
    await act(async () => {});
    initializeVoip.mockRejectedValue(new Error('refused'));
    hook.rerender({ isVoipReady: false, connection: 'closed', credential: 'shared' });
    await act(async () => {});
    hook.rerender({ isVoipReady: false, connection: 'error', credential: 'shared' });
    await act(async () => {});
    hook.rerender({ isVoipReady: false, connection: 'idle', credential: 'shared' });
    await act(async () => {});
    expect(initializeVoip).toHaveBeenCalledTimes(1);
  });
});
