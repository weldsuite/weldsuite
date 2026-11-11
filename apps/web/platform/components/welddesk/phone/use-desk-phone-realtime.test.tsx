/**
 * The member's personal phone events: `phone.incoming` fills the caller
 * details, `phone.ended` records why a ring ended, and `phone.answered` opens
 * the conversation unless it is already open.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { getDefaultStore } from 'jotai';

type Handler = (event: { topic: string; event: string; data: unknown; ts: number; userId: string }) => void;
const topic = vi.hoisted(() => ({ name: '', handler: null as Handler | null }));
vi.mock('@weldsuite/realtime/react', () => ({
  useTopic: (name: string, handler: Handler) => {
    topic.name = name;
    topic.handler = handler;
  },
}));
vi.mock('@/lib/auth', () => ({ useUser: () => ({ user: { id: 'user_me' } }) }));

const nav = vi.hoisted(() => ({ push: vi.fn(), pathname: '/welddesk/inbox' }));
vi.mock('@/lib/router', () => ({
  useRouter: () => ({ push: nav.push }),
  usePathname: () => nav.pathname,
}));

import { deskPhoneEndedAtom, deskPhoneIncomingAtom } from './desk-phone-state';
import { useDeskPhoneRealtime } from './use-desk-phone-realtime';

const store = getDefaultStore();

function send(event: string, data: unknown) {
  act(() => topic.handler?.({ topic: 'inbox.user_me', event, data, ts: Date.now(), userId: 'system' }));
}

beforeEach(() => {
  nav.push.mockReset();
  nav.pathname = '/welddesk/inbox';
  topic.name = '';
  topic.handler = null;
  store.set(deskPhoneIncomingAtom, null);
  store.set(deskPhoneEndedAtom, null);
});

describe('useDeskPhoneRealtime', () => {
  it('listens on the member\'s personal inbox topic', () => {
    renderHook(() => useDeskPhoneRealtime());
    expect(topic.name).toBe('inbox.user_me');
  });

  it('keeps the caller details of phone.incoming', () => {
    renderHook(() => useDeskPhoneRealtime());
    send('phone.incoming', {
      callId: 'call_1',
      conversationId: 'dconv_1',
      fromNumber: '+31612345678',
      callerName: 'Ann',
      customerName: null,
      departmentId: 'team_1',
      waitingSince: '2026-11-09T10:00:00.000Z',
    });
    expect(store.get(deskPhoneIncomingAtom)).toMatchObject({
      callId: 'call_1',
      conversationId: 'dconv_1',
      fromNumber: '+31612345678',
      callerName: 'Ann',
      customerName: null,
      departmentId: 'team_1',
      waitingSince: '2026-11-09T10:00:00.000Z',
    });
  });

  it('records why a ring ended, and ignores a reason it does not know', () => {
    renderHook(() => useDeskPhoneRealtime());
    send('phone.ended', { callId: 'call_1', reason: 'caller_hung_up' });
    expect(store.get(deskPhoneEndedAtom)).toMatchObject({ callId: 'call_1', reason: 'caller_hung_up' });

    store.set(deskPhoneEndedAtom, null);
    send('phone.ended', { callId: 'call_1', reason: 'something_else' });
    expect(store.get(deskPhoneEndedAtom)).toBeNull();
  });

  it('opens the conversation when this member answered', () => {
    renderHook(() => useDeskPhoneRealtime());
    send('phone.answered', { callId: 'call_1', conversationId: 'dconv_1', answeredByUserId: 'user_me' });
    expect(nav.push).toHaveBeenCalledWith('/welddesk/inbox/phone/dconv_1');
  });

  it('does not navigate when the conversation is already open', () => {
    nav.pathname = '/welddesk/inbox/phone/dconv_1';
    renderHook(() => useDeskPhoneRealtime());
    send('phone.answered', { callId: 'call_1', conversationId: 'dconv_1', answeredByUserId: 'user_me' });
    expect(nav.push).not.toHaveBeenCalled();
  });

  it('does not navigate for a call without a conversation', () => {
    renderHook(() => useDeskPhoneRealtime());
    send('phone.answered', { callId: 'call_1', conversationId: null, answeredByUserId: 'user_me' });
    expect(nav.push).not.toHaveBeenCalled();
  });

  it('ignores events without a call id', () => {
    renderHook(() => useDeskPhoneRealtime());
    send('phone.incoming', { fromNumber: '+3161' });
    expect(store.get(deskPhoneIncomingAtom)).toBeNull();
  });
});
