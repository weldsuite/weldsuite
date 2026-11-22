import { describe, expect, it } from 'vitest';
import {
  absoluteHttpHref,
  buildInterstitialUrl,
  decideLinkAction,
  linkReasonKey,
  normalizeLinkText,
  parseInterstitialFragment,
  protectAnchor,
} from './link-protection';

const ORIGIN = 'https://app.example.test';

function anchor(href: string | null, text = 'Click here'): HTMLAnchorElement {
  const a = document.createElement('a');
  if (href !== null) a.setAttribute('href', href);
  a.textContent = text;
  return a;
}

describe('absoluteHttpHref', () => {
  it('keeps absolute http and https addresses', () => {
    expect(absoluteHttpHref('https://example.com/a?b=1#c')).toBe('https://example.com/a?b=1#c');
    expect(absoluteHttpHref(' http://example.com ')).toBe('http://example.com/');
  });

  it('reads a protocol-relative address as https', () => {
    expect(absoluteHttpHref('//example.com/x')).toBe('https://example.com/x');
  });

  it.each([
    'mailto:a@b.test',
    'tel:+31600000000',
    'javascript:alert(1)',
    'data:text/html,hi',
    'java\tscript:alert(1)',
    '#section',
    '/relative/path',
    'relative.html',
    '',
  ])('refuses %j', (href) => {
    expect(absoluteHttpHref(href)).toBeNull();
  });

  it('refuses null and over-long addresses', () => {
    expect(absoluteHttpHref(null)).toBeNull();
    expect(absoluteHttpHref(`https://example.com/${'a'.repeat(4100)}`)).toBeNull();
  });
});

describe('normalizeLinkText', () => {
  it('collapses whitespace and cuts at 200 characters', () => {
    expect(normalizeLinkText('  Pay   now\n please ')).toBe('Pay now please');
    expect(normalizeLinkText('x'.repeat(500))).toHaveLength(200);
    expect(normalizeLinkText(null)).toBe('');
  });
});

describe('buildInterstitialUrl and parseInterstitialFragment', () => {
  it('puts the target in the fragment, never the query string', () => {
    const href = buildInterstitialUrl(ORIGIN, {
      messageId: 'msg_1',
      url: 'https://evil.example/path?token=secret',
      text: 'My bank',
    });
    const url = new URL(href);
    expect(url.origin).toBe(ORIGIN);
    expect(url.pathname).toBe('/weldmail/link');
    expect(url.search).toBe('');
    expect(url.hash).toContain('u=https%3A%2F%2Fevil.example%2Fpath%3Ftoken%3Dsecret');
  });

  it('round-trips through the parser', () => {
    const href = buildInterstitialUrl(ORIGIN, {
      messageId: 'msg_1',
      url: 'https://example.com/a b?x=1&y=2#frag',
      text: 'Open & read',
    });
    const parsed = parseInterstitialFragment(new URL(href).hash);
    expect(parsed).toEqual({
      ok: true,
      messageId: 'msg_1',
      url: 'https://example.com/a%20b?x=1&y=2#frag',
      text: 'Open & read',
      host: 'example.com',
    });
  });

  it('carries the workspace prefix of the current page', () => {
    const href = buildInterstitialUrl(ORIGIN, { messageId: 'm', url: 'https://example.com/', text: '' }, 'acme corp');
    expect(new URL(href).pathname).toBe('/w/acme%20corp/weldmail/link');
  });

  it('trims the text to 200 characters', () => {
    const href = buildInterstitialUrl(ORIGIN, { messageId: 'm', url: 'https://example.com/', text: 'y'.repeat(400) });
    const parsed = parseInterstitialFragment(new URL(href).hash);
    expect(parsed.ok && parsed.text).toHaveLength(200);
  });

  it.each([
    '',
    '#',
    '#m=msg_1',
    '#u=https%3A%2F%2Fexample.com',
    '#m=msg_1&u=javascript%3Aalert(1)',
    '#m=msg_1&u=data%3Atext%2Fhtml%2Chi',
    '#m=msg_1&u=file%3A%2F%2F%2Fetc%2Fpasswd',
    '#m=msg_1&u=%2Frelative',
    '#m=msg_1&u=not%20a%20url',
    '#m=%20&u=https%3A%2F%2Fexample.com',
  ])('rejects the fragment %j', (hash) => {
    expect(parseInterstitialFragment(hash)).toEqual({ ok: false });
  });

  it('rejects an over-long address', () => {
    const hash = `#m=m&u=${encodeURIComponent(`https://example.com/${'a'.repeat(4100)}`)}`;
    expect(parseInterstitialFragment(hash)).toEqual({ ok: false });
  });
});

describe('protectAnchor', () => {
  const context = { messageId: 'msg_9', origin: ORIGIN };

  it('rewrites an http(s) anchor to the interstitial and keeps it safe to open', () => {
    const a = anchor('https://example.com/offer', '  Claim\n offer ');
    expect(protectAnchor(a, context)).toBe(true);
    const href = a.getAttribute('href') ?? '';
    expect(href.startsWith(`${ORIGIN}/weldmail/link#`)).toBe(true);
    expect(parseInterstitialFragment(new URL(href).hash)).toMatchObject({
      ok: true,
      messageId: 'msg_9',
      url: 'https://example.com/offer',
      text: 'Claim offer',
    });
    expect(a.getAttribute('target')).toBe('_blank');
    expect(a.getAttribute('rel')).toBe('noopener noreferrer');
  });

  it('leaves mailto, tel, fragment and relative anchors alone', () => {
    for (const href of ['mailto:a@b.test', 'tel:+3112345', '#top', '/inbox']) {
      const a = anchor(href);
      expect(protectAnchor(a, context)).toBe(false);
      expect(a.getAttribute('href')).toBe(href);
    }
  });

  it('leaves an anchor with no href alone', () => {
    const a = anchor(null);
    expect(protectAnchor(a, context)).toBe(false);
    expect(a.hasAttribute('href')).toBe(false);
  });
});

describe('decideLinkAction', () => {
  const reasons = [{ code: 'ip_host' as const }];

  it('forwards a safe link', () => {
    expect(decideLinkAction({ url: 'https://example.com/', verdict: 'safe', reasons: [] })).toEqual({
      action: 'forward',
    });
  });

  it('warns on a suspicious link and blocks a malicious one, with the reasons', () => {
    expect(decideLinkAction({ url: 'http://1.2.3.4/', verdict: 'suspicious', reasons })).toEqual({
      action: 'warn',
      reasons,
    });
    expect(decideLinkAction({ url: 'http://1.2.3.4/', verdict: 'malicious', reasons })).toEqual({
      action: 'block',
      reasons,
    });
  });

  it('fails open, visibly, when the check failed', () => {
    expect(decideLinkAction(null)).toEqual({ action: 'unverified' });
  });
});

describe('linkReasonKey', () => {
  it('names the threat-feed list by threat kind', () => {
    expect(linkReasonKey({ code: 'threat_feed', threat: 'malware' })).toBe('reasonThreatFeedMalware');
    expect(linkReasonKey({ code: 'threat_feed', threat: 'phishing' })).toBe('reasonThreatFeedPhishing');
    expect(linkReasonKey({ code: 'threat_feed' })).toBe('reasonThreatFeed');
  });

  it('maps the heuristic reasons', () => {
    expect(linkReasonKey({ code: 'ip_host' })).toBe('reasonIpHost');
    expect(linkReasonKey({ code: 'userinfo' })).toBe('reasonUserinfo');
    expect(linkReasonKey({ code: 'homograph' })).toBe('reasonHomograph');
  });
});
