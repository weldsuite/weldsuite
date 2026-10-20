import { describe, it, expect } from 'vitest';
import { filterInlineStyle, sanitizeArticleHtml } from './sanitize-article-html';

function parse(html: string): HTMLDivElement {
  const el = document.createElement('div');
  el.innerHTML = html;
  return el;
}

describe('sanitizeArticleHtml', () => {
  it('returns an empty string for empty input', () => {
    expect(sanitizeArticleHtml('')).toBe('');
    expect(sanitizeArticleHtml(null)).toBe('');
    expect(sanitizeArticleHtml(undefined)).toBe('');
  });

  it('removes script elements and their content', () => {
    const html = sanitizeArticleHtml('<p>hi</p><script>alert(document.cookie)</script>');
    expect(html).not.toContain('script');
    expect(html).not.toContain('alert');
    expect(parse(html).textContent).toBe('hi');
  });

  it('drops onerror and other event-handler attributes', () => {
    const html = sanitizeArticleHtml(
      '<img src="https://files.weldsuite.org/a.png" onerror="alert(1)"><div onclick="x()" onmouseover="y()">t</div>',
    );
    expect(html).not.toMatch(/onerror|onclick|onmouseover/i);
    const el = parse(html);
    expect(el.querySelector('img')?.getAttribute('src')).toBe('https://files.weldsuite.org/a.png');
    expect(el.querySelector('div')?.textContent).toBe('t');
  });

  it('neutralises the classic <img src=x onerror> payload', () => {
    const html = sanitizeArticleHtml('<img src=x onerror=alert(1)>');
    expect(html).not.toMatch(/onerror/i);
  });

  it('strips javascript: and data: links but keeps the link text', () => {
    const el = parse(
      sanitizeArticleHtml(
        '<a href="javascript:alert(1)">one</a>' +
          '<a href="  JaVaScRiPt:alert(1)">two</a>' +
          '<a href="java&#x09;script:alert(1)">three</a>' +
          '<a href="data:text/html,<script>alert(1)</script>">four</a>' +
          '<a href="vbscript:msgbox(1)">five</a>',
      ),
    );
    const anchors = Array.from(el.querySelectorAll('a'));
    expect(anchors.length).toBeGreaterThan(0);
    for (const a of anchors) expect(a.hasAttribute('href')).toBe(false);
    expect(el.textContent).toBe('onetwothreefourfive');
  });

  it('drops a javascript: image source', () => {
    const el = parse(sanitizeArticleHtml('<img src="javascript:alert(1)" alt="x">'));
    expect(el.querySelector('img')?.hasAttribute('src')).toBe(false);
  });

  it('removes iframe, object, embed, svg, math, style, form and meta elements', () => {
    const html = sanitizeArticleHtml(
      '<p>ok</p><iframe src="https://evil.test"></iframe><object data="x"></object><embed src="x">' +
        '<svg onload="alert(1)"><script>alert(2)</script></svg><math><mi>x</mi></math>' +
        '<style>body{display:none}</style><form action="https://evil.test"><input name="pw"></form>' +
        '<meta http-equiv="refresh" content="0;url=https://evil.test">',
    );
    const el = parse(html);
    expect(el.querySelector('iframe, object, embed, svg, math, style, form, input, meta, script')).toBeNull();
    expect(el.textContent).toContain('ok');
    expect(html).not.toContain('alert');
  });

  it('survives split or malformed tags used to dodge filters', () => {
    const html = sanitizeArticleHtml('<scr<script>ipt>alert(1)</scr</script>ipt><img """><script>alert(2)</script>">');
    const el = parse(html);
    expect(el.querySelector('script')).toBeNull();
    expect(html).not.toMatch(/<script/i);
  });

  it('makes links open safely in a new tab', () => {
    const a = parse(sanitizeArticleHtml('<a href="https://weldsuite.org/docs" target="_self" rel="opener">docs</a>')).querySelector('a');
    expect(a?.getAttribute('href')).toBe('https://weldsuite.org/docs');
    expect(a?.getAttribute('target')).toBe('_blank');
    expect(a?.getAttribute('rel')).toBe('noopener noreferrer');
  });

  it('keeps mailto, tel and relative links', () => {
    const el = parse(
      sanitizeArticleHtml('<a href="mailto:help@example.com">m</a><a href="tel:+31201234567">t</a><a href="/welddesk/inbox">r</a>'),
    );
    const hrefs = Array.from(el.querySelectorAll('a')).map((a) => a.getAttribute('href'));
    expect(hrefs).toEqual(['mailto:help@example.com', 'tel:+31201234567', '/welddesk/inbox']);
  });

  it('keeps images, including inline data: images, and stops them leaking the referrer', () => {
    const el = parse(
      sanitizeArticleHtml(
        '<img src="https://files.weldsuite.org/a.png" alt="shot" width="200" height="100">' +
          '<img src="data:image/png;base64,iVBORw0KGgo=" alt="inline">',
      ),
    );
    const [remote, inline] = Array.from(el.querySelectorAll('img'));
    expect(remote.getAttribute('src')).toBe('https://files.weldsuite.org/a.png');
    expect(remote.getAttribute('alt')).toBe('shot');
    expect(remote.getAttribute('width')).toBe('200');
    expect(remote.getAttribute('referrerpolicy')).toBe('no-referrer');
    expect(inline.getAttribute('src')).toBe('data:image/png;base64,iVBORw0KGgo=');
  });

  it('keeps the formatting the editor produces', () => {
    const el = parse(
      sanitizeArticleHtml(
        '<h1>Title</h1><h2>Sub</h2><p dir="ltr"><b>bold</b> <i>italic</i> <u>under</u> <strike>gone</strike> <mark>hi</mark> <code>x()</code></p>' +
          '<ul><li>one</li></ul><ol start="3"><li>two</li></ol><blockquote>quote</blockquote><pre>code</pre>' +
          '<table><thead><tr><th colspan="2">h</th></tr></thead><tbody><tr><td rowspan="2">a</td><td>b</td></tr></tbody></table>' +
          '<hr><br><sub>s</sub><sup>p</sup><font color="#ff0000" face="Arial" size="4">red</font>',
      ),
    );
    for (const selector of [
      'h1', 'h2', 'p[dir="ltr"]', 'b', 'i', 'u', 'strike', 'mark', 'code', 'ul li', 'ol[start="3"] li',
      'blockquote', 'pre', 'table thead th[colspan="2"]', 'tbody td[rowspan="2"]', 'hr', 'br', 'sub', 'sup',
      'font[color="#ff0000"]',
    ]) {
      expect(el.querySelector(selector), selector).not.toBeNull();
    }
    expect(el.textContent).toContain('Title');
  });

  it('keeps safe inline styles and drops dangerous ones', () => {
    const el = parse(
      sanitizeArticleHtml(
        '<p style="text-align: center; color: #333; font-size: 18px; position: fixed; inset: 0; background-image: url(https://evil.test/x.png)">x</p>' +
          '<span style="font-family: \'Arial\', sans-serif; width: expression(alert(1))">y</span>',
      ),
    );
    const p = el.querySelector('p');
    expect(p?.getAttribute('style')).toBe('text-align: center; color: #333; font-size: 18px');
    expect(el.querySelector('span')?.getAttribute('style')).toBe("font-family: 'Arial', sans-serif");
  });

  it('removes a style attribute with nothing safe in it', () => {
    const div = parse(sanitizeArticleHtml('<div style="position:fixed;top:0;left:0;z-index:9999">x</div>')).querySelector('div');
    expect(div?.hasAttribute('style')).toBe(false);
    expect(div?.textContent).toBe('x');
  });

  it('strips class and id so a body cannot restyle the app or clobber the DOM', () => {
    const div = parse(sanitizeArticleHtml('<div id="root" class="fixed inset-0 z-50 bg-background">x</div>')).querySelector('div');
    expect(div?.attributes.length).toBe(0);
    expect(div?.textContent).toBe('x');
  });

  it('keeps only the editor link classes on a link', () => {
    const el = parse(
      sanitizeArticleHtml(
        '<a href="https://weldsuite.org" class="text-primary fixed inset-0 underline hover:text-primary/80">go</a>' +
          '<span class="underline">s</span>',
      ),
    );
    expect(el.querySelector('a')?.getAttribute('class')).toBe('text-primary underline hover:text-primary/80');
    expect(el.querySelector('span')?.hasAttribute('class')).toBe(false);
  });

  it('drops data-* and aria-* attributes', () => {
    const el = parse(sanitizeArticleHtml('<p data-x="1" aria-label="a" title="t">x</p>')).querySelector('p');
    expect(el?.hasAttribute('data-x')).toBe(false);
    expect(el?.hasAttribute('aria-label')).toBe(false);
    expect(el?.getAttribute('title')).toBe('t');
  });
});

describe('filterInlineStyle', () => {
  it('keeps only allowlisted properties with safe values', () => {
    expect(filterInlineStyle('color: red; background-color: rgb(1, 2, 3); font-weight: bold')).toBe(
      'color: red; background-color: rgb(1, 2, 3); font-weight: bold',
    );
  });

  it('drops url(), expression(), escapes, negative lengths and viewport units', () => {
    expect(filterInlineStyle('color: url(https://evil.test)')).toBe('');
    expect(filterInlineStyle('width: expression(alert(1))')).toBe('');
    expect(filterInlineStyle('c\\olor: red')).toBe('');
    expect(filterInlineStyle('margin-left: -9999px')).toBe('');
    expect(filterInlineStyle('width: 100vw')).toBe('');
    expect(filterInlineStyle('position: fixed')).toBe('');
  });

  it('is case-insensitive on property names and survives junk', () => {
    expect(filterInlineStyle('COLOR: Red;;: ;nonsense;')).toBe('color: Red');
    expect(filterInlineStyle('')).toBe('');
  });
});
