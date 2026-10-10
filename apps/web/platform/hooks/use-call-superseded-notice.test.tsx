/**
 * Pairs the server's `call_superseded` event with the RealtimeKit kick it
 * announces, so a user who joined another call is told why they were dropped
 * instead of being shown the generic "the host ended the meeting".
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';

const realtime = vi.hoisted(() => ({
  subscribers: new Set<{ topic: string; handler: (event: unknown) => void }>(),
}));
const toast = vi.hoisted(() => ({ info: vi.fn() }));

vi.mock('sonner', () => ({ toast }));
vi.mock('@weldsuite/realtime/react', async () => {
  const React = await import('react');
  return {
    useTopic: (topic: string, handler: (event: unknown) => void) => {
      const latest = React.useRef(handler);
      latest.current = handler;
      React.useEffect(() => {
        const subscriber = { topic, handler: (event: unknown) => latest.current(event) };
        realtime.subscribers.add(subscriber);
        return () => {
          realtime.subscribers.delete(subscriber);
        };
      }, [topic]);
    },
  };
});

import {
  EVENT_TTL_MS,
  KICK_GRACE_MS,
  rtkParticipantIds,
  useCallSupersededNotice,
  type SupersedeTarget,
} from './use-call-superseded-notice';

const MESSAGE = 'You left this call because you joined another call or meeting.';
const TOPIC = 'chat.user.user_me';

function publish(data: Record<string, unknown>) {
  act(() => {
    for (const subscriber of realtime.subscribers) {
      if (subscriber.topic === TOPIC) {
        subscriber.handler({ topic: TOPIC, event: 'call_superseded', data, ts: 0, userId: 'user_me' });
      }
    }
  });
}

/** This tab: session `ses_1`, RealtimeKit participant `peer_1` / `user_1`. */
const THIS_TAB: SupersedeTarget = { sessionId: 'ses_1', participantIds: ['peer_1', 'user_1'] };

function setup(kind: 'chat' | 'meet' = 'meet') {
  return renderHook(() => useCallSupersededNotice({ kind, userId: 'user_me', message: () => MESSAGE }));
}

beforeEach(() => {
  vi.useFakeTimers();
  realtime.subscribers.clear();
  toast.info.mockClear();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('useCallSupersededNotice', () => {
  it('listens on the personal chat topic of the user, and nowhere without one', () => {
    setup();
    expect([...realtime.subscribers].map((s) => s.topic)).toEqual([TOPIC]);

    realtime.subscribers.clear();
    renderHook(() => useCallSupersededNotice({ kind: 'meet', userId: undefined, message: () => MESSAGE }));
    expect([...realtime.subscribers].map((s) => s.topic)).toEqual(['']);
  });

  it('explains a kick that the event announced first', () => {
    const { result } = setup();
    publish({ kind: 'meet', id: 'ses_1', cfSessionId: 'user_1' });
    const fallback = vi.fn();

    result.current.explainExit(THIS_TAB, fallback);
    act(() => vi.advanceTimersByTime(KICK_GRACE_MS * 2));

    expect(toast.info).toHaveBeenCalledWith(MESSAGE);
    expect(fallback).not.toHaveBeenCalled();
  });

  it('explains a kick whose event arrives within the grace period', () => {
    const { result } = setup();
    const fallback = vi.fn();

    result.current.explainExit(THIS_TAB, fallback);
    act(() => vi.advanceTimersByTime(KICK_GRACE_MS - 100));
    publish({ kind: 'meet', id: 'ses_1', cfSessionId: 'peer_1' });
    act(() => vi.advanceTimersByTime(KICK_GRACE_MS * 2));

    expect(toast.info).toHaveBeenCalledTimes(1);
    expect(toast.info).toHaveBeenCalledWith(MESSAGE);
    expect(fallback).not.toHaveBeenCalled();
  });

  it('falls back to the caller message when no event comes (a host removal)', () => {
    const { result } = setup();
    const fallback = vi.fn();

    result.current.explainExit(THIS_TAB, fallback);
    expect(fallback).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(KICK_GRACE_MS));

    expect(fallback).toHaveBeenCalledTimes(1);
    expect(toast.info).not.toHaveBeenCalled();
  });

  it('forgets an event after a while, so a later host removal is not mislabelled', () => {
    const { result } = setup();
    publish({ kind: 'meet', id: 'ses_1', cfSessionId: 'user_1' });
    act(() => vi.advanceTimersByTime(EVENT_TTL_MS + 1));
    const fallback = vi.fn();

    result.current.explainExit(THIS_TAB, fallback);
    act(() => vi.advanceTimersByTime(KICK_GRACE_MS));

    expect(fallback).toHaveBeenCalledTimes(1);
    expect(toast.info).not.toHaveBeenCalled();
  });

  it('ignores the event of a second tab: it names another participant of the same session', () => {
    const { result } = setup();
    publish({ kind: 'meet', id: 'ses_1', cfSessionId: 'peer_in_the_other_tab' });
    const fallback = vi.fn();

    result.current.explainExit(THIS_TAB, fallback);
    act(() => vi.advanceTimersByTime(KICK_GRACE_MS));

    expect(toast.info).not.toHaveBeenCalled();
    expect(fallback).toHaveBeenCalledTimes(1);
  });

  it('matches on the session id when the event names no participant', () => {
    const { result } = setup();
    publish({ kind: 'meet', id: 'ses_1', cfSessionId: null });

    result.current.explainExit(THIS_TAB);

    expect(toast.info).toHaveBeenCalledWith(MESSAGE);
  });

  it('only reacts to its own kind', () => {
    const { result } = setup('chat');
    publish({ kind: 'meet', id: 'ses_1', cfSessionId: null });

    result.current.explainExit(THIS_TAB);
    act(() => vi.advanceTimersByTime(KICK_GRACE_MS));

    expect(toast.info).not.toHaveBeenCalled();
  });

  it('drops pending timers when it unmounts', () => {
    const { result, unmount } = setup();
    const fallback = vi.fn();
    result.current.explainExit(THIS_TAB, fallback);

    unmount();
    act(() => vi.advanceTimersByTime(KICK_GRACE_MS * 2));

    expect(fallback).not.toHaveBeenCalled();
  });
});

describe('rtkParticipantIds', () => {
  it('returns both ids the server may have stored', () => {
    const client = { self: { id: 'peer_1', userId: 'user_1' } };
    expect(rtkParticipantIds(client as Parameters<typeof rtkParticipantIds>[0])).toEqual(['peer_1', 'user_1']);
  });

  it('is empty for a client that is gone or has no ids', () => {
    expect(rtkParticipantIds(null)).toEqual([]);
    expect(rtkParticipantIds({ self: {} } as Parameters<typeof rtkParticipantIds>[0])).toEqual([]);
  });
});
