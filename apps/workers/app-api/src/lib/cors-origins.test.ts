import { describe, expect, it } from 'vitest';
import { resolveCorsOrigin } from './cors-origins';

describe('resolveCorsOrigin', () => {
  it('allows the platform SPA hosts', () => {
    expect(resolveCorsOrigin('https://app.weldsuite.org')).toBe('https://app.weldsuite.org');
    expect(resolveCorsOrigin('https://app-test.weldsuite.org')).toBe(
      'https://app-test.weldsuite.org',
    );
    expect(resolveCorsOrigin('https://app-preview.weldsuite.org')).toBe(
      'https://app-preview.weldsuite.org',
    );
  });

  it('allows the WeldApps developer portal (test + production + local)', () => {
    expect(resolveCorsOrigin('https://developer.weldsuite.org')).toBe(
      'https://developer.weldsuite.org',
    );
    expect(resolveCorsOrigin('https://developer-test.weldsuite.org')).toBe(
      'https://developer-test.weldsuite.org',
    );
    expect(resolveCorsOrigin('http://localhost:3202')).toBe('http://localhost:3202');
  });

  it('allows known local SPA ports', () => {
    expect(resolveCorsOrigin('http://localhost:3000')).toBe('http://localhost:3000');
    expect(resolveCorsOrigin('http://localhost:3001')).toBe('http://localhost:3001');
    expect(resolveCorsOrigin('http://localhost:5173')).toBe('http://localhost:5173');
  });

  it('reflects *.welddesk.org customer sites', () => {
    expect(resolveCorsOrigin('https://acme.welddesk.org')).toBe('https://acme.welddesk.org');
  });

  it('denies unknown origins instead of falling back to production app', () => {
    expect(resolveCorsOrigin('https://developer-test.weldsuite.org.evil.com')).toBeNull();
    expect(resolveCorsOrigin('https://evil.example.com')).toBeNull();
    expect(resolveCorsOrigin('https://app.weldsuite.org.evil.com')).toBeNull();
    expect(resolveCorsOrigin(undefined)).toBeNull();
  });
});
