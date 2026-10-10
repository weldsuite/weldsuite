/**
 * The shared "switch call" dialog: names what is left and what is joined,
 * "Stay" keeps the live call, "Leave and join" leaves it and joins.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';

vi.mock('@/lib/i18n/provider', () => ({
  useI18n: () => ({
    t: {
      weldchat: {
        switchCallDialog: {
          title: 'Switch call?',
          titleMeeting: 'Switch to this meeting?',
          description: 'You can only be in one call or meeting at a time. Leave {current} and join {target}?',
          stay: 'Stay',
          leaveAndJoin: 'Leave and join',
        },
      },
    },
  }),
}));

import { CallSwitchDialog } from './call-switch-dialog';
import {
  ActiveCallProvider,
  useCallSwitchOptional,
  useRegisterActiveCall,
} from '@/contexts/active-call-context';

let switchApi: ReturnType<typeof useCallSwitchOptional>;
function Probe() {
  switchApi = useCallSwitchOptional();
  return null;
}

const leave = vi.fn(async () => undefined);
function LiveMeeting() {
  useRegisterActiveCall('meet', { id: 'mtg_1', label: 'the meeting "Standup"', leave });
  return null;
}

function mount() {
  render(
    <ActiveCallProvider>
      <Probe />
      <LiveMeeting />
      <CallSwitchDialog />
    </ActiveCallProvider>,
  );
}

beforeEach(() => {
  leave.mockClear();
});

describe('CallSwitchDialog', () => {
  it('renders nothing until a switch is requested', () => {
    mount();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('asks which call is left and which is joined', () => {
    mount();

    act(() => {
      switchApi.requestSwitch({ target: { kind: 'chat', label: 'the call with Alice' }, proceed: vi.fn() });
    });

    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(screen.getByText('Switch call?')).toBeTruthy();
    expect(
      screen.getByText(
        'You can only be in one call or meeting at a time. Leave the meeting "Standup" and join the call with Alice?',
      ),
    ).toBeTruthy();
  });

  it('is titled for a meeting when a meeting is the target', () => {
    mount();

    act(() => {
      switchApi.requestSwitch({ target: { kind: 'meet', label: 'the meeting "Retro"' }, proceed: vi.fn() });
    });

    expect(screen.getByText('Switch to this meeting?')).toBeTruthy();
  });

  it('keeps the live call on "Stay"', async () => {
    mount();
    const onCancel = vi.fn();
    const proceed = vi.fn();
    act(() => {
      switchApi.requestSwitch({ target: { kind: 'chat', label: 'Alice' }, proceed, onCancel });
    });

    fireEvent.click(screen.getByRole('button', { name: 'Stay' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(leave).not.toHaveBeenCalled();
    expect(proceed).not.toHaveBeenCalled();
  });

  it('leaves the live call, then joins, on "Leave and join"', async () => {
    mount();
    const proceed = vi.fn();
    act(() => {
      switchApi.requestSwitch({ target: { kind: 'chat', label: 'Alice' }, proceed });
    });

    fireEvent.click(screen.getByRole('button', { name: 'Leave and join' }));

    await waitFor(() => expect(proceed).toHaveBeenCalledTimes(1));
    expect(leave).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });
});
