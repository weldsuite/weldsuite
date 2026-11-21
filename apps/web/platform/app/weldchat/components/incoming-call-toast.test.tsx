import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

const call = vi.hoisted(() => ({
  incomingCall: null as null | { callerName: string; callerAvatar?: string; callType: 'voice' | 'video' },
  acceptIncomingCall: vi.fn(),
  declineCall: vi.fn(),
}));

vi.mock('@/contexts/weldchat-call-context', () => ({ useWeldChatCallOptional: () => call }));
vi.mock('@/lib/i18n/provider', () => ({
  useI18n: () => ({
    t: { weldchat: { incomingCall: { incomingVoice: 'Voice call', incomingVideo: 'Video call', accept: 'Accept', decline: 'Decline' } } },
  }),
}));

import { IncomingCallToast } from './incoming-call-toast';

beforeEach(() => {
  call.incomingCall = { callerName: 'Gert van den Berg', callType: 'voice' };
  call.acceptIncomingCall.mockReset();
  call.declineCall.mockReset();
});

describe('IncomingCallToast', () => {
  it('shows nothing while nobody calls', () => {
    call.incomingCall = null;
    const { container } = render(<IncomingCallToast />);
    expect(container.textContent).toBe('');
  });

  it('names the caller and the kind of call in one row', () => {
    render(<IncomingCallToast />);
    const toast = screen.getByRole('alertdialog', { name: 'Gert van den Berg' });
    expect(toast.textContent).toBe('GGert van den BergVoice call');
  });

  it('declines and accepts with its buttons', () => {
    render(<IncomingCallToast />);
    fireEvent.click(screen.getByRole('button', { name: 'Decline' }));
    expect(call.declineCall).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Accept' }));
    expect(call.acceptIncomingCall).toHaveBeenCalledTimes(1);
  });

  it('says video call for one', () => {
    call.incomingCall = { callerName: 'Gert van den Berg', callType: 'video' };
    render(<IncomingCallToast />);
    expect(screen.getByRole('alertdialog').textContent).toContain('Video call');
  });
});
