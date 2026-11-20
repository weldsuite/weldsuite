/**
 * The shared softphone client: sign-in with the shared or the member's own
 * login (a live client is kept, not rebuilt), and inbound calls (exposed,
 * accepted, declined) driving the same state as an outbound call.
 */

import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';

type Handler = (payload?: unknown) => void;

interface FakeCall {
  id: string;
  state: string;
  direction: 'inbound' | 'outbound';
  remoteCallerNumber?: string;
  remoteCallerName?: string;
  remoteStream?: MediaStream;
  answer: ReturnType<typeof vi.fn>;
  hangup: ReturnType<typeof vi.fn>;
  muteAudio: ReturnType<typeof vi.fn>;
  unmuteAudio: ReturnType<typeof vi.fn>;
  hold: ReturnType<typeof vi.fn>;
  unhold: ReturnType<typeof vi.fn>;
  dtmf: ReturnType<typeof vi.fn>;
  on: ReturnType<typeof vi.fn>;
}

class FakeTelnyxClient {
  handlers = new Map<string, Set<Handler>>();
  connect = vi.fn().mockResolvedValue(undefined);
  disconnect = vi.fn();
  newCall = vi.fn();
  constructor(readonly options: { login_token: string }) {
    clients.push(this);
  }

  on(event: string, handler: Handler) {
    const set = this.handlers.get(event) ?? new Set<Handler>();
    set.add(handler);
    this.handlers.set(event, set);
  }

  off(event: string, handler: Handler) {
    this.handlers.get(event)?.delete(handler);
  }

  emit(event: string, payload?: unknown) {
    for (const handler of [...(this.handlers.get(event) ?? [])]) handler(payload);
  }
}

const clients: FakeTelnyxClient[] = [];

vi.mock('@telnyx/webrtc', () => ({ TelnyxRTC: FakeTelnyxClient }));

import { CallProvider, useCall } from './call-context';

function fakeCall(overrides: Partial<FakeCall> = {}): FakeCall {
  return {
    id: 'telnyx_1',
    state: 'ringing',
    direction: 'inbound',
    remoteCallerNumber: '+31612345678',
    remoteCallerName: 'Ann Caller',
    answer: vi.fn(),
    hangup: vi.fn(),
    muteAudio: vi.fn(),
    unmuteAudio: vi.fn(),
    hold: vi.fn().mockResolvedValue(undefined),
    unhold: vi.fn().mockResolvedValue(undefined),
    dtmf: vi.fn(),
    on: vi.fn(),
    ...overrides,
  };
}

const getUserMedia = vi.fn();

function wrapper({ children }: { children: ReactNode }) {
  return <CallProvider>{children}</CallProvider>;
}

/** The provider, signed in and ready. */
async function signedIn(credential: 'shared' | 'member' = 'member') {
  const hook = renderHook(() => useCall(), { wrapper });
  await act(async () => {
    await hook.result.current.initializeVoip('token-1', { credential });
  });
  act(() => clients[0].emit('telnyx.ready'));
  return hook;
}

function ring(call: FakeCall, client = clients[0]) {
  act(() => client.emit('telnyx.notification', { type: 'callUpdate', call }));
}

