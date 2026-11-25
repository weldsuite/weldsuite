import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

const auth = vi.hoisted(() => ({ userId: 'user_me' }));
const callContext = vi.hoisted(() => ({ callId: null as string | null, joinCall: vi.fn() }));

vi.mock('@clerk/clerk-react', () => ({ useAuth: () => auth }));
vi.mock('@/lib/i18n/provider', () => ({
  useI18n: () => ({
    t: {
      weldchat: {
        callRoom: { participant: 'Participant' },
        messageItem: { viewProfile: 'View {name}\'s profile', pinnedMessage: 'Pinned a message.' },
        callHistory: {
          startedCall: 'Started a call.',
          startedCallLasted: 'Started a call that lasted {duration}.',
          calledNoAnswer: 'Called, but there was no answer.',
          calledDeclined: 'Called, but the call was declined.',
          missedCall: 'You missed the call.',
          declinedCall: 'You declined the call.',
          lastedSeconds: 'a few seconds',
          lastedMinute: 'a minute',
          lastedMinutes: '{count} minutes',
          lastedHour: 'an hour',
          lastedHours: '{count} hours',
          joinCall: 'Join call',
        },
      },
    },
    format: (text: string, values: Record<string, unknown>) =>
      text.replace(/\{(\w+)\}/g, (_, key: string) => String(values[key] ?? '')),
  }),
}));
const chat = vi.hoisted(() => ({ openUserProfile: vi.fn(), openAgentProfile: vi.fn() }));
vi.mock('./chat-context', () => ({ useChatContext: () => chat }));
vi.mock('./reaction-bar', () => ({ ReactionBar: () => null }));
vi.mock('./message-actions', () => ({ MessageActions: () => null }));
vi.mock('./message-context-menu', () => ({ MessageContextMenu: ({ children }: { children: unknown }) => children }));
vi.mock('./file-preview', () => ({ FilePreview: () => null }));
vi.mock('@tanstack/react-router', () => ({ Link: () => null }));
vi.mock('@/contexts/weldchat-call-context', () => ({ useWeldChatCallOptional: () => callContext }));
vi.mock('@/hooks/use-member-avatar', () => ({ useMemberAvatar: () => undefined }));

import { MessageItem } from './message-item';
import type { CallSummary } from '../lib/call-history';

const startNotice = { id: 'msg_1', type: 'system' as const, content: 'Gert started a voice call', createdAt: '2026-10-23T09:00:00Z' };

function renderCall(call: CallSummary, hasActiveCall = false, extra: { activeCallId?: string } = {}) {
  render(<MessageItem message={startNotice} call={call} hasActiveCall={hasActiveCall} {...extra} />);
  return screen.getByTestId('chat-call-notice');
}

const base: CallSummary = {
  callType: 'voice',
  initiatorId: 'user_gert',
  initiatorName: 'Gert',
  startedAt: '2026-10-23T09:00:00Z',
};

afterEach(() => {
  cleanup();
  auth.userId = 'user_me';
  callContext.callId = null;
  callContext.joinCall.mockReset();
  chat.openUserProfile.mockReset();
});

