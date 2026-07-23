import { describe, it, expect } from 'vitest';
import { isSafeHref } from './isolated-html-content';

describe('isSafeHref', () => {
  it('allows the navigation schemes we open from email', () => {
    expect(isSafeHref('https://example.com/page')).toBe(true);
    expect(isSafeHref('http://example.com')).toBe(true);
    expect(isSafeHref('mailto:someone@example.com')).toBe(true);
    expect(isSafeHref('tel:+15551234567')).toBe(true);
    // Relative hrefs resolve against an https base.
    expect(isSafeHref('/inbox')).toBe(true);
    expect(isSafeHref('//example.com/x')).toBe(true);
  });

  it('blocks script-bearing and other dangerous schemes', () => {
    expect(isSafeHref('javascript:alert(document.cookie)')).toBe(false);
    expect(isSafeHref('data:text/html,<script>alert(1)</script>')).toBe(false);
    expect(isSafeHref('vbscript:msgbox(1)')).toBe(false);
    expect(isSafeHref('file:///etc/passwd')).toBe(false);
  });

  it('blocks obfuscated javascript: (whitespace / tab / newline in scheme)', () => {
    expect(isSafeHref('  javascript:alert(1)')).toBe(false);
    // The URL parser normalises embedded tabs/newlines the browser would ignore.
    expect(isSafeHref('java\tscript:alert(1)')).toBe(false);
    expect(isSafeHref('java\nscript:alert(1)')).toBe(false);
    expect(isSafeHref('JaVaScRiPt:alert(1)')).toBe(false);
  });

  it('rejects empty / unparseable input', () => {
    expect(isSafeHref('')).toBe(false);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(isSafeHref(undefined as any)).toBe(false);
  });
});
