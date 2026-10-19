/**
 * The call's connection indicator (`useConnectionQuality` + `ConnectionIndicator`
 * from @weldsuite/weldmeet-ui, shown in the WeldChat call header and PiP):
 * RealtimeKit's media scores, its reconnects and the browser's offline state
 * become one level, and people whose stream arrives poorly are singled out.
 */

import { describe, it, expect } from 'vitest';
import { act, render, renderHook, screen } from '@testing-library/react';
import {
  ConnectionIndicator,
  useConnectionQuality,
  type ConnectionQuality,
  type MeetingClient,
} from '@weldsuite/weldmeet-ui';

type Handler = (payload?: Record<string, unknown>) => void;

function emitter() {
  const handlers = new Map<string, Set<Handler>>();
  return {
    on: (event: string, handler: Handler) => {
      if (!handlers.has(event)) handlers.set(event, new Set());
      handlers.get(event)?.add(handler);
    },
    off: (event: string, handler: Handler) => {
      handlers.get(event)?.delete(handler);
    },
    emit: (event: string, payload?: Record<string, unknown>) => {
      act(() => {
        for (const handler of handlers.get(event) ?? []) handler(payload);
      });
    },
    count: (event: string) => handlers.get(event)?.size ?? 0,
  };
}

function fakeMeeting() {
  const self = emitter();
  const joined = emitter();
  const meeting = { self, participants: { joined } } as unknown as MeetingClient;
  return { meeting, self, joined };
}

const selfScore = (kind: string, score: number, extra: Record<string, unknown> = {}) => ({
  kind,
  score,
  isScreenshare: false,
  participantId: 'me',
  ...extra,
});

describe('useConnectionQuality', () => {
  it('is unknown until RealtimeKit reports a score', () => {
    const { meeting } = fakeMeeting();
    const { result } = renderHook(() => useConnectionQuality(meeting));
    expect(result.current.level).toBe('unknown');
  });

  it('rates your connection by the worse of your microphone and camera', () => {
    const { meeting, self } = fakeMeeting();
    const { result } = renderHook(() => useConnectionQuality(meeting));

    self.emit('mediaScoreUpdate', selfScore('audio', 9));
    expect(result.current.level).toBe('good');

    self.emit('mediaScoreUpdate', selfScore('video', 5, { scoreStats: { packetsLostPercentage: 3.14 } }));
    expect(result.current.level).toBe('fair');
    expect(result.current.packetLossPercent).toBe(3.1);

    self.emit('mediaScoreUpdate', selfScore('video', 2));
    expect(result.current.level).toBe('poor');
  });

  it('ignores the score of a screen share', () => {
    const { meeting, self } = fakeMeeting();
    const { result } = renderHook(() => useConnectionQuality(meeting));

    self.emit('mediaScoreUpdate', selfScore('audio', 9));
    self.emit('mediaScoreUpdate', selfScore('video', 1, { isScreenshare: true }));

    expect(result.current.level).toBe('good');
  });

  it('shows reconnecting while the SDK gets back into the room, and starts over once it is in', () => {
    const { meeting, self } = fakeMeeting();
    const { result } = renderHook(() => useConnectionQuality(meeting));
    self.emit('mediaScoreUpdate', selfScore('audio', 2));

    self.emit('roomLeft', { state: 'disconnected' });
    expect(result.current.level).toBe('reconnecting');

    self.emit('roomJoined', { reconnected: true });
    expect(result.current.level).toBe('unknown');
  });

  it('shows offline when the browser loses the network', () => {
    const { meeting, self } = fakeMeeting();
    const { result } = renderHook(() => useConnectionQuality(meeting));
    self.emit('mediaScoreUpdate', selfScore('audio', 9));

    act(() => {
      window.dispatchEvent(new Event('offline'));
    });
    expect(result.current.level).toBe('offline');

    act(() => {
      window.dispatchEvent(new Event('online'));
    });
    expect(result.current.level).toBe('good');
  });

  it('singles out the people whose stream reaches you poorly, until they leave', () => {
    const { meeting, joined } = fakeMeeting();
    const { result } = renderHook(() => useConnectionQuality(meeting));

    joined.emit('mediaScoreUpdate', { kind: 'audio', score: 2, isScreenshare: false, participantId: 'peer_bob' });
    joined.emit('mediaScoreUpdate', { kind: 'audio', score: 9, isScreenshare: false, participantId: 'peer_eve' });
    expect([...result.current.poorPeerIds]).toEqual(['peer_bob']);

    joined.emit('participantLeft', { id: 'peer_bob' });
    expect(result.current.poorPeerIds.size).toBe(0);
  });

  it('stops listening when the call goes away', () => {
    const { meeting, self, joined } = fakeMeeting();
    const { unmount } = renderHook(() => useConnectionQuality(meeting));
    expect(self.count('mediaScoreUpdate')).toBe(1);

    unmount();

    expect(self.count('mediaScoreUpdate')).toBe(0);
    expect(joined.count('mediaScoreUpdate')).toBe(0);
  });
});

describe('ConnectionIndicator', () => {
  const quality = (patch: Partial<ConnectionQuality>): ConnectionQuality => ({
    level: 'good',
    score: 9,
    packetLossPercent: null,
    poorPeerIds: new Set(),
    ...patch,
  });

  it('stays quiet (bars only) while the connection is good', () => {
    render(<ConnectionIndicator quality={quality({})} labels={{ connection: 'Verbinding', good: 'Goed' }} />);
    const status = screen.getByRole('status');
    expect(status).toHaveAttribute('aria-label', 'Verbinding: Goed');
    expect(status).not.toHaveTextContent('Goed');
  });

  it('says what is wrong, with the packet loss, once it is not', () => {
    render(
      <ConnectionIndicator
        quality={quality({ level: 'poor', score: 2, packetLossPercent: 12 })}
        labels={{ connection: 'Connection', poor: 'Poor', packetLoss: 'Packet loss {value}%' }}
      />,
    );
    const status = screen.getByRole('status');
    expect(status).toHaveTextContent('Poor');
    expect(status).toHaveAttribute('title', 'Connection: Poor · Packet loss 12%');
  });
});
