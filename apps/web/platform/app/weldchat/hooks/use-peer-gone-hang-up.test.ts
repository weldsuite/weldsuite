import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import type RealtimeKitClient from '@cloudflare/realtimekit';
import { PEER_GONE_GRACE_MS, usePeerGoneHangUp } from './use-peer-gone-hang-up';

interface Peer {
  id: string;
  userId?: string;
}

/** A room with the parts of the RealtimeKit client the hook reads. */
function fakeRoom(initial: Peer[] = []) {
  let peers = [...initial];
  const listeners = new Map<string, Set<() => void>>();
  const emit = (event: string) => listeners.get(event)?.forEach((listener) => listener());
  const meeting = {
    self: { id: 'peer_me', userId: 'u_me' },
    participants: {
      joined: {
        toArray: () => peers,
        on: (event: string, listener: () => void) => {
          if (!listeners.has(event)) listeners.set(event, new Set());
          listeners.get(event)?.add(listener);
        },
        off: (event: string, listener: () => void) => listeners.get(event)?.delete(listener),
      },
    },
  } as unknown as RealtimeKitClient;
  return {
    meeting,
    join(peer: Peer) {
      peers = [...peers, peer];
      act(() => emit('participantJoined'));
    },
    leave(id: string) {
      peers = peers.filter((p) => p.id !== id);
      act(() => emit('participantLeft'));
    },
  };
}

const other = { id: 'peer_other', userId: 'u_other' };

interface Props {
  callId: string | null;
  meeting: RealtimeKitClient | null;
  isDirect: boolean;
  inRoom: boolean;
}

function setup(props: Props) {
  const onHangUp = vi.fn();
  const hook = renderHook((p: Props) => usePeerGoneHangUp({ ...p, onHangUp }), { initialProps: props });
  return { onHangUp, ...hook };
}

function wait(ms: number) {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('usePeerGoneHangUp', () => {
  it('hangs up a DM call once the other person has been gone for the grace period', () => {
    const room = fakeRoom([other]);
    const { onHangUp } = setup({ callId: 'call_1', meeting: room.meeting, isDirect: true, inRoom: true });

    room.leave(other.id);
    wait(PEER_GONE_GRACE_MS - 1);
    expect(onHangUp).not.toHaveBeenCalled();

    wait(1);
    expect(onHangUp).toHaveBeenCalledTimes(1);
  });

  it('carries on when the other person is back within the grace period', () => {
    const room = fakeRoom([other]);
    const { onHangUp } = setup({ callId: 'call_1', meeting: room.meeting, isDirect: true, inRoom: true });

    room.leave(other.id);
    wait(PEER_GONE_GRACE_MS / 2);
    // A reconnect gives them a new peer.
    room.join({ id: 'peer_other_2', userId: 'u_other' });
    wait(PEER_GONE_GRACE_MS * 2);

    expect(onHangUp).not.toHaveBeenCalled();
  });

  it('keeps ringing while the other person has not picked up yet', () => {
    const room = fakeRoom();
    const { onHangUp } = setup({ callId: 'call_1', meeting: room.meeting, isDirect: true, inRoom: true });

    wait(PEER_GONE_GRACE_MS * 3);

    expect(onHangUp).not.toHaveBeenCalled();
  });

  it('leaves group and channel calls running', () => {
    const room = fakeRoom([other]);
    const { onHangUp } = setup({ callId: 'call_1', meeting: room.meeting, isDirect: false, inRoom: true });

    room.leave(other.id);
    wait(PEER_GONE_GRACE_MS * 3);

    expect(onHangUp).not.toHaveBeenCalled();
  });

  it('does not count the other person as gone while our own connection is down', () => {
    const room = fakeRoom([other]);
    const { onHangUp, rerender } = setup({ callId: 'call_1', meeting: room.meeting, isDirect: true, inRoom: true });

    rerender({ callId: 'call_1', meeting: room.meeting, isDirect: true, inRoom: false });
    room.leave(other.id);
    wait(PEER_GONE_GRACE_MS * 3);
    expect(onHangUp).not.toHaveBeenCalled();

    // Back in, and they really are gone.
    rerender({ callId: 'call_1', meeting: room.meeting, isDirect: true, inRoom: true });
    wait(PEER_GONE_GRACE_MS);
    expect(onHangUp).toHaveBeenCalledTimes(1);
  });

  it('hangs up after a rejoin with a new client when the other person left meanwhile', () => {
    const first = fakeRoom([other]);
    const { onHangUp, rerender } = setup({ callId: 'call_1', meeting: first.meeting, isDirect: true, inRoom: true });

    const second = fakeRoom();
    rerender({ callId: 'call_1', meeting: second.meeting, isDirect: true, inRoom: false });
    rerender({ callId: 'call_1', meeting: second.meeting, isDirect: true, inRoom: true });
    wait(PEER_GONE_GRACE_MS);

    expect(onHangUp).toHaveBeenCalledTimes(1);
  });

  it('does not carry "they were here" over to the next call', () => {
    const first = fakeRoom([other]);
    const { onHangUp, rerender } = setup({ callId: 'call_1', meeting: first.meeting, isDirect: true, inRoom: true });

    // A new call, still ringing.
    const next = fakeRoom();
    rerender({ callId: 'call_2', meeting: next.meeting, isDirect: true, inRoom: true });
    wait(PEER_GONE_GRACE_MS * 3);

    expect(onHangUp).not.toHaveBeenCalled();
  });

  it('ignores our own earlier session still listed in the room', () => {
    const room = fakeRoom([other]);
    const { onHangUp } = setup({ callId: 'call_1', meeting: room.meeting, isDirect: true, inRoom: true });

    room.join({ id: 'peer_me_old', userId: 'u_me' });
    room.leave(other.id);
    wait(PEER_GONE_GRACE_MS);

    expect(onHangUp).toHaveBeenCalledTimes(1);
  });
});