beforeEach(() => {
  clients.length = 0;
  getUserMedia.mockReset();
  getUserMedia.mockResolvedValue({ getTracks: () => [{ stop: vi.fn() }] });
  Object.defineProperty(navigator, 'mediaDevices', { value: { getUserMedia }, configurable: true });
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('signing in', () => {
  it('reports the connection and the credential the client has', async () => {
    const { result } = renderHook(() => useCall(), { wrapper });
    expect(result.current.voipConnection).toBe('idle');
    expect(result.current.voipCredential).toBeNull();

    await act(async () => {
      await result.current.initializeVoip('token-1', { credential: 'member' });
    });
    expect(result.current.voipConnection).toBe('connecting');
    expect(result.current.voipCredential).toBe('member');
    expect(result.current.isVoipReady).toBe(false);

    act(() => clients[0].emit('telnyx.ready'));
    expect(result.current.voipConnection).toBe('ready');
    expect(result.current.isVoipReady).toBe(true);

    act(() => clients[0].emit('telnyx.socket.close'));
    expect(result.current.voipConnection).toBe('closed');
    expect(result.current.isVoipReady).toBe(false);
  });

  it('treats an error before ready as a refused login, and one after ready as a call problem', async () => {
    const { result } = renderHook(() => useCall(), { wrapper });
    await act(async () => {
      await result.current.initializeVoip('token-1', { credential: 'member' });
    });
    act(() => clients[0].emit('telnyx.error', { message: 'login refused' }));
    expect(result.current.voipConnection).toBe('error');

    await act(async () => {
      await result.current.initializeVoip('token-2', { credential: 'member' });
    });
    act(() => clients[1].emit('telnyx.ready'));
    act(() => clients[1].emit('telnyx.error', { message: 'call failed' }));
    expect(result.current.voipConnection).toBe('ready');
  });

  it('keeps a live client when the shared login asks again, and when the member login does', async () => {
    const { result } = await signedIn('member');
    await act(async () => {
      await result.current.initializeVoip('shared-token');
      await result.current.initializeVoip('member-token-2', { credential: 'member' });
    });
    expect(clients).toHaveLength(1);
    expect(clients[0].disconnect).not.toHaveBeenCalled();
    expect(result.current.voipCredential).toBe('member');
  });

  it('lets the member login replace a live shared client', async () => {
    const { result } = await signedIn('shared');
    await act(async () => {
      await result.current.initializeVoip('member-token', { credential: 'member' });
    });
    expect(clients).toHaveLength(2);
    expect(clients[0].disconnect).toHaveBeenCalled();
    expect(clients[1].options.login_token).toBe('member-token');
    expect(result.current.voipCredential).toBe('member');

    // The replaced client's late events do not touch the new one.
    act(() => clients[1].emit('telnyx.ready'));
    act(() => clients[0].emit('telnyx.socket.close'));
    expect(result.current.voipConnection).toBe('ready');
  });

  it('does not replace a client while a call rings or is live', async () => {
    const { result } = await signedIn('shared');
    ring(fakeCall());
    expect(result.current.incomingCall).not.toBeNull();
    await act(async () => {
      await result.current.initializeVoip('member-token', { credential: 'member' });
    });
    expect(clients).toHaveLength(1);
  });

  it('rebuilds a client that closed, and resetVoip lets go of it', async () => {
    const { result } = await signedIn('member');
    act(() => clients[0].emit('telnyx.socket.close'));
    await act(async () => {
      await result.current.initializeVoip('member-token-2', { credential: 'member' });
    });
    expect(clients).toHaveLength(2);

    act(() => result.current.resetVoip());
    expect(result.current.voipCredential).toBeNull();
    expect(result.current.voipConnection).toBe('idle');
  });

  it('waits for the client to be ready', async () => {
    const { result } = renderHook(() => useCall(), { wrapper });
    await act(async () => {
      await result.current.initializeVoip('token-1');
    });
    let ready: boolean | undefined;
    const waiting = result.current.waitForVoipReady(1000).then((value) => {
      ready = value;
    });
    act(() => clients[0].emit('telnyx.ready'));
    await act(async () => {
      await waiting;
    });
    expect(ready).toBe(true);
    await expect(result.current.waitForVoipReady(10)).resolves.toBe(true);
  });

  it('gives up waiting when the client never gets ready', async () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useCall(), { wrapper });
    let ready: boolean | undefined;
    const waiting = result.current.waitForVoipReady(500).then((value) => {
      ready = value;
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(600);
      await waiting;
    });
    expect(ready).toBe(false);
  });
});

