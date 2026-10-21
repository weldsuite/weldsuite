import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import {
  apiCors,
  FIRST_PARTY_ORIGINS,
  isAuthorizedParty,
  parseExtraAuthorizedParties,
  resolveCorsOrigin,
} from './cors';

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

  it('allows the partner portal (test + production + local)', () => {
    expect(resolveCorsOrigin('https://partner.weldsuite.org')).toBe('https://partner.weldsuite.org');
    expect(resolveCorsOrigin('https://partner-test.weldsuite.org')).toBe(
      'https://partner-test.weldsuite.org',
    );
    expect(resolveCorsOrigin('http://localhost:3203')).toBe('http://localhost:3203');
    expect(resolveCorsOrigin('https://partner.weldsuite.org.evil.com')).toBeNull();
  });

  it('allows known local SPA ports', () => {
    expect(resolveCorsOrigin('http://localhost:3000')).toBe('http://localhost:3000');
    expect(resolveCorsOrigin('http://localhost:3001')).toBe('http://localhost:3001');
    expect(resolveCorsOrigin('http://localhost:5173')).toBe('http://localhost:5173');
  });

  it('does not trust welddesk.org hosts: tenants choose those subdomains', () => {
    expect(resolveCorsOrigin('https://acme.welddesk.org')).toBeNull();
    expect(resolveCorsOrigin('https://test.welddesk.org')).toBeNull();
    expect(resolveCorsOrigin('http://acme.welddesk.org')).toBeNull();
    expect(resolveCorsOrigin('https://a.b.welddesk.org')).toBeNull();
    expect(resolveCorsOrigin('https://welddesk.org')).toBeNull();
    expect(resolveCorsOrigin('https://evil.com/.welddesk.org')).toBeNull();
  });

  it('denies unknown origins instead of falling back to production app', () => {
    expect(resolveCorsOrigin('https://developer-test.weldsuite.org.evil.com')).toBeNull();
    expect(resolveCorsOrigin('https://evil.example.com')).toBeNull();
    expect(resolveCorsOrigin('https://app.weldsuite.org.evil.com')).toBeNull();
    expect(resolveCorsOrigin('http://app.weldsuite.org')).toBeNull();
    expect(resolveCorsOrigin('null')).toBeNull();
    expect(resolveCorsOrigin(undefined)).toBeNull();
  });
});

describe('apiCors', () => {
  const app = new Hono();
  app.use('*', apiCors());
  app.get('/ping', (c) => c.text('ok'));

  const request = (origin: string) => app.request('/ping', { headers: { Origin: origin } });

  it('reflects a first-party origin with credentials', async () => {
    const res = await request('https://app.weldsuite.org');
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('https://app.weldsuite.org');
    expect(res.headers.get('Access-Control-Allow-Credentials')).toBe('true');
  });

  it.each([
    'https://acme.welddesk.org',
    'http://acme.welddesk.org',
    'https://a.b.welddesk.org',
    'https://evil.example.com',
  ])('sends no Access-Control-Allow-Origin for %s', async (origin) => {
    const res = await request(origin);
    // Without a matching Allow-Origin the browser blocks the response, whatever
    // Allow-Credentials says.
    expect(res.headers.get('Access-Control-Allow-Origin')).toBeNull();
  });
});

describe('FIRST_PARTY_ORIGINS', () => {
  it('lists exact origins only: scheme and host, no wildcard, no path', () => {
    for (const origin of FIRST_PARTY_ORIGINS) {
      expect(origin).toMatch(/^(https:\/\/[a-z0-9-]+(\.[a-z0-9-]+)+|http:\/\/localhost:\d+)$/);
    }
  });

  it('is plain https outside localhost', () => {
    for (const origin of FIRST_PARTY_ORIGINS) {
      if (!origin.startsWith('http://')) continue;
      expect(origin.startsWith('http://localhost:')).toBe(true);
    }
  });
});

describe('isAuthorizedParty', () => {
  it('accepts every first-party origin, the same set CORS allows', () => {
    for (const origin of FIRST_PARTY_ORIGINS) {
      expect(isAuthorizedParty(origin)).toBe(true);
      expect(resolveCorsOrigin(origin)).toBe(origin);
    }
  });

  it('accepts a token without the claim (native Clerk clients send no Origin)', () => {
    expect(isAuthorizedParty(undefined)).toBe(true);
    expect(isAuthorizedParty(null)).toBe(true);
  });

  it('refuses unknown, malformed and look-alike origins', () => {
    expect(isAuthorizedParty('https://evil.example.com')).toBe(false);
    expect(isAuthorizedParty('https://acme.welddesk.org')).toBe(false);
    expect(isAuthorizedParty('https://a.b.welddesk.org')).toBe(false);
    expect(isAuthorizedParty('http://acme.welddesk.org')).toBe(false);
    expect(isAuthorizedParty('http://app.weldsuite.org')).toBe(false);
    expect(isAuthorizedParty('https://app.weldsuite.org.evil.com')).toBe(false);
    expect(isAuthorizedParty('https://app.weldsuite.org/')).toBe(false);
    expect(isAuthorizedParty('HTTPS://APP.WELDSUITE.ORG')).toBe(false);
  });

  it('refuses a present but empty or non-string claim', () => {
    expect(isAuthorizedParty('')).toBe(false);
    expect(isAuthorizedParty(0)).toBe(false);
    expect(isAuthorizedParty(false)).toBe(false);
    expect(isAuthorizedParty({})).toBe(false);
    expect(isAuthorizedParty(['https://app.weldsuite.org'])).toBe(false);
  });

  it('accepts configured extra origins on top of the first-party list', () => {
    const extra = ['https://weldmail.example.org'];
    expect(isAuthorizedParty('https://weldmail.example.org', extra)).toBe(true);
    expect(isAuthorizedParty('https://app.weldsuite.org', extra)).toBe(true);
    expect(isAuthorizedParty('https://weldmail.example.org')).toBe(false);
    expect(isAuthorizedParty('https://other.example.org', extra)).toBe(false);
  });
});

describe('parseExtraAuthorizedParties', () => {
  const extensionId = 'abcdefghijklmnopabcdefghijklmnop';

  it('returns nothing when the var is unset or empty', () => {
    expect(parseExtraAuthorizedParties(undefined)).toEqual([]);
    expect(parseExtraAuthorizedParties('')).toEqual([]);
    expect(parseExtraAuthorizedParties('  ,  ')).toEqual([]);
  });

  it('splits on commas and whitespace and lower-cases', () => {
    expect(
      parseExtraAuthorizedParties(
        `https://Weldmail.example.org , chrome-extension://${extensionId}\nhttp://localhost:3200`,
      ),
    ).toEqual(['https://weldmail.example.org', `chrome-extension://${extensionId}`, 'http://localhost:3200']);
  });

  it('drops wildcards, paths, other schemes and short extension ids', () => {
    expect(
      parseExtraAuthorizedParties(
        [
          '*',
          'https://*.welddesk.org',
          'https://example.org/app',
          'https://example.org?x=1',
          'ftp://example.org',
          'javascript:alert(1)',
          'chrome-extension://short',
          'example.org',
          'https://',
        ].join(','),
      ),
    ).toEqual([]);
  });
});
