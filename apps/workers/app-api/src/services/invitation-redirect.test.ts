import { describe, expect, it } from 'vitest';
import { getPlatformUrl, invitationRedirectUrl } from './invitation-redirect';

describe('getPlatformUrl', () => {
  it('maps each environment to its platform host', () => {
    expect(getPlatformUrl({ ENVIRONMENT: 'production' })).toBe('https://app.weldsuite.org');
    expect(getPlatformUrl({ ENVIRONMENT: 'test' })).toBe('https://app-test.weldsuite.org');
    expect(getPlatformUrl({ ENVIRONMENT: 'development' })).toBe('http://localhost:3000');
  });

  it('falls back to local development for an unknown environment', () => {
    expect(getPlatformUrl({ ENVIRONMENT: 'preview' })).toBe('http://localhost:3000');
  });

  it('prefers PUBLIC_APP_URL and drops a trailing slash', () => {
    expect(
      getPlatformUrl({ ENVIRONMENT: 'production', PUBLIC_APP_URL: 'https://app.example.com/' }),
    ).toBe('https://app.example.com');
  });

  it('ignores a blank PUBLIC_APP_URL', () => {
    expect(getPlatformUrl({ ENVIRONMENT: 'test', PUBLIC_APP_URL: '  ' })).toBe(
      'https://app-test.weldsuite.org',
    );
  });
});

describe('invitationRedirectUrl', () => {
  it('points at the /invite page with the workspace org id', () => {
    expect(invitationRedirectUrl({ ENVIRONMENT: 'production' }, 'org_abc123')).toBe(
      'https://app.weldsuite.org/invite?org_id=org_abc123',
    );
  });
});
