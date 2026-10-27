import { describe, expect, it } from 'vitest';
import {
  aggregateConnections,
  chosenStatusFromStored,
  effectivePresence,
  storedStatusFor,
  type ChosenStatus,
} from '@weldsuite/realtime/presence';
import { replyCode } from './close';
import { isConnectionStale, lastHeardFrom, newConnectionState, STALE_CONNECTION_MS } from './presence';

describe('replyCode', () => {
  it('never hands back a code a peer may not send', () => {
    expect([1000, 1001, 4000, 1005, 1006, 1015, 999, 5000].map(replyCode)).toEqual([
      1000, 1001, 4000, 1000, 1000, 1000, 1000, 1000,
    ]);
  });
});

describe('aggregateConnections', () => {
  const active = { idle: false, inCall: false };
  const idle = { idle: true, inCall: false };
  const call = { idle: true, inCall: true };

  it('is offline with no connection', () => {
    expect(aggregateConnections([])).toBeNull();
  });

  it('is online while any connection is in use', () => {
    expect(aggregateConnections([idle, active])).toBe('online');
  });

  it('is away once every connection is idle', () => {
    expect(aggregateConnections([idle, idle])).toBe('away');
  });

  it('is busy in a call on any connection', () => {
    expect(aggregateConnections([active, call])).toBe('busy');
  });
});

describe('effectivePresence', () => {
  it('is offline when not connected, whatever was chosen', () => {
    expect(effectivePresence('dnd', null)).toBe('offline');
    expect(effectivePresence('online', undefined)).toBe('offline');
  });

  it('follows live presence when nothing was chosen', () => {
    expect(effectivePresence('online', 'away')).toBe('away');
    expect(effectivePresence(null, 'busy')).toBe('busy');
  });

  it('shows a chosen status while connected', () => {
    expect(effectivePresence('dnd', 'online')).toBe('dnd');
    expect(effectivePresence('away', 'online')).toBe('away');
    expect(effectivePresence('offline', 'online')).toBe('offline');
  });
});

describe('chat_user_status mapping', () => {
  it('round-trips every choice', () => {
    const choices: ChosenStatus[] = ['online', 'busy', 'dnd', 'away', 'offline'];
    expect(choices.map((c) => chosenStatusFromStored(storedStatusFor(c)))).toEqual(choices);
  });

  it('reads what the old presence writers left behind as automatic', () => {
    expect(['online', 'offline', 'away', null, undefined].map((s) => chosenStatusFromStored(s))).toEqual([
      'online',
      'online',
      'online',
      'online',
      'online',
    ]);
  });

  it('treats an expired choice as automatic', () => {
    const now = Date.UTC(2026, 9, 27, 12);
    expect(chosenStatusFromStored('dnd', new Date(now - 1), now)).toBe('online');
    expect(chosenStatusFromStored('dnd', new Date(now + 60_000), now)).toBe('dnd');
  });
});

describe('stale connections', () => {
  it('counts a heartbeat ping as hearing from the client', () => {
    const state = newConnectionState(0);
    const pingedAt = new Date(STALE_CONNECTION_MS);
    expect(isConnectionStale(lastHeardFrom(state, null), STALE_CONNECTION_MS + 1)).toBe(true);
    expect(isConnectionStale(lastHeardFrom(state, pingedAt), STALE_CONNECTION_MS + 1)).toBe(false);
  });
});
