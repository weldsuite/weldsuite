/**
 * Click-to-call from a conversation: shown only with a number to call and one
 * to call from, signs the softphone in when it is not, and places the call
 * through the dialer with the conversation id so it lands on the timeline.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';

vi.mock('@/lib/i18n', async () => {
  const { en: english } = await import('@weldsuite/i18n/locales/en');
  return { getTranslations: (ns: keyof typeof english) => english[ns] };
});
const perms = vi.hoisted(() => ({ canCall: true }));
vi.mock('@weldsuite/permissions/react', () => ({ useCan: () => perms.canCall }));
const toast = vi.hoisted(() => ({ error: vi.fn() }));
vi.mock('sonner', () => ({ toast }));

const call = vi.hoisted(() => ({
  callState: null as object | null,
  isVoipReady: true,
  voipConnection: 'ready' as string,
  initializeVoip: vi.fn(),
  waitForVoipReady: vi.fn(),
}));
vi.mock('@/contexts/call-context', () => ({ useCall: () => call }));

const dial = vi.hoisted(() => vi.fn());
const dialing = vi.hoisted(() => ({ isDialing: false }));
vi.mock('@/components/weldcrm/calls/call-dialing', () => ({
  usePlaceCall: () => ({ isDialing: dialing.isDialing, dial }),
  formatPhoneDisplay: (n: string) => n,
}));

const numbers = vi.hoisted(() => ({ data: undefined as undefined | { data: object[] } }));
vi.mock('@/hooks/queries/use-voip-calls-queries', () => ({ useVoipPhoneNumbers: () => ({ data: numbers.data }) }));

const fetchToken = vi.hoisted(() => vi.fn());
vi.mock('@/hooks/queries/use-call-intelligence-queries', () => ({
  useFetchVoiceToken: () => ({ mutateAsync: fetchToken }),
}));

const person = vi.hoisted(() => ({ data: undefined as undefined | { data: object }, enabled: [] as boolean[] }));
vi.mock('@/components/objects/person/use-person-data', () => ({
  usePerson: (_id: string, enabled: boolean) => {
    person.enabled.push(enabled);
    return { data: enabled ? person.data : undefined };
  },
}));

import type { DeskConversation } from '@/hooks/queries/use-desk-queries';
import { DeskCallButton } from './desk-call-button';

function conversation(overrides: Partial<DeskConversation> = {}): DeskConversation {
  return {
    id: 'dconv_1',
    channel: 'phone',
    name: '+31612345678',
    email: null,
    contactId: null,
    ...overrides,
  } as DeskConversation;
}

beforeEach(() => {
  perms.canCall = true;
  call.callState = null;
  call.isVoipReady = true;
  call.voipConnection = 'ready';
  call.initializeVoip.mockReset();
  call.initializeVoip.mockResolvedValue(undefined);
  call.waitForVoipReady.mockReset();
  call.waitForVoipReady.mockResolvedValue(true);
  dial.mockReset();
  dial.mockResolvedValue(undefined);
  dialing.isDialing = false;
  numbers.data = {
    data: [
      { phoneNumber: '+31200000001', status: 'active', allowOutbound: true },
      { phoneNumber: '+31200000002', status: 'active', allowOutbound: true, isDefault: true },
    ],
  };
  fetchToken.mockReset();
  fetchToken.mockResolvedValue({ token: 'shared-token' });
  person.data = undefined;
  person.enabled = [];
  toast.error.mockReset();
});

describe('DeskCallButton', () => {
  it('calls from the default number and logs the call on the conversation', async () => {
    render(<DeskCallButton conversation={conversation()} />);
    await act(async () => {
      fireEvent.click(screen.getByTestId('desk-inbox-call'));
    });
    expect(dial).toHaveBeenCalledWith({
      toNumber: '+31612345678',
      fromNumber: '+31200000002',
      enableRecording: true,
      deskConversationId: 'dconv_1',
    });
    expect(call.initializeVoip).not.toHaveBeenCalled();
  });

  it('calls the caller from the timeline, from the number they called', async () => {
    const messages = [
      { metadata: { event: 'call_started', fromNumber: '+31655555555', toNumber: '+31200000001' } },
    ] as never;
    render(<DeskCallButton conversation={conversation({ name: 'Ann Caller' })} messages={messages} />);
    await act(async () => {
      fireEvent.click(screen.getByTestId('desk-inbox-call'));
    });
    expect(dial).toHaveBeenCalledWith(
      expect.objectContaining({ toNumber: '+31655555555', fromNumber: '+31200000001', deskConversationId: 'dconv_1' }),
    );
  });

  it('names the number it will call', () => {
    render(<DeskCallButton conversation={conversation()} />);
    expect(screen.getByTestId('desk-inbox-call')).toHaveAttribute('title', 'Call +31612345678');
  });

  it('calls the linked contact of a conversation that is not a phone one', async () => {
    person.data = { data: { mobilePhone: '+31 6 99 88 77 66' } };
    render(<DeskCallButton conversation={conversation({ channel: 'email', name: 'Ann', contactId: 'con_1' })} />);
    await act(async () => {
      fireEvent.click(screen.getByTestId('desk-inbox-call'));
    });
    expect(dial).toHaveBeenCalledWith(expect.objectContaining({ toNumber: '+31699887766', deskConversationId: 'dconv_1' }));
  });

  it('does not look up a contact when the conversation already has the number', () => {
    render(<DeskCallButton conversation={conversation({ contactId: 'con_1' })} />);
    expect(person.enabled.every((enabled) => !enabled)).toBe(true);
  });

  it('signs the softphone in first when it is not ready, then calls', async () => {
    call.isVoipReady = false;
    call.voipConnection = 'idle';
    render(<DeskCallButton conversation={conversation()} />);
    await act(async () => {
      fireEvent.click(screen.getByTestId('desk-inbox-call'));
    });
    expect(call.initializeVoip).toHaveBeenCalledWith('shared-token');
    expect(call.waitForVoipReady).toHaveBeenCalled();
    expect(dial).toHaveBeenCalledTimes(1);
  });

  it('waits for the member login that is already on its way instead of starting another', async () => {
    call.isVoipReady = false;
    call.voipConnection = 'connecting';
    render(<DeskCallButton conversation={conversation()} />);
    await act(async () => {
      fireEvent.click(screen.getByTestId('desk-inbox-call'));
    });
    expect(fetchToken).not.toHaveBeenCalled();
    expect(call.waitForVoipReady).toHaveBeenCalled();
    expect(dial).toHaveBeenCalledTimes(1);
  });

  it('does not call, and says so, when the softphone cannot be signed in', async () => {
    call.isVoipReady = false;
    call.voipConnection = 'idle';
    call.waitForVoipReady.mockResolvedValue(false);
    render(<DeskCallButton conversation={conversation()} />);
    await act(async () => {
      fireEvent.click(screen.getByTestId('desk-inbox-call'));
    });
    expect(toast.error).toHaveBeenCalledWith(expect.stringMatching(/not connected/i));
    expect(dial).not.toHaveBeenCalled();
  });

  it('is disabled during a call and while dialing', () => {
    call.callState = {};
    const first = render(<DeskCallButton conversation={conversation()} />);
    expect(screen.getByTestId('desk-inbox-call')).toBeDisabled();
    first.unmount();

    call.callState = null;
    dialing.isDialing = true;
    render(<DeskCallButton conversation={conversation()} />);
    expect(screen.getByTestId('desk-inbox-call')).toBeDisabled();
  });

  it.each([
    ['no phone number on the conversation', { name: 'Ann Caller' }],
    ['an email conversation without a contact', { channel: 'email', name: 'Ann' }],
  ] as const)('is hidden with %s', (_label, overrides) => {
    const { container } = render(<DeskCallButton conversation={conversation(overrides as Partial<DeskConversation>)} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('is hidden when the workspace has no number to call from', () => {
    numbers.data = { data: [{ phoneNumber: '+31200000001', status: 'active', allowOutbound: false }] };
    const { container } = render(<DeskCallButton conversation={conversation()} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('is hidden for a member who cannot create calls', () => {
    perms.canCall = false;
    const { container } = render(<DeskCallButton conversation={conversation()} />);
    expect(container).toBeEmptyDOMElement();
  });
});
