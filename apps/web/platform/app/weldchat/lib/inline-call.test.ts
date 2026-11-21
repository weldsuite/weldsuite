import { describe, expect, it } from 'vitest';
import { isInlineCall, isReturningFromCall, type ConversationCall } from './inline-call';

const call = (overrides: Partial<ConversationCall> = {}): ConversationCall => ({
  status: 'connected',
  channelId: 'ch_1',
  isFullscreen: false,
  isPiP: false,
  ...overrides,
});

describe('isInlineCall', () => {
  it("shows a conversation's own live call in place of its chat", () => {
    expect(isInlineCall(call(), 'ch_1')).toBe(true);
    expect(isInlineCall(call({ status: 'connecting' }), 'ch_1')).toBe(true);
  });

  it('gives the chat back the moment the call ends: no "call ended" screen', () => {
    expect(isInlineCall(call({ status: 'ended' }), 'ch_1')).toBe(false);
    expect(isInlineCall(call({ status: 'idle' }), 'ch_1')).toBe(false);
  });

  it("leaves other conversations, and a full-screen or picture-in-picture call, to the chat", () => {
    expect(isInlineCall(call(), 'ch_2')).toBe(false);
    expect(isInlineCall(call({ isFullscreen: true }), 'ch_1')).toBe(false);
    expect(isInlineCall(call({ isPiP: true }), 'ch_1')).toBe(false);
  });
});

describe('isReturningFromCall', () => {
  it('fades the chat back in only where the call just ended', () => {
    expect(isReturningFromCall(call({ status: 'ended' }), 'ch_1')).toBe(true);
    expect(isReturningFromCall(call({ status: 'ended' }), 'ch_2')).toBe(false);
    expect(isReturningFromCall(call(), 'ch_1')).toBe(false);
  });
});
