import { describe, expect, it } from 'vitest';
import { isBarePersonalTopic, resolveSyncTopic } from './topics';

describe('resolveSyncTopic', () => {
  it('subscribes a bare personal topic as <topic>.<userId> once the user is known', () => {
    expect(resolveSyncTopic('notification', 'user_1')).toBe('notification.user_1');
    expect(resolveSyncTopic('mail', 'user_1')).toBe('mail.user_1');
    expect(resolveSyncTopic('chat.user', 'user_1')).toBe('chat.user.user_1');
  });

  it('skips a bare personal topic while the user is unknown', () => {
    expect(resolveSyncTopic('notification', '')).toBeNull();
    expect(resolveSyncTopic('notification', null)).toBeNull();
    expect(resolveSyncTopic('inbox', undefined)).toBeNull();
  });

  it('leaves every other topic as it is, with or without a user', () => {
    expect(resolveSyncTopic('project', 'user_1')).toBe('project');
    expect(resolveSyncTopic('project', '')).toBe('project');
    expect(resolveSyncTopic('notification.user_1', '')).toBe('notification.user_1');
  });

  it('only rewrites topics the hub treats as bare personal ones', () => {
    for (const topic of ['notification', 'mail', 'inbox', 'chat.user']) {
      expect(isBarePersonalTopic(topic)).toBe(true);
      expect(resolveSyncTopic(topic, 'u')).toBe(`${topic}.u`);
    }
  });
});
