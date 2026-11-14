/**
 * The "take calls" switch: bound to the softphone, hidden without telephony,
 * with the softphone's state beside it and the microphone asked for on enable.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { getDefaultStore } from 'jotai';

vi.mock('@/lib/i18n', async () => {
  const { en: english } = await import('@weldsuite/i18n/locales/en');
  return { getTranslations: (ns: keyof typeof english) => english[ns] };
});
const perms = vi.hoisted(() => ({ canUpdate: true }));
vi.mock('@weldsuite/permissions/react', () => ({ useCan: () => perms.canUpdate }));

const toast = vi.hoisted(() => ({ warning: vi.fn(), error: vi.fn() }));
vi.mock('sonner', () => ({ toast }));

const softphone = vi.hoisted(() => ({
  data: undefined as undefined | { configured: boolean; available: boolean; registered: boolean; sipUsername: string | null },
}));
const setAvailable = vi.hoisted(() => ({ mutateAsync: vi.fn(), isPending: false }));
vi.mock('@/hooks/queries/use-desk-phone-queries', () => ({
  useDeskSoftphone: () => ({ data: softphone.data }),
  useSetDeskSoftphoneAvailable: () => setAvailable,
}));

const requestMic = vi.hoisted(() => vi.fn());
vi.mock('./use-microphone-permission', () => ({
  useMicrophonePermission: () => ({ permission: 'granted', request: requestMic }),
}));

import { DeskTakeCallsSwitch } from './desk-take-calls-switch';
import { deskSoftphoneRetryAtom, deskSoftphoneStatusAtom } from './desk-phone-state';

const store = getDefaultStore();

beforeEach(() => {
  perms.canUpdate = true;
  softphone.data = { configured: true, available: false, registered: false, sipUsername: null };
  setAvailable.mutateAsync.mockReset();
  setAvailable.mutateAsync.mockResolvedValue(undefined);
  requestMic.mockReset();
  requestMic.mockResolvedValue(true);
  toast.warning.mockReset();
  toast.error.mockReset();
  store.set(deskSoftphoneStatusAtom, 'off');
  store.set(deskSoftphoneRetryAtom, 0);
});

describe('DeskTakeCallsSwitch', () => {
  it('is hidden while the softphone is unknown or telephony is not set up', () => {
    softphone.data = undefined;
    const first = render(<DeskTakeCallsSwitch />);
    expect(first.container).toBeEmptyDOMElement();
    first.unmount();

    softphone.data = { configured: false, available: false, registered: false, sipUsername: null };
    const second = render(<DeskTakeCallsSwitch />);
    expect(second.container).toBeEmptyDOMElement();
  });

  it('shows the state of the member switch', () => {
    softphone.data = { configured: true, available: true, registered: true, sipUsername: 'sip_me' };
    render(<DeskTakeCallsSwitch />);
    expect(screen.getByTestId('desk-take-calls-switch')).toBeChecked();
  });

  it('switches on: asks for the microphone, then saves', async () => {
    render(<DeskTakeCallsSwitch />);
    await act(async () => {
      fireEvent.click(screen.getByTestId('desk-take-calls-switch'));
    });
    expect(requestMic).toHaveBeenCalledTimes(1);
    expect(setAvailable.mutateAsync).toHaveBeenCalledWith(true);
    expect(toast.warning).not.toHaveBeenCalled();
  });

  it('still switches on when the microphone is blocked, and says so', async () => {
    requestMic.mockResolvedValue(false);
    render(<DeskTakeCallsSwitch />);
    await act(async () => {
      fireEvent.click(screen.getByTestId('desk-take-calls-switch'));
    });
    expect(toast.warning).toHaveBeenCalledWith(expect.stringMatching(/microphone/i));
    expect(setAvailable.mutateAsync).toHaveBeenCalledWith(true);
  });

  it('switches off without asking for the microphone', async () => {
    softphone.data = { configured: true, available: true, registered: true, sipUsername: 'sip_me' };
    render(<DeskTakeCallsSwitch />);
    await act(async () => {
      fireEvent.click(screen.getByTestId('desk-take-calls-switch'));
    });
    expect(requestMic).not.toHaveBeenCalled();
    expect(setAvailable.mutateAsync).toHaveBeenCalledWith(false);
  });

  it('reports a failed save', async () => {
    setAvailable.mutateAsync.mockRejectedValue(new Error('nope'));
    render(<DeskTakeCallsSwitch />);
    await act(async () => {
      fireEvent.click(screen.getByTestId('desk-take-calls-switch'));
    });
    expect(toast.error).toHaveBeenCalled();
  });

  it('cannot be switched without the permission', () => {
    perms.canUpdate = false;
    render(<DeskTakeCallsSwitch />);
    expect(screen.getByTestId('desk-take-calls-switch')).toBeDisabled();
  });

  it.each([
    ['connecting', 'Connecting'],
    ['connected', 'Connected'],
    ['mic_blocked', 'Microphone blocked'],
    ['failed', 'Not connected'],
  ] as const)('shows the %s state', (status, text) => {
    softphone.data = { configured: true, available: true, registered: true, sipUsername: 'sip_me' };
    store.set(deskSoftphoneStatusAtom, status);
    render(<DeskTakeCallsSwitch />);
    expect(screen.getByTestId('desk-take-calls-status')).toHaveTextContent(text);
  });

  it('shows no state while the switch is off, and offers "try again" after a failure', () => {
    store.set(deskSoftphoneStatusAtom, 'connected');
    const off = render(<DeskTakeCallsSwitch />);
    expect(screen.queryByTestId('desk-take-calls-status')).toBeNull();
    off.unmount();

    softphone.data = { configured: true, available: true, registered: true, sipUsername: 'sip_me' };
    store.set(deskSoftphoneStatusAtom, 'failed');
    render(<DeskTakeCallsSwitch />);
    act(() => {
      fireEvent.click(screen.getByTestId('desk-take-calls-retry'));
    });
    expect(store.get(deskSoftphoneRetryAtom)).toBe(1);
  });
});
