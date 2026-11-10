/**
 * The incoming-call card: caller details from the realtime event next to the
 * SDK's ring, Accept and Decline, the ring sound, and the dismissal on
 * `phone.ended` with the reason.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { getDefaultStore } from 'jotai';

vi.mock('@/lib/i18n', async () => {
  const { en: english } = await import('@weldsuite/i18n/locales/en');
  return { getTranslations: (ns: keyof typeof english) => english[ns] };
});
vi.mock('@weldsuite/permissions/react', () => ({ useCan: () => true }));
vi.mock('@/hooks/use-is-app-installed', () => ({ useIsAppInstalled: () => true }));
vi.mock('@/hooks/queries/use-desk-routing-queries', () => ({
  useDeskTeams: () => ({ data: [{ id: 'team_1', name: 'Billing' }] }),
}));
vi.mock('@/app/welddesk/inbox/sla-badge', () => ({ useNow: () => Date.now() }));

const notify = vi.hoisted(() => vi.fn());
vi.mock('@/lib/desktop-notifications', () => ({ showOsNotification: notify }));
const ringSound = vi.hoisted(() => vi.fn());
vi.mock('@/lib/utils/notification-sound', () => ({ playIncomingRingSound: ringSound }));
const toastError = vi.hoisted(() => vi.fn());
vi.mock('sonner', () => ({ toast: { error: toastError } }));

const mic = vi.hoisted(() => ({ permission: 'granted' as string }));
vi.mock('./use-microphone-permission', () => ({
  useMicrophonePermission: () => ({ permission: mic.permission, request: vi.fn() }),
}));

interface Ring {
  id: string;
  fromNumber: string;
  callerName: string | null;
  receivedAt: Date;
}
const call = vi.hoisted(() => ({
  incomingCall: null as Ring | null,
  acceptIncomingCall: vi.fn(),
  declineIncomingCall: vi.fn(),
}));
vi.mock('@/contexts/call-context', () => ({ useCallSafe: () => call }));

import { DeskIncomingCallCard, pairIncoming } from './desk-incoming-call-card';
import { deskPhoneEndedAtom, deskPhoneIncomingAtom, type DeskPhoneIncoming } from './desk-phone-state';

const store = getDefaultStore();

function ringing(overrides: Partial<Ring> = {}): Ring {
  return { id: 'telnyx_1', fromNumber: '+31612345678', callerName: null, receivedAt: new Date(), ...overrides };
}

function incoming(overrides: Partial<DeskPhoneIncoming> = {}): DeskPhoneIncoming {
  return {
    callId: 'call_1',
    conversationId: 'dconv_1',
    fromNumber: '+31612345678',
    callerName: 'Ann Caller',
    customerName: 'Acme BV',
    departmentId: 'team_1',
    waitingSince: new Date(Date.now() - 65_000).toISOString(),
    receivedAt: Date.now(),
    ...overrides,
  };
}

beforeEach(() => {
  call.incomingCall = null;
  call.acceptIncomingCall.mockReset();
  call.declineIncomingCall.mockReset();
  notify.mockReset();
  ringSound.mockReset();
  toastError.mockReset();
  mic.permission = 'granted';
  store.set(deskPhoneIncomingAtom, null);
  store.set(deskPhoneEndedAtom, null);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('pairIncoming', () => {
  it('pairs an event with the ring it arrived with, not with an old one', () => {
    const ring = { receivedAt: new Date() };
    expect(pairIncoming(ring, incoming())).not.toBeNull();
    expect(pairIncoming(ring, incoming({ receivedAt: Date.now() - 10 * 60_000 }))).toBeNull();
    expect(pairIncoming(null, incoming())).toBeNull();
    expect(pairIncoming(ring, null)).toBeNull();
  });
});

describe('DeskIncomingCallCard', () => {
  it('shows nothing while nothing rings', () => {
    const { container } = render(<DeskIncomingCallCard />);
    expect(container).toBeEmptyDOMElement();
  });

  it('shows who is calling from the realtime event, with the wait so far, and rings', () => {
    call.incomingCall = ringing();
    store.set(deskPhoneIncomingAtom, incoming());
    render(<DeskIncomingCallCard />);

    expect(screen.getByTestId('desk-incoming-call-name')).toHaveTextContent('Ann Caller');
    expect(screen.getByTestId('desk-incoming-call-customer')).toHaveTextContent('Acme BV');
    expect(screen.getByTestId('desk-incoming-call-number')).toHaveTextContent('+31612345678');
    expect(screen.getByTestId('desk-incoming-call-team')).toHaveTextContent('Billing');
    expect(screen.getByTestId('desk-incoming-call-waited')).toHaveTextContent('Waiting for 1:0');
    expect(ringSound).toHaveBeenCalled();
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ tag: 'desk-phone-incoming' }));
  });

  it('shows the SDK caller id until the event arrives', () => {
    call.incomingCall = ringing({ callerName: 'Remote Name' });
    render(<DeskIncomingCallCard />);
    expect(screen.getByTestId('desk-incoming-call-name')).toHaveTextContent('Remote Name');
    expect(screen.queryByTestId('desk-incoming-call-waited')).toBeNull();

    act(() => {
      store.set(deskPhoneIncomingAtom, incoming());
    });
    expect(screen.getByTestId('desk-incoming-call-name')).toHaveTextContent('Ann Caller');
  });

  it('keeps the ringtone going every few seconds and stops it when the ring ends', () => {
    vi.useFakeTimers();
    call.incomingCall = ringing();
    const { rerender } = render(<DeskIncomingCallCard />);
    expect(ringSound).toHaveBeenCalledTimes(1);
    act(() => {
      vi.advanceTimersByTime(5300);
    });
    expect(ringSound).toHaveBeenCalledTimes(3);

    call.incomingCall = null;
    rerender(<DeskIncomingCallCard />);
    act(() => {
      vi.advanceTimersByTime(10_000);
    });
    expect(ringSound).toHaveBeenCalledTimes(3);
  });

  it('accepts with what is known about the caller', async () => {
    call.incomingCall = ringing();
    call.acceptIncomingCall.mockResolvedValue({ success: true });
    store.set(deskPhoneIncomingAtom, incoming());
    render(<DeskIncomingCallCard />);

    await act(async () => {
      fireEvent.click(screen.getByTestId('desk-incoming-call-accept'));
    });
    expect(call.acceptIncomingCall).toHaveBeenCalledWith(
      expect.objectContaining({ callId: 'call_1', conversationId: 'dconv_1', customerName: 'Acme BV', departmentId: 'team_1' }),
    );
    expect(store.get(deskPhoneIncomingAtom)).toBeNull();
  });

  it('says why a call could not be answered', async () => {
    call.incomingCall = ringing();
    call.acceptIncomingCall.mockResolvedValue({ success: false, error: 'Microphone access denied.' });
    render(<DeskIncomingCallCard />);
    await act(async () => {
      fireEvent.click(screen.getByTestId('desk-incoming-call-accept'));
    });
    expect(toastError).toHaveBeenCalledWith('Microphone access denied.');
  });

  it('declines', () => {
    call.incomingCall = ringing();
    render(<DeskIncomingCallCard />);
    fireEvent.click(screen.getByTestId('desk-incoming-call-decline'));
    expect(call.declineIncomingCall).toHaveBeenCalledTimes(1);
  });

  it('warns when the microphone is blocked', () => {
    mic.permission = 'denied';
    call.incomingCall = ringing();
    render(<DeskIncomingCallCard />);
    expect(screen.getByText(/microphone is blocked/i)).toBeInTheDocument();
  });

  it('is dismissed on phone.ended, with the reason for a moment', () => {
    vi.useFakeTimers();
    call.incomingCall = ringing();
    store.set(deskPhoneIncomingAtom, incoming());
    const { rerender } = render(<DeskIncomingCallCard />);
    expect(screen.getByTestId('desk-incoming-call')).toBeInTheDocument();

    act(() => {
      store.set(deskPhoneEndedAtom, { callId: 'call_1', reason: 'answered_elsewhere', at: Date.now() });
    });
    expect(call.declineIncomingCall).toHaveBeenCalledTimes(1);

    // The SDK's ring goes away with the hang-up.
    call.incomingCall = null;
    rerender(<DeskIncomingCallCard />);
    expect(screen.queryByTestId('desk-incoming-call')).toBeNull();
    expect(screen.getByTestId('desk-incoming-call-ended')).toHaveTextContent('Answered by a colleague');

    act(() => {
      vi.advanceTimersByTime(4100);
    });
    expect(screen.queryByTestId('desk-incoming-call-ended')).toBeNull();
  });

  it.each([
    ['caller_hung_up', 'The caller hung up'],
    ['timeout', 'The call was not answered in time'],
  ] as const)('words the %s reason', (reason, text) => {
    call.incomingCall = ringing();
    store.set(deskPhoneIncomingAtom, incoming());
    const { rerender } = render(<DeskIncomingCallCard />);
    act(() => {
      store.set(deskPhoneEndedAtom, { callId: 'call_1', reason, at: Date.now() });
    });
    call.incomingCall = null;
    rerender(<DeskIncomingCallCard />);
    expect(screen.getByTestId('desk-incoming-call-ended')).toHaveTextContent(text);
  });

  it('ignores phone.ended for another call', () => {
    call.incomingCall = ringing();
    store.set(deskPhoneIncomingAtom, incoming());
    render(<DeskIncomingCallCard />);
    act(() => {
      store.set(deskPhoneEndedAtom, { callId: 'call_other', reason: 'caller_hung_up', at: Date.now() });
    });
    expect(call.declineIncomingCall).not.toHaveBeenCalled();
    expect(screen.getByTestId('desk-incoming-call')).toBeInTheDocument();
  });
});
