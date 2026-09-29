import { describe, expect, it } from 'vitest';
import { presenceFromStatus, EMAIL_DEFER_MINUTES } from '@weldsuite/notifications';

describe('notification email presence gate', () => {
  it('treats a connected user as present so no email is sent', () => {
    expect(presenceFromStatus('online')).toBe('present');
  });

  it('treats busy as present — it is set by a connected client', () => {
    expect(presenceFromStatus('busy')).toBe('present');
  });

  it('defers for away, which means idle at the keyboard', () => {
    expect(presenceFromStatus('away')).toBe('absent');
  });

  it('defers for offline', () => {
    expect(presenceFromStatus('offline')).toBe('absent');
  });

  it('suppresses rather than defers for dnd', () => {
    expect(presenceFromStatus('dnd')).toBe('suppress');
  });

  it('defers when there is no status row, so a user who never connected is still reachable', () => {
    expect(presenceFromStatus(undefined)).toBe('absent');
    expect(presenceFromStatus(null)).toBe('absent');
  });

  it('defers on an unrecognised status rather than silently dropping the email', () => {
    expect(presenceFromStatus('vacationing')).toBe('absent');
  });

  it('uses a Slack-like defer window', () => {
    expect(EMAIL_DEFER_MINUTES).toBe(2);
  });
});
