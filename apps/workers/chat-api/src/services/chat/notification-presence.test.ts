import { describe, expect, it } from 'vitest';
import { emailPresenceFor, EMAIL_DEFER_MINUTES } from '@weldsuite/notifications';

describe('notification email presence gate', () => {
  it('treats a connected, active user as present so no email is sent', () => {
    expect(emailPresenceFor('online', 'online')).toBe('present');
  });

  it('treats a user in a call as present — they are at their desk', () => {
    expect(emailPresenceFor('online', 'busy')).toBe('present');
    expect(emailPresenceFor('busy', 'online')).toBe('present');
  });

  it('treats a connected user who appears offline as present — they are looking at the app', () => {
    expect(emailPresenceFor('offline', 'online')).toBe('present');
  });

  it('defers when idle, which means away from the keyboard', () => {
    expect(emailPresenceFor('online', 'away')).toBe('absent');
  });

  it('defers when the user said they are away, even with the app open', () => {
    expect(emailPresenceFor('away', 'online')).toBe('absent');
  });

  it('defers when not connected anywhere', () => {
    expect(emailPresenceFor('online', null)).toBe('absent');
    expect(emailPresenceFor('busy', undefined)).toBe('absent');
  });

  it('suppresses rather than defers for dnd, connected or not', () => {
    expect(emailPresenceFor('dnd', 'online')).toBe('suppress');
    expect(emailPresenceFor('dnd', null)).toBe('suppress');
  });

  it('uses a Slack-like defer window', () => {
    expect(EMAIL_DEFER_MINUTES).toBe(2);
  });
});
