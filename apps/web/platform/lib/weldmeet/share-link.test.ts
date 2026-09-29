import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_MEETING_PORTAL_URL, buildMeetingShareUrl } from './share-link';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('buildMeetingShareUrl', () => {
  it('returns null instead of a ".../null" link when the join code is missing', () => {
    expect(buildMeetingShareUrl('org_123', null)).toBeNull();
    expect(buildMeetingShareUrl('org_123', undefined)).toBeNull();
    expect(buildMeetingShareUrl('org_123', '  ')).toBeNull();
  });

  it('returns null when the workspace id is missing', () => {
    expect(buildMeetingShareUrl(null, 'wm-abc-def-ghi')).toBeNull();
  });

  it('defaults to the public meeting portal, not the platform origin', () => {
    vi.stubEnv('VITE_MEETING_PORTAL_URL', '');
    expect(buildMeetingShareUrl('org_123', 'wm-abc-def-ghi')).toBe(
      `${DEFAULT_MEETING_PORTAL_URL}/org_123/wm-abc-def-ghi`,
    );
  });

  it('honours VITE_MEETING_PORTAL_URL and strips a trailing slash', () => {
    vi.stubEnv('VITE_MEETING_PORTAL_URL', 'http://localhost:3020/');
    expect(buildMeetingShareUrl('org_123', 'wm-abc-def-ghi')).toBe(
      'http://localhost:3020/org_123/wm-abc-def-ghi',
    );
  });
});
