/**
 * Tests for the shared server-side email-HTML sanitizer (@weldsuite/email).
 * Hosted here because app-api already runs vitest; the function itself is
 * Workers-safe (htmlparser2 + dom-serializer, no DOM).
 */

import { describe, it, expect } from 'vitest';
import { sanitizeEmailHtml } from '@weldsuite/email/sanitize';

describe('sanitizeEmailHtml', () => {
  it('returns empty for empty / nullish input', () => {
    expect(sanitizeEmailHtml('')).toBe('');
    expect(sanitizeEmailHtml(null)).toBe('');
    expect(sanitizeEmailHtml(undefined)).toBe('');
  });

  it('removes <script> elements and their content', () => {
    const out = sanitizeEmailHtml('<p>hi</p><script>alert(document.cookie)</script>');
    expect(out).toContain('hi');
    expect(out.toLowerCase()).not.toContain('<script');
    expect(out).not.toContain('alert(');
  });

  it('strips inline event handlers (onerror/onload/onclick)', () => {
    const out = sanitizeEmailHtml('<img src="https://x/y.png" onerror="steal()"><div onclick="x()">t</div>');
    expect(out).not.toMatch(/onerror/i);
    expect(out).not.toMatch(/onclick/i);
    expect(out).toContain('src="https://x/y.png"'); // safe img kept
  });

  it('drops javascript:/vbscript: URLs in href/src', () => {
    const out = sanitizeEmailHtml('<a href="javascript:alert(1)">x</a><a href="vbscript:msgbox(1)">y</a>');
    expect(out.toLowerCase()).not.toContain('javascript:');
    expect(out.toLowerCase()).not.toContain('vbscript:');
    expect(out).toContain('>x</a>'); // element kept, dangerous href removed
  });

  it('removes iframe/object/embed/svg with content', () => {
    const out = sanitizeEmailHtml('<iframe src="https://evil"></iframe><svg onload="x()"></svg><object data="x"></object>ok');
    expect(out.toLowerCase()).not.toContain('<iframe');
    expect(out.toLowerCase()).not.toContain('<svg');
    expect(out.toLowerCase()).not.toContain('<object');
    expect(out).toContain('ok');
  });

  it('drops <style> and <head> blocks but keeps inline style (scrubbed)', () => {
    const out = sanitizeEmailHtml(
      '<head><title>t</title><style>body{x:expression(alert(1))}</style></head><p style="color:red;background:url(javascript:alert(1))">hi</p>',
    );
    expect(out.toLowerCase()).not.toContain('<style');
    expect(out.toLowerCase()).not.toContain('<title');
    expect(out).toContain('color:red');
    expect(out.toLowerCase()).not.toContain('expression(');
    expect(out.toLowerCase()).not.toContain('javascript:');
  });

  it('unwraps disallowed tags (form/input) but keeps their text', () => {
    const out = sanitizeEmailHtml('<form action="https://evil"><input name="pw">Please sign in</form>');
    expect(out.toLowerCase()).not.toContain('<form');
    expect(out.toLowerCase()).not.toContain('<input');
    expect(out).toContain('Please sign in');
  });

  it('preserves safe formatting, links, images, cid + data:image', () => {
    const out = sanitizeEmailHtml(
      '<b>bold</b> <a href="https://ex.com">link</a> <img src="cid:logo123"> <img src="data:image/png;base64,AAAA"><table><tr><td>cell</td></tr></table>',
    );
    expect(out).toContain('<b>bold</b>');
    expect(out).toContain('href="https://ex.com"');
    expect(out).toContain('src="cid:logo123"');
    expect(out).toContain('data:image/png;base64,AAAA');
    expect(out).toContain('<td>cell</td>');
  });

  it('is not fooled by malformed/obfuscated script markup', () => {
    // A naive regex stripper can leave a reconstructable <script>; the tokenizer
    // drops the real element and leaves only inert (escaped) text — no live tag.
    const out = sanitizeEmailHtml('<scr<script>ipt>alert(1)</script>safe');
    expect(out.toLowerCase()).not.toContain('<script');
    expect(out).not.toMatch(/<[a-z]/i); // no live element survives — payload is plain text
    expect(out).toContain('safe');
  });

  it('drops HTML comments (can hide IE conditional scripts)', () => {
    const out = sanitizeEmailHtml('<!--[if IE]><script>x()</script><![endif]-->visible');
    expect(out).not.toContain('<!--');
    expect(out.toLowerCase()).not.toContain('<script');
    expect(out).toContain('visible');
  });
});
