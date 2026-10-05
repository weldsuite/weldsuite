import { describe, expect, it } from 'vitest';
import { canDeleteMessage, canReactInChannel, canStartThread, isOwnMessage } from './message-menu-rules';

describe('canReactInChannel', () => {
  it('is on unless the channel explicitly switched reactions off', () => {
    expect(canReactInChannel(undefined)).toBe(true);
    expect(canReactInChannel({})).toBe(true);
    expect(canReactInChannel({ reactionsEnabled: true })).toBe(true);
    expect(canReactInChannel({ reactionsEnabled: false })).toBe(false);
  });
});

describe('canStartThread', () => {
  it('honours the channel threads lock', () => {
    expect(canStartThread({}, { threadsEnabled: false })).toBe(false);
    expect(canStartThread({}, { threadsEnabled: true })).toBe(true);
    expect(canStartThread({}, undefined)).toBe(true);
  });

  it('is never offered on a message that is itself a thread reply', () => {
    expect(canStartThread({ parentId: 'msg_root' }, { threadsEnabled: true })).toBe(false);
    expect(canStartThread({ parentId: null }, { threadsEnabled: true })).toBe(true);
  });
});

describe('isOwnMessage / canDeleteMessage', () => {
  const message = { authorId: 'user_me' };

  it('recognises the author', () => {
    expect(isOwnMessage(message, 'user_me')).toBe(true);
    expect(isOwnMessage(message, 'user_other')).toBe(false);
    expect(isOwnMessage(message, null)).toBe(false);
  });

  it('lets the author delete', () => {
    expect(canDeleteMessage(message, 'user_me', 'member')).toBe(true);
  });

  it('lets channel owners and admins delete other people messages', () => {
    expect(canDeleteMessage(message, 'user_x', 'owner')).toBe(true);
    expect(canDeleteMessage(message, 'user_x', 'admin')).toBe(true);
  });

  it('hides delete from everyone else', () => {
    expect(canDeleteMessage(message, 'user_x', 'member')).toBe(false);
    expect(canDeleteMessage(message, 'user_x', undefined)).toBe(false);
    expect(canDeleteMessage(message, undefined, 'member')).toBe(false);
  });
});
