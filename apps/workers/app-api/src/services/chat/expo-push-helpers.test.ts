import { describe, expect, it } from 'vitest';
import { formatExpoHttpError, isExpoPushToken } from '@weldsuite/notifications';

describe('Expo push token helpers', () => {
  it('accepts ExponentPushToken and ExpoPushToken forms', () => {
    expect(isExpoPushToken('ExponentPushToken[abc123]')).toBe(true);
    expect(isExpoPushToken('ExpoPushToken[abc123]')).toBe(true);
  });

  it('rejects raw FCM/APNs device tokens that would 400 an Expo batch', () => {
    expect(isExpoPushToken('dGVzdC1mY20tdG9rZW4')).toBe(false);
    expect(isExpoPushToken('')).toBe(false);
    expect(isExpoPushToken('ExponentPushToken[]')).toBe(false);
  });

  it('surfaces Expo errors[] so callers do not only see HTTP 400', () => {
    const body = JSON.stringify({
      errors: [
        {
          code: 'PUSH_TOO_MANY_EXPERIENCE_IDS',
          message:
            'All push notification messages in the same request must be for the same project.',
        },
      ],
    });
    expect(formatExpoHttpError(400, body)).toContain('PUSH_TOO_MANY_EXPERIENCE_IDS');
    expect(formatExpoHttpError(400, body)).toContain('same project');
  });

  it('falls back to HTTP status when the body is empty', () => {
    expect(formatExpoHttpError(400, '')).toBe('HTTP 400');
    expect(formatExpoHttpError(400, '   ')).toBe('HTTP 400');
  });
});
