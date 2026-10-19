import { describe, expect, it } from 'vitest';
import { buildLinkHtml, normalizeLinkUrl } from './link-url';

describe('normalizeLinkUrl', () => {
  it('keeps a full http(s) link as typed', () => {
    expect(normalizeLinkUrl('https://weldsuite.org/a?b=1')).toBe('https://weldsuite.org/a?b=1');
    expect(normalizeLinkUrl('  http://example.com ')).toBe('http://example.com');
  });

  it('adds https:// to a bare host and mailto: to an email address', () => {
    expect(normalizeLinkUrl('weldsuite.org')).toBe('https://weldsuite.org');
    expect(normalizeLinkUrl('jane@example.com')).toBe('mailto:jane@example.com');
    expect(normalizeLinkUrl('localhost:3000')).toBe('https://localhost:3000');
  });

  it('accepts mailto: and tel: links', () => {
    expect(normalizeLinkUrl('mailto:jane@example.com')).toBe('mailto:jane@example.com');
    expect(normalizeLinkUrl('tel:+31612345678')).toBe('tel:+31612345678');
  });

  it('rejects empty, spaced and script-like targets', () => {
    expect(normalizeLinkUrl('')).toBeNull();
    expect(normalizeLinkUrl('   ')).toBeNull();
    expect(normalizeLinkUrl('not a link')).toBeNull();
    expect(normalizeLinkUrl('javascript:alert(1)')).toBeNull();
    expect(normalizeLinkUrl('data:text/html,<b>x</b>')).toBeNull();
    expect(normalizeLinkUrl('https://')).toBeNull();
  });
});

describe('buildLinkHtml', () => {
  it('escapes the target and the text', () => {
    expect(buildLinkHtml('https://example.com/?a=1&b="2"', '<b>Hi</b>')).toBe(
      '<a href="https://example.com/?a=1&amp;b=&quot;2&quot;">&lt;b&gt;Hi&lt;/b&gt;</a>',
    );
  });

  it('shows the target when there is no text', () => {
    expect(buildLinkHtml('https://example.com', '')).toBe('<a href="https://example.com">https://example.com</a>');
  });
});
