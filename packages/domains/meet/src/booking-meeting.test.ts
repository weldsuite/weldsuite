import { describe, expect, it } from 'vitest';

import {
  DEFAULT_MEETING_PORTAL_URL,
  buildMeetingJoinUrl,
  generateJoinCode,
  getMeetingPortalUrl,
} from './booking-meeting';

describe('generateJoinCode', () => {
  it('has the wm-abc-def-ghi shape and differs between calls', () => {
    const a = generateJoinCode();
    expect(a).toMatch(/^wm-[a-z]{3}-[a-z]{3}-[a-z]{3}$/);
    expect(generateJoinCode()).not.toBe(a);
  });
});

describe('getMeetingPortalUrl', () => {
  it('defaults to production and trims trailing slashes', () => {
    expect(getMeetingPortalUrl(undefined)).toBe(DEFAULT_MEETING_PORTAL_URL);
    expect(getMeetingPortalUrl('  ')).toBe(DEFAULT_MEETING_PORTAL_URL);
    expect(getMeetingPortalUrl('https://meet-test.weldsuite.org//')).toBe('https://meet-test.weldsuite.org');
  });
});

describe('buildMeetingJoinUrl', () => {
  it('is <portal>/<workspaceId>/<joinCode>, encoded', () => {
    expect(buildMeetingJoinUrl('https://meet.weldsuite.org', 'ws_1', 'wm-abc-def-ghi')).toBe(
      'https://meet.weldsuite.org/ws_1/wm-abc-def-ghi',
    );
    expect(buildMeetingJoinUrl('https://meet.weldsuite.org', 'a b', 'x/y')).toBe(
      'https://meet.weldsuite.org/a%20b/x%2Fy',
    );
  });
});
