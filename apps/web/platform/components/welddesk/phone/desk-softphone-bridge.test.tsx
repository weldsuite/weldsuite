/**
 * The softphone bridge signs the shared client in with the member's own
 * credential only while "take calls" is on, signs in again when the socket
 * drops, and gives up after a few failures instead of looping.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render } from '@testing-library/react';
import { getDefaultStore } from 'jotai';

vi.mock('@weldsuite/permissions/react', () => ({ useCan: () => perms.canRead }));
vi.mock('@/hooks/use-is-app-installed', () => ({ useIsAppInstalled: () => perms.installed }));
vi.mock('./use-desk-phone-realtime', () => ({ useDeskPhoneRealtime: vi.fn() }));
vi.mock('./use-microphone-permission', () => ({
  useMicrophonePermission: () => ({ permission: perms.mic, request: vi.fn() }),
}));

const perms = vi.hoisted(() => ({ canRead: true, installed: true, mic: 'granted' as string }));

const softphone = vi.hoisted(() => ({
  data: { configured: true, available: true, registered: true, sipUsername: 'sip_me' } as
    | { configured: boolean; available: boolean; registered: boolean; sipUsername: string | null }
    | undefined,
}));
const mintToken = vi.hoisted(() => vi.fn());
vi.mock('@/hooks/queries/use-desk-phone-queries', () => ({
  useDeskSoftphone: () => ({ data: softphone.data }),
  useFetchDeskSoftphoneToken: () => ({ mutateAsync: mintToken }),
}));

interface FakeCall {
  voipCredential: 'shared' | 'member' | null;
  voipConnection: 'idle' | 'connecting' | 'ready' | 'closed' | 'error';
  callState: object | null;
  incomingCall: object | null;
  initializeVoip: ReturnType<typeof vi.fn>;
  resetVoip: ReturnType<typeof vi.fn>;
}
const call = vi.hoisted(() => ({ value: null as unknown as FakeCall }));
vi.mock('@/contexts/call-context', () => ({ useCallSafe: () => call.value }));

import {
  CONNECT_WATCHDOG_MS,
  DeskSoftphoneBridge,
  MAX_SIGNIN_ATTEMPTS,
  SIGNIN_BACKOFF_MS,
  signInDelay,
} from './desk-softphone-bridge';
import { deskSoftphoneRetryAtom, deskSoftphoneStatusAtom } from './desk-phone-state';

const store = getDefaultStore();

async function settle(ms = 0) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

/** Time passing in steps: React applies a state change at the end of each act, and the next attempt is scheduled by it. */
async function settleSteps(totalMs: number, stepMs = 1000) {
  for (let elapsed = 0; elapsed < totalMs; elapsed += stepMs) await settle(stepMs);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  perms.canRead = true;
  perms.installed = true;
  perms.mic = 'granted';
  softphone.data = { configured: true, available: true, registered: true, sipUsername: 'sip_me' };
  mintToken.mockReset();
  mintToken.mockResolvedValue({ token: 'member-token', configured: true, sipUsername: 'sip_me' });
  call.value = {
    voipCredential: null,
    voipConnection: 'idle',
    callState: null,
    incomingCall: null,
    initializeVoip: vi.fn().mockResolvedValue(undefined),
    resetVoip: vi.fn(),
  };
  store.set(deskSoftphoneStatusAtom, 'off');
  store.set(deskSoftphoneRetryAtom, 0);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('signInDelay', () => {
  it('signs in at once the first time, then waits longer each time up to a cap', () => {
    expect(signInDelay(0, false)).toBe(0);
    expect(signInDelay(1, false)).toBe(SIGNIN_BACKOFF_MS * 2);
    expect(signInDelay(0, true)).toBe(SIGNIN_BACKOFF_MS);
    expect(signInDelay(20, true)).toBe(60_000);
  });
});

describe('DeskSoftphoneBridge', () => {
  it('signs in with the member credential while take calls is on', async () => {
    render(<DeskSoftphoneBridge />);
    await settle();
    expect(mintToken).toHaveBeenCalledTimes(1);
    expect(call.value.initializeVoip).toHaveBeenCalledWith('member-token', { credential: 'member' });
    expect(store.get(deskSoftphoneStatusAtom)).toBe('connecting');
  });

  it('reports connected once the member client is ready, and does not sign in again', async () => {
    call.value.voipCredential = 'member';
    call.value.voipConnection = 'ready';
    render(<DeskSoftphoneBridge />);
    await settle(5000);
    expect(mintToken).not.toHaveBeenCalled();
    expect(call.value.initializeVoip).not.toHaveBeenCalled();
    expect(store.get(deskSoftphoneStatusAtom)).toBe('connected');
  });

  it('reports a blocked microphone on a connected client', async () => {
    perms.mic = 'denied';
    call.value.voipCredential = 'member';
    call.value.voipConnection = 'ready';
    render(<DeskSoftphoneBridge />);
    await settle();
    expect(store.get(deskSoftphoneStatusAtom)).toBe('mic_blocked');
  });

  it('leaves the shared client alone while take calls is off', async () => {
    softphone.data = { configured: true, available: false, registered: false, sipUsername: null };
    call.value.voipCredential = 'shared';
    call.value.voipConnection = 'ready';
    render(<DeskSoftphoneBridge />);
    await settle(5000);
    expect(mintToken).not.toHaveBeenCalled();
    expect(call.value.initializeVoip).not.toHaveBeenCalled();
    expect(call.value.resetVoip).not.toHaveBeenCalled();
    expect(store.get(deskSoftphoneStatusAtom)).toBe('off');
  });

  it('does nothing when telephony is not set up', async () => {
    softphone.data = { configured: false, available: false, registered: false, sipUsername: null };
    render(<DeskSoftphoneBridge />);
    await settle(5000);
    expect(mintToken).not.toHaveBeenCalled();
    expect(store.get(deskSoftphoneStatusAtom)).toBe('not_configured');
  });

  it('is not mounted for a member who cannot read conversations, or without WeldDesk', async () => {
    perms.canRead = false;
    const first = render(<DeskSoftphoneBridge />);
    await settle();
    expect(mintToken).not.toHaveBeenCalled();
    first.unmount();

    perms.canRead = true;
    perms.installed = false;
    render(<DeskSoftphoneBridge />);
    await settle();
    expect(mintToken).not.toHaveBeenCalled();
  });

  it('lets go of the member login when take calls goes off, but not in the middle of a call', async () => {
    softphone.data = { configured: true, available: false, registered: true, sipUsername: 'sip_me' };
    call.value.voipCredential = 'member';
    call.value.voipConnection = 'ready';
    call.value.callState = {};
    const { rerender } = render(<DeskSoftphoneBridge />);
    await settle();
    expect(call.value.resetVoip).not.toHaveBeenCalled();

    call.value.callState = null;
    rerender(<DeskSoftphoneBridge />);
    await settle();
    expect(call.value.resetVoip).toHaveBeenCalledTimes(1);
  });

  it('does not replace the shared client in the middle of a call, and does afterwards', async () => {
    call.value.voipCredential = 'shared';
    call.value.voipConnection = 'ready';
    call.value.callState = {};
    const { rerender } = render(<DeskSoftphoneBridge />);
    await settle();
    expect(mintToken).not.toHaveBeenCalled();

    call.value.callState = null;
    rerender(<DeskSoftphoneBridge />);
    await settle();
    expect(call.value.initializeVoip).toHaveBeenCalledWith('member-token', { credential: 'member' });
  });

  it('signs in again after the socket closes, once the SDK had its own chance to reconnect', async () => {
    call.value.voipCredential = 'member';
    call.value.voipConnection = 'closed';
    render(<DeskSoftphoneBridge />);
    await settle(SIGNIN_BACKOFF_MS - 100);
    expect(call.value.initializeVoip).not.toHaveBeenCalled();
    await settle(200);
    expect(call.value.initializeVoip).toHaveBeenCalledTimes(1);
  });

  it('does not sign in again when the SDK reconnects by itself first', async () => {
    call.value.voipCredential = 'member';
    call.value.voipConnection = 'closed';
    const { rerender } = render(<DeskSoftphoneBridge />);
    await settle(1000);
    call.value.voipConnection = 'ready';
    rerender(<DeskSoftphoneBridge />);
    await settle(10_000);
    expect(call.value.initializeVoip).not.toHaveBeenCalled();
  });

  it('drops a client that never gets ready and starts over', async () => {
    call.value.voipCredential = 'member';
    call.value.voipConnection = 'connecting';
    render(<DeskSoftphoneBridge />);
    await settle(CONNECT_WATCHDOG_MS - 100);
    expect(call.value.resetVoip).not.toHaveBeenCalled();
    await settle(200);
    expect(call.value.resetVoip).toHaveBeenCalledTimes(1);
  });

  it('gives up after a few failed token requests instead of looping', async () => {
    mintToken.mockRejectedValue(new Error('token refused'));
    render(<DeskSoftphoneBridge />);
    await settleSteps(300_000);
    expect(mintToken).toHaveBeenCalledTimes(MAX_SIGNIN_ATTEMPTS);
    expect(call.value.initializeVoip).not.toHaveBeenCalled();
    expect(store.get(deskSoftphoneStatusAtom)).toBe('failed');

    await settleSteps(300_000);
    expect(mintToken).toHaveBeenCalledTimes(MAX_SIGNIN_ATTEMPTS);
  });

  it('gives up after a few failed sign-ins too, and "try again" starts over', async () => {
    call.value.initializeVoip.mockRejectedValue(new Error('socket refused'));
    render(<DeskSoftphoneBridge />);
    await settleSteps(300_000);
    expect(call.value.initializeVoip).toHaveBeenCalledTimes(MAX_SIGNIN_ATTEMPTS);
    expect(store.get(deskSoftphoneStatusAtom)).toBe('failed');

    call.value.initializeVoip.mockResolvedValue(undefined);
    act(() => {
      store.set(deskSoftphoneRetryAtom, 1);
    });
    await settle();
    expect(call.value.initializeVoip).toHaveBeenCalledTimes(MAX_SIGNIN_ATTEMPTS + 1);
  });

  it('treats a missing token like a failed sign-in', async () => {
    mintToken.mockResolvedValue({ token: null, configured: true, sipUsername: null });
    render(<DeskSoftphoneBridge />);
    await settleSteps(300_000);
    expect(call.value.initializeVoip).not.toHaveBeenCalled();
    expect(mintToken).toHaveBeenCalledTimes(MAX_SIGNIN_ATTEMPTS);
  });
});
