import { describe, expect, it } from 'vitest';
import type { ReachMessage } from '@weldsuite/app-api-client/schemas/reach';
import {
  canReplyToThread,
  isHandled,
  isUnread,
  messageText,
  sortMessages,
  unreadInboundIds,
} from './thread-state';

function message(id: string, overrides: Partial<ReachMessage> = {}): ReachMessage {
  return {
    id,
    direction: 'in',
    campaignId: null,
    stepId: null,
    mailboxId: 'mbx_1',
    prospectId: 'prs_1',
    threadKey: 'thr_1',
    fromEmail: 'ana@acme.com',
    toEmail: 'sam@outreach.example',
    subject: 'Re: Hello',
    snippet: null,
    bodyText: null,
    status: null,
    kind: 'reply',
    label: null,
    labelSource: null,
    readAt: null,
    handledAt: null,
    sentAt: null,
    receivedAt: '2026-10-12T10:00:00Z',
    ...overrides,
  };
}

describe('isUnread / isHandled', () => {
  const summary = (readAt: string | null, handledAt: string | null) => ({
    lastInbound: { id: 'm', subject: null, snippet: null, kind: 'reply' as const, label: null, labelSource: null, receivedAt: null, readAt, handledAt },
  });

  it('reads the latest reply', () => {
    expect(isUnread(summary(null, null))).toBe(true);
    expect(isUnread(summary('2026-10-12T10:00:00Z', null))).toBe(false);
    expect(isHandled(summary(null, '2026-10-12T10:00:00Z'))).toBe(true);
    expect(isHandled(summary(null, null))).toBe(false);
  });
});

describe('sortMessages', () => {
  it('puts the conversation in time order, whichever side sent', () => {
    const sorted = sortMessages([
      message('reply', { receivedAt: '2026-10-12T12:00:00Z' }),
      message('step-2', { direction: 'out', receivedAt: null, sentAt: '2026-10-12T11:00:00Z' }),
      message('step-1', { direction: 'out', receivedAt: null, sentAt: '2026-10-10T09:00:00Z' }),
    ]);
    expect(sorted.map((m) => m.id)).toEqual(['step-1', 'step-2', 'reply']);
  });

  it('does not change the input', () => {
    const input = [message('b', { receivedAt: '2026-10-12T12:00:00Z' }), message('a', { receivedAt: '2026-10-12T09:00:00Z' })];
    sortMessages(input);
    expect(input.map((m) => m.id)).toEqual(['b', 'a']);
  });
});

describe('unreadInboundIds', () => {
  it('lists unopened replies only', () => {
    expect(
      unreadInboundIds([
        message('read', { readAt: '2026-10-12T10:05:00Z' }),
        message('unread'),
        message('ours', { direction: 'out' }),
      ]),
    ).toEqual(['unread']);
  });
});

describe('canReplyToThread', () => {
  it('allows answering a reply and an auto-reply', () => {
    expect(canReplyToThread([message('a')])).toBe(true);
    expect(canReplyToThread([message('a', { kind: 'auto_reply' })])).toBe(true);
  });

  it('refuses when the latest inbound message is a bounce', () => {
    expect(
      canReplyToThread([
        message('a', { receivedAt: '2026-10-12T09:00:00Z' }),
        message('b', { kind: 'bounce', receivedAt: '2026-10-12T10:00:00Z' }),
      ]),
    ).toBe(false);
  });

  it('refuses a thread without any reply', () => {
    expect(canReplyToThread([message('a', { direction: 'out', kind: null })])).toBe(false);
  });
});

describe('messageText', () => {
  it('prefers the body and falls back to the snippet', () => {
    expect(messageText({ bodyText: ' Hello ', snippet: 'Hi' })).toBe('Hello');
    expect(messageText({ bodyText: null, snippet: 'Hi' })).toBe('Hi');
    expect(messageText({ bodyText: null, snippet: null })).toBe('');
  });
});