describe('an incoming call', () => {
  it('is exposed with who is calling', async () => {
    const { result } = await signedIn();
    expect(result.current.incomingCall).toBeNull();
    ring(fakeCall());
    expect(result.current.incomingCall).toMatchObject({
      id: 'telnyx_1',
      fromNumber: '+31612345678',
      callerName: 'Ann Caller',
    });
    // Nothing is answered by itself.
    expect(result.current.callState).toBeNull();
  });

  it('ignores a ringing outbound call and a call that is not ringing', async () => {
    const { result } = await signedIn();
    ring(fakeCall({ direction: 'outbound' }));
    ring(fakeCall({ id: 'telnyx_2', state: 'trying' }));
    expect(result.current.incomingCall).toBeNull();
  });

  it('is accepted: answers with audio, then follows the call to connected and ended', async () => {
    const { result } = await signedIn();
    const call = fakeCall();
    ring(call);

    let outcome: { success: boolean; error?: string } | undefined;
    await act(async () => {
      outcome = await result.current.acceptIncomingCall({
        callId: 'call_77',
        conversationId: 'dconv_1',
        customerName: 'Acme',
        callerName: 'Ann',
      });
    });
    expect(outcome).toEqual({ success: true });
    expect(call.answer).toHaveBeenCalledWith({ audio: true, video: false });
    expect(result.current.incomingCall).toBeNull();
    expect(result.current.callState).toMatchObject({
      status: 'connecting',
      direction: 'inbound',
      toNumber: '+31612345678',
      contactName: 'Ann',
      customerName: 'Acme',
      isRecording: false,
      inbound: { conversationId: 'dconv_1', customerName: 'Acme' },
    });

    // Remote audio is attached like an outbound call's.
    const stream = {} as MediaStream;
    act(() => clients[0].emit('telnyx.notification', { type: 'callUpdate', call: { ...call, state: 'answering' } }));
    act(() =>
      clients[0].emit('telnyx.notification', { type: 'callUpdate', call: { ...call, state: 'active', remoteStream: stream } }),
    );
    expect(result.current.callState?.status).toBe('connected');
    expect(result.current.callState?.connectedAt).toBeInstanceOf(Date);
    const audio = document.getElementById('telnyx-remote-audio') as HTMLAudioElement;
    expect(audio.srcObject).toBe(stream);
    expect(result.current.callStreams.remote).toBe(stream);

    // Mute, hold and DTMF act on the answered call.
    act(() => result.current.toggleMute());
    expect(call.muteAudio).toHaveBeenCalled();
    expect(result.current.callState?.isMuted).toBe(true);
    act(() => result.current.toggleHold());
    expect(call.hold).toHaveBeenCalled();
    act(() => result.current.sendDigits('5'));
    expect(call.dtmf).toHaveBeenCalledWith('5');

    // The caller hangs up.
    act(() => clients[0].emit('telnyx.notification', { type: 'callUpdate', call: { ...call, state: 'hangup' } }));
    expect(result.current.callState?.status).toBe('ended');
  });

  it('is not answered without the microphone, and keeps ringing', async () => {
    const { result } = await signedIn();
    const call = fakeCall();
    ring(call);
    getUserMedia.mockRejectedValueOnce(Object.assign(new Error('denied'), { name: 'NotAllowedError' }));

    let outcome: { success: boolean; error?: string } | undefined;
    await act(async () => {
      outcome = await result.current.acceptIncomingCall();
    });
    expect(outcome).toEqual({ success: false, error: 'microphone_denied' });
    expect(call.answer).not.toHaveBeenCalled();
    expect(result.current.incomingCall).not.toBeNull();
  });

  it('tells a missing microphone from a refused one', async () => {
    const { result } = await signedIn();
    ring(fakeCall());
    getUserMedia.mockRejectedValueOnce(Object.assign(new Error('none'), { name: 'NotFoundError' }));
    let outcome: { success: boolean; error?: string } | undefined;
    await act(async () => {
      outcome = await result.current.acceptIncomingCall();
    });
    expect(outcome).toEqual({ success: false, error: 'microphone_unavailable' });
  });

  it('has nothing to answer once the ring is gone', async () => {
    const { result } = await signedIn();
    let outcome: { success: boolean; error?: string } | undefined;
    await act(async () => {
      outcome = await result.current.acceptIncomingCall();
    });
    expect(outcome).toEqual({ success: false, error: 'not_ringing' });
  });

  it('is declined: the call is hung up and the ring goes away', async () => {
    const { result } = await signedIn();
    const call = fakeCall();
    ring(call);
    act(() => result.current.declineIncomingCall());
    expect(call.hangup).toHaveBeenCalled();
    expect(call.answer).not.toHaveBeenCalled();
    expect(result.current.incomingCall).toBeNull();
    expect(result.current.callState).toBeNull();
  });

  it('goes away when the caller hangs up, or another agent takes it', async () => {
    const { result } = await signedIn();
    const call = fakeCall();
    ring(call);
    act(() => clients[0].emit('telnyx.notification', { type: 'callUpdate', call: { ...call, state: 'hangup' } }));
    expect(result.current.incomingCall).toBeNull();
  });

  it('turns away a second call while one rings or is live', async () => {
    const { result } = await signedIn();
    const first = fakeCall();
    const second = fakeCall({ id: 'telnyx_2' });
    ring(first);
    ring(second);
    expect(second.hangup).toHaveBeenCalled();
    expect(first.hangup).not.toHaveBeenCalled();
    expect(result.current.incomingCall?.id).toBe('telnyx_1');

    await act(async () => {
      await result.current.acceptIncomingCall();
    });
    const third = fakeCall({ id: 'telnyx_3' });
    ring(third);
    expect(third.hangup).toHaveBeenCalled();
    expect(result.current.callState?.status).toBe('connecting');
  });

  it('answering ends on a failed answer', async () => {
    const { result } = await signedIn();
    const call = fakeCall({ answer: vi.fn().mockRejectedValue(new Error('no media')) });
    ring(call);
    let outcome: { success: boolean; error?: string } | undefined;
    await act(async () => {
      outcome = await result.current.acceptIncomingCall();
    });
    expect(outcome).toEqual({ success: false, error: 'answer_failed' });
    expect(result.current.callState?.status).toBe('failed');
  });
});

