import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_MEETING_PORTAL_URL, buildMeetingShareUrl, parseMeetingJoinInput } from './share-link';

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

describe('parseMeetingJoinInput', () => {
  it('returns a bare join code trimmed', () => {
    expect(parseMeetingJoinInput('  wm-tia-teb-hnq \n')).toEqual({
      joinCode: 'wm-tia-teb-hnq',
      workspaceId: null,
      url: null,
    });
  });

  it('returns null for empty input', () => {
    expect(parseMeetingJoinInput('   ')).toBeNull();
    expect(parseMeetingJoinInput('https://meet.weldsuite.org/')).toBeNull();
  });

  it('takes the join code and workspace id from a meeting-portal link', () => {
    expect(parseMeetingJoinInput(' https://meet.weldsuite.org/org_123/wm-tia-teb-hnq ')).toEqual({
      joinCode: 'wm-tia-teb-hnq',
      workspaceId: 'org_123',
      url: 'https://meet.weldsuite.org/org_123/wm-tia-teb-hnq',
    });
  });

  it('accepts a portal link without a scheme, with a trailing slash, query or hash', () => {
    expect(parseMeetingJoinInput('meet.weldsuite.org/org_123/wm-tia-teb-hnq/?ref=mail#x')).toMatchObject({
      joinCode: 'wm-tia-teb-hnq',
      workspaceId: 'org_123',
    });
  });

  it('takes the join code from a platform join link, without a workspace', () => {
    expect(parseMeetingJoinInput('https://app.weldsuite.org/weldmeet/join/wm-tia-teb-hnq')).toEqual({
      joinCode: 'wm-tia-teb-hnq',
      workspaceId: null,
      url: 'https://app.weldsuite.org/weldmeet/join/wm-tia-teb-hnq',
    });
  });

  it('decodes encoded path segments', () => {
    expect(parseMeetingJoinInput('https://meet.weldsuite.org/org_123/wm%2Dabc')).toMatchObject({
      joinCode: 'wm-abc',
    });
  });
});