describe('call notice row', () => {
  it('tells the person it rang that they missed it, with no ring time: the call never ran', () => {
    const row = renderCall({ ...base, outcome: 'missed', duration: 0, endedAt: '2026-10-23T09:00:30Z' });
    expect(row.dataset.callState).toBe('missed');
    expect(row.textContent).toContain('You missed the call.');
    expect(row.textContent).not.toContain('lasted');
  });

  it('tells the caller nobody answered: the call ended when nobody picked up', () => {
    auth.userId = 'user_gert';
    const row = renderCall({ ...base, outcome: 'missed', duration: 0, endedAt: '2026-10-23T09:00:30Z' });
    expect(row.dataset.callState).toBe('noAnswer');
    expect(row.textContent).toContain('Called, but there was no answer.');
    expect(row.textContent).not.toContain('lasted');
  });

  it('tells each side about a declined call', () => {
    const declined: CallSummary = { ...base, outcome: 'declined', duration: 0, endedAt: '2026-10-23T09:00:05Z' };
    const callee = renderCall(declined);
    expect(callee.dataset.callState).toBe('declined');
    expect(callee.textContent).toContain('You declined the call.');
    cleanup();
    auth.userId = 'user_gert';
    expect(renderCall(declined).textContent).toContain('Called, but the call was declined.');
  });

  it('reads as a message from the caller: their name, then how long the call lasted', () => {
    const row = renderCall({ ...base, outcome: 'answered', duration: 733, endedAt: '2026-10-23T09:12:13Z' });
    expect(row.dataset.callState).toBe('answered');
    expect(screen.getByRole('button', { name: 'Gert' })).toBeTruthy();
    expect(row.textContent).toContain('Started a call that lasted 12 minutes.');
  });

  it('drops the header right under an earlier message or call from the caller', () => {
    render(<MessageItem message={startNotice} call={{ ...base, outcome: 'answered', duration: 60 }} compact />);
    expect(screen.queryByRole('button', { name: 'Gert' })).toBeNull();
    expect(screen.getByTestId('chat-call-notice').textContent).toContain('Started a call that lasted a minute.');
  });

  it('rounds from 45 minutes up to hours, as Discord does', () => {
    expect(renderCall({ ...base, outcome: 'answered', duration: 2833 }).textContent).toContain('lasted an hour.');
    cleanup();
    expect(renderCall({ ...base, outcome: 'answered', duration: 3 * 3600 }).textContent).toContain('lasted 3 hours.');
  });

  it('opens the caller\'s profile from their name', () => {
    renderCall({ ...base, outcome: 'answered', duration: 60 });
    fireEvent.click(screen.getByRole('button', { name: 'Gert' }));
    expect(chat.openUserProfile).toHaveBeenCalledWith('user_gert');
  });

  it('says a live call was started, and offers Join call when you are not in it', () => {
    const live = renderCall(base, true, { activeCallId: 'call_1' });
    expect(live.dataset.callState).toBe('live');
    expect(live.textContent).toContain('Started a call.');
    fireEvent.click(screen.getByRole('button', { name: 'Join call' }));
    expect(callContext.joinCall).toHaveBeenCalledWith('call_1');
  });

  it('has no Join call while you are already in that call', () => {
    callContext.callId = 'call_1';
    renderCall(base, true, { activeCallId: 'call_1' });
    expect(screen.queryByRole('button', { name: 'Join call' })).toBeNull();
  });
});

describe('pin notice', () => {
  const pinNotice = {
    id: 'msg_pin',
    type: 'system' as const,
    content: '[system:msg_target] pinned a message',
    authorId: 'user_gert',
    authorName: 'Gert',
    createdAt: '2026-10-23T09:00:00Z',
  };

  it('reads as a message from who pinned it', () => {
    render(<MessageItem message={pinNotice} />);
    const row = screen.getByTestId('chat-pin-notice');
    expect(screen.getByRole('button', { name: 'Gert' })).toBeTruthy();
    expect(row.textContent).toContain('Pinned a message.');
    expect(row.textContent).not.toContain('pinned a message');
  });

  it('jumps to the pinned message', () => {
    const target = document.createElement('div');
    target.dataset.messageId = 'msg_target';
    target.scrollIntoView = vi.fn();
    document.body.appendChild(target);
    render(<MessageItem message={pinNotice} />);
    fireEvent.click(screen.getByRole('button', { name: 'Pinned a message.' }));
    expect(target.scrollIntoView).toHaveBeenCalled();
    target.remove();
  });

  it('drops the header right under an earlier message from the same person', () => {
    render(<MessageItem message={pinNotice} compact />);
    expect(screen.queryByRole('button', { name: 'Gert' })).toBeNull();
    expect(screen.getByTestId('chat-pin-notice').textContent).toContain('Pinned a message.');
  });
});