describe('an outbound call', () => {
  it('still dials through the client, whichever login it has', async () => {
    const { result } = await signedIn('member');
    const call = fakeCall({ id: 'out_1', direction: 'outbound', state: 'new' });
    clients[0].newCall.mockReturnValue(call);

    let outcome: { success: boolean } | undefined;
    await act(async () => {
      outcome = await result.current.startCall({ toNumber: '+31611111111', fromNumber: '+31200000000', callId: 'call_9' });
    });
    expect(outcome?.success).toBe(true);
    expect(clients[0].newCall).toHaveBeenCalledWith(
      expect.objectContaining({ destinationNumber: '+31611111111', callerNumber: '+31200000000' }),
    );
    expect(result.current.callState).toMatchObject({ direction: 'outbound', status: 'dialing' });

    act(() => clients[0].emit('telnyx.notification', { type: 'callUpdate', call: { ...call, state: 'ringing' } }));
    expect(result.current.callState?.status).toBe('ringing');
    act(() => clients[0].emit('telnyx.notification', { type: 'callUpdate', call: { ...call, state: 'active' } }));
    expect(result.current.callState?.status).toBe('connected');
  });
});

describe('an outbound call is real or it is not made', () => {
  const place = (hook: ReturnType<typeof renderHook<ReturnType<typeof useCall>, unknown>>) =>
    hook.result.current.startCall({ toNumber: '+31611111111', fromNumber: '+31200000000', callId: 'call_9' });

  it('dials on a shared-token client after the member login was dropped (take calls switched off)', async () => {
    const hook = await signedIn('member');
    act(() => hook.result.current.resetVoip());
    expect(hook.result.current.voipConnection).toBe('idle');

    // The dialer signs in with the shared token again.
    await act(async () => {
      await hook.result.current.initializeVoip('shared-token');
    });
    act(() => clients[1].emit('telnyx.ready'));
    const dialed = fakeCall({ id: 'out_2', direction: 'outbound', state: 'new' });
    clients[1].newCall.mockReturnValue(dialed);
    let outcome: { success: boolean } | undefined;
    await act(async () => {
      outcome = await place(hook);
    });
    expect(outcome?.success).toBe(true);
    expect(clients[1].options.login_token).toBe('shared-token');
    expect(clients[1].newCall).toHaveBeenCalledTimes(1);
    expect(hook.result.current.voipCredential).toBe('shared');
  });

  it('does not pretend after the watchdog dropped the client', async () => {
    const hook = await signedIn('member');
    act(() => hook.result.current.resetVoip());
    let outcome: { success: boolean; error?: string } | undefined;
    await act(async () => {
      outcome = await place(hook);
    });
    expect(outcome).toEqual({ success: false });
    expect(hook.result.current.callState).toBeNull();
    expect(clients[0].newCall).not.toHaveBeenCalled();
  });

  it('does not pretend while a client is still connecting', async () => {
    const hook = renderHook(() => useCall(), { wrapper });
    await act(async () => {
      await hook.result.current.initializeVoip('token-1');
    });
    let outcome: { success: boolean } | undefined;
    await act(async () => {
      outcome = await place(hook);
    });
    expect(outcome?.success).toBe(false);
    expect(hook.result.current.callState).toBeNull();
  });

  it('does not pretend where telephony is configured but no client was ever created', async () => {
    const hook = renderHook(() => useCall(), { wrapper });
    act(() => hook.result.current.setVoipConfigured(true));
    let outcome: { success: boolean } | undefined;
    await act(async () => {
      outcome = await place(hook);
    });
    expect(outcome?.success).toBe(false);
    expect(hook.result.current.callState).toBeNull();
  });

  it('still simulates the call in an environment without telephony', async () => {
    vi.useFakeTimers();
    const hook = renderHook(() => useCall(), { wrapper });
    let outcome: { success: boolean } | undefined;
    await act(async () => {
      outcome = await place(hook);
    });
    expect(outcome?.success).toBe(true);
    expect(hook.result.current.callState?.status).toBe('dialing');
  });
});

