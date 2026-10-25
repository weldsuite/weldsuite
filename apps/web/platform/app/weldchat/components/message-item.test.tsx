import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

const auth = vi.hoisted(() => ({ userId: 'user_me' }));

vi.mock('@clerk/clerk-react', () => ({ useAuth: () => auth }));
vi.mock('@/lib/i18n/provider', () => ({
  useI18n: () => ({
    t: {
      weldchat: {
        callHistory: {
          youStartedVoice: 'You started a voice call',
          youStartedVideo: 'You started a video call',
          startedVoice: '{name} started a voice call',
          startedVideo: '{name} started a video call',
          missedVoiceFrom: 'Missed voice call from {name}',
          missedVideoFrom: 'Missed video call from {name}',
          missedCall: 'Missed call',
          callEnded: 'Call ended',
          noAnswer: 'No answer',
          declined: 'Declined',
          ended: 'Ended',
          live: 'Live',
          startedAt: 'Started {time}',
          endedAt: 'Ended {time}',
        },
      },
    },
    format: (text: string, values: Record<string, string>) =>
      text.replace(/\{(\w+)\}/g, (_, key: string) => values[key] ?? ''),
  }),
}));
vi.mock('./chat-context', () => ({ useChatContext: () => ({ openUserProfile: vi.fn(), openAgentProfile: vi.fn() }) }));
vi.mock('./reaction-bar', () => ({ ReactionBar: () => null }));
vi.mock('./message-actions', () => ({ MessageActions: () => null }));
vi.mock('./message-context-menu', () => ({ MessageContextMenu: ({ children }: { children: unknown }) => children }));
vi.mock('./file-preview', () => ({ FilePreview: () => null }));
vi.mock('@tanstack/react-router', () => ({ Link: () => null }));

import { MessageItem } from './message-item';
import type { CallSummary } from '../lib/call-history';

const startNotice = { id: 'msg_1', type: 'system' as const, content: 'Gert started a voice call', createdAt: '2026-10-23T09:00:00Z' };

function renderCall(call: CallSummary, hasActiveCall = false) {
  render(<MessageItem message={startNotice} call={call} hasActiveCall={hasActiveCall} />);
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
});

describe('call notice row', () => {
  it('tells the caller an unanswered call got no answer', () => {
    auth.userId = 'user_gert';
    const row = renderCall({ ...base, outcome: 'missed', duration: 0 });
    expect(row.dataset.callState).toBe('noAnswer');
    expect(row.textContent).toContain('You started a voice call');
    expect(row.textContent).toContain('No answer');
    expect(row.textContent).not.toContain('Missed');
  });

  it('shows the same call as missed to the person it rang', () => {
    const row = renderCall({ ...base, outcome: 'missed', duration: 0 });
    expect(row.dataset.callState).toBe('missed');
    expect(row.textContent).toContain('Missed voice call from Gert');
  });

  it('shows how long an answered call took, and when it started', () => {
    const row = renderCall({ ...base, outcome: 'answered', duration: 2833, endedAt: '2026-10-23T09:47:13Z' });
    expect(row.dataset.callState).toBe('answered');
    expect(row.textContent).toContain('Gert started a voice call');
    expect(row.textContent).toContain('47m 13s');
    expect(row.querySelector('time')?.getAttribute('dateTime')).toBe(base.startedAt);
  });

  it('marks a declined call and a live one', () => {
    expect(renderCall({ ...base, outcome: 'declined', duration: 0 }).textContent).toContain('Declined');
    cleanup();
    const live = renderCall(base, true);
    expect(live.dataset.callState).toBe('live');
    expect(live.textContent).toContain('Live');
  });
});
