import { describe, it, expect } from 'vitest';
import { descriptionToHtml, escapeHtml } from './description-html';

function parse(html: string): HTMLDivElement {
  const el = document.createElement('div');
  el.innerHTML = html;
  return el;
}

describe('descriptionToHtml', () => {
  it('returns an empty string for an empty description', () => {
    expect(descriptionToHtml('')).toBe('');
  });

  it('drops event handlers from a description that contains HTML', () => {
    const html = descriptionToHtml('<p>hi</p><img src="x" onerror="alert(1)">');
    expect(html).not.toContain('onerror');
    expect(parse(html).querySelector('img')?.getAttribute('src')).toBe('x');
  });

  it('removes script, iframe, svg, style and form elements', () => {
    const html = descriptionToHtml(
      '<p>ok</p><script>alert(1)</script><iframe src="https://evil.test"></iframe>' +
        '<svg onload="alert(1)"></svg><style>body{display:none}</style>' +
        '<form action="https://evil.test"><input name="password"></form>',
    );
    const el = parse(html);
    expect(el.querySelector('script, iframe, svg, style, form, input')).toBeNull();
    expect(el.textContent).toContain('ok');
    expect(html).not.toContain('alert(1)');
  });

  it('strips javascript: and data: links but keeps the link text', () => {
    const el = parse(
      descriptionToHtml(
        '<a href="javascript:alert(1)">one</a><a href="data:text/html,<script>alert(1)</script>">two</a>',
      ),
    );
    for (const a of Array.from(el.querySelectorAll('a'))) {
      expect(a.hasAttribute('href')).toBe(false);
    }
    expect(el.textContent).toBe('onetwo');
  });

  it('strips style, class and id so a description cannot restyle the app', () => {
    const html = descriptionToHtml(
      '<div id="root" class="fixed inset-0 z-50" style="position:fixed;background:url(https://evil.test)">x</div>',
    );
    const div = parse(html).querySelector('div');
    expect(div?.attributes.length).toBe(0);
    expect(div?.textContent).toBe('x');
  });

  it('keeps the formatting the editor produces', () => {
    const el = parse(
      descriptionToHtml(
        '<div><b>bold</b> <i>italic</i> <strike>gone</strike> <mark>hi</mark> <code>x()</code></div>' +
          '<ul><li>one</li></ul><ol><li>two</li></ol>' +
          '<img src="https://files.weldsuite.org/a.png" alt="shot">',
      ),
    );
    for (const tag of ['b', 'i', 'strike', 'mark', 'code', 'ul', 'ol', 'li', 'img']) {
      expect(el.querySelector(tag), tag).not.toBeNull();
    }
    expect(el.querySelector('img')?.getAttribute('alt')).toBe('shot');
  });

  it('forces links to open in a new tab without an opener', () => {
    const a = parse(descriptionToHtml('<a href="https://example.com" target="_top" rel="opener">x</a>')).querySelector('a');
    expect(a?.getAttribute('href')).toBe('https://example.com');
    expect(a?.getAttribute('target')).toBe('_blank');
    expect(a?.getAttribute('rel')).toBe('noopener noreferrer');
  });

  it('escapes markup-looking text on the markdown path', () => {
    expect(descriptionToHtml('a < b and **bold**\nnext')).toBe('a &lt; b and <strong>bold</strong><br>next');
    // An unterminated tag never matches the HTML branch, so it stays text.
    expect(descriptionToHtml('<img src=x onerror=alert(1)')).toBe('&lt;img src=x onerror=alert(1)');
  });
});

describe('escapeHtml', () => {
  it('escapes a file name that tries to break out of an attribute', () => {
    const name = '"><img src=x onerror=alert(1)>.png';
    const el = parse(`<img src="https://files.weldsuite.org/a.png" alt="${escapeHtml(name)}">`);
    expect(el.querySelectorAll('img')).toHaveLength(1);
    expect(el.querySelector('img')?.getAttribute('alt')).toBe(name);
    expect(el.querySelector('img')?.hasAttribute('onerror')).toBe(false);
  });
});
