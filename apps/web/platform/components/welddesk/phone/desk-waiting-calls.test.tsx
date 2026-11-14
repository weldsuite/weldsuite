/**
 * The waiting-calls strip: only when someone waits, a live-ticking wait, the
 * ringing marker, pickup (with the refusals worded), and a row that opens its
 * conversation.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { getDefaultStore } from 'jotai';
import { ApiError } from '@weldsuite/api-client';

vi.mock('@/lib/i18n', async () => {
  const { en: english } = await import('@weldsuite/i18n/locales/en');
  return { getTranslations: (ns: keyof typeof english) => english[ns] };
});
const perms = vi.hoisted(() => ({ canUpdate: true }));
vi.mock('@weldsuite/permissions/react', () => ({ useCan: () => perms.canUpdate }));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock('sonner', () => ({ toast }));
const nav = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock('@/lib/router', () => ({ useRouter: () => ({ push: nav.push }) }));
vi.mock('@/hooks/queries/use-desk-routing-queries', () => ({
  useDeskTeams: () => ({ data: [{ id: 'team_1', name: 'Billing' }] }),
}));

const now = vi.hoisted(() => ({ value: Date.parse('2026-11-09T10:01:05.000Z') }));
vi.mock('@/app/welddesk/inbox/sla-badge', () => ({ useNow: () => now.value }));

const queue = vi.hoisted(() => ({ data: undefined as unknown[] | undefined }));
const pickup = vi.hoisted(() => ({ mutateAsync: vi.fn(), isPending: false }));
vi.mock('@/hooks/queries/use-desk-phone-queries', async () => {
  const actual = await vi.importActual<typeof import('@/hooks/queries/use-desk-phone-queries')>(
    '@/hooks/queries/use-desk-phone-queries',
  );
  return {
    ...actual,
    useDeskPhoneQueue: () => ({ data: queue.data }),
    usePickupDeskPhoneCall: () => pickup,
  };
});

import { DeskWaitingCalls } from './desk-waiting-calls';
import { deskSoftphoneStatusAtom } from './desk-phone-state';

const store = getDefaultStore();

function waiting(overrides: Record<string, unknown> = {}) {
  return {
    callId: 'call_1',
    conversationId: 'dconv_1',
    fromNumber: '+31612345678',
    callerName: 'Ann Caller',
    departmentId: 'team_1',
    waitingSince: '2026-11-09T10:00:00.000Z',
    ringing: false,
    ...overrides,
  };
}

beforeEach(() => {
  perms.canUpdate = true;
  queue.data = [waiting()];
  pickup.mutateAsync.mockReset();
  pickup.mutateAsync.mockResolvedValue({ callId: 'call_1', ringing: true });
  toast.success.mockReset();
  toast.error.mockReset();
  nav.push.mockReset();
  now.value = Date.parse('2026-11-09T10:01:05.000Z');
  store.set(deskSoftphoneStatusAtom, 'connected');
});

describe('DeskWaitingCalls', () => {
  it('shows nothing while nobody waits', () => {
    queue.data = [];
    const { container } = render(<DeskWaitingCalls />);
    expect(container).toBeEmptyDOMElement();
  });

  it('lists the caller, number, team and wait so far', () => {
    render(<DeskWaitingCalls />);
    const row = screen.getByTestId('desk-waiting-call');
    expect(row).toHaveTextContent('Ann Caller');
    expect(row).toHaveTextContent('+31612345678');
    expect(row).toHaveTextContent('Billing');
    expect(screen.getByTestId('desk-waiting-call-time')).toHaveTextContent('Waiting 1:05');
    expect(screen.queryByTestId('desk-waiting-call-ringing')).toBeNull();
  });

  it('marks a call that is ringing, and uses the number when the caller has no name', () => {
    queue.data = [waiting({ callerName: null, ringing: true })];
    render(<DeskWaitingCalls />);
    expect(screen.getByTestId('desk-waiting-call-ringing')).toHaveTextContent('Ringing');
    expect(within(screen.getByTestId('desk-waiting-call')).getAllByText('+31612345678').length).toBeGreaterThan(0);
  });

  it('ticks the wait as time passes', () => {
    const { rerender } = render(<DeskWaitingCalls />);
    now.value += 10_000;
    rerender(<DeskWaitingCalls />);
    expect(screen.getByTestId('desk-waiting-call-time')).toHaveTextContent('Waiting 1:15');
  });

  it('opens the conversation of a row', () => {
    render(<DeskWaitingCalls />);
    fireEvent.click(screen.getByTestId('desk-waiting-call-open'));
    expect(nav.push).toHaveBeenCalledWith('/welddesk/inbox/phone/dconv_1');
  });

  it('picks up: rings this browser', async () => {
    render(<DeskWaitingCalls />);
    await act(async () => {
      fireEvent.click(screen.getByTestId('desk-waiting-call-pickup'));
    });
    expect(pickup.mutateAsync).toHaveBeenCalledWith('call_1');
    expect(toast.success).toHaveBeenCalledWith('Your browser is ringing.');
  });

  it.each([
    [new ApiError('x', 409, { error: { message: 'The call is no longer waiting' } }), 'The call is no longer waiting.'],
    [
      new ApiError('x', 409, { error: { message: 'The call cannot be picked up yet' } }),
      'The call cannot be picked up yet. Try again in a moment.',
    ],
    [
      new ApiError('x', 409, { error: { message: 'You have no softphone credential yet' } }),
      'Your softphone is not set up yet. Switch on "Take calls" first.',
    ],
    [
      new ApiError('x', 400, { error: { message: 'Phone service is not activated' } }),
      'Phone service is not activated for this workspace.',
    ],
    [
      new ApiError('x', 502, { error: { message: 'Could not ring your softphone' } }),
      'Could not ring your browser. Try again.',
    ],
    [new Error('offline'), 'Could not pick up the call.'],
  ])('words a refused pickup (%#)', async (error, text) => {
    pickup.mutateAsync.mockRejectedValue(error);
    render(<DeskWaitingCalls />);
    await act(async () => {
      fireEvent.click(screen.getByTestId('desk-waiting-call-pickup'));
    });
    expect(toast.error).toHaveBeenCalledWith(text);
  });

  it('cannot pick up while the softphone is not connected, and says what to do', () => {
    store.set(deskSoftphoneStatusAtom, 'off');
    render(<DeskWaitingCalls />);
    expect(screen.getByTestId('desk-waiting-call-pickup')).toBeDisabled();
    expect(screen.getByTestId('desk-waiting-calls-hint')).toBeInTheDocument();
  });

  it('cannot pick up without the permission, and shows no hint about the switch', () => {
    perms.canUpdate = false;
    render(<DeskWaitingCalls />);
    expect(screen.getByTestId('desk-waiting-call-pickup')).toBeDisabled();
    expect(screen.queryByTestId('desk-waiting-calls-hint')).toBeNull();
  });
});
