import { describe, it, expect } from 'vitest';
import { renderInlineMarkdown } from './inline-markdown';

function parse(html: string): HTMLDivElement {
  const el = document.createElement('div');
  el.innerHTML = html;
  return el;
}

describe('renderInlineMarkdown', () => {
  it('renders bold, italic and inline code', () => {
    const el = parse(renderInlineMarkdown('**bold** and *italic* and `code`'));
    expect(el.querySelector('strong')?.textContent).toBe('bold');
    expect(el.querySelector('em')?.textContent).toBe('italic');
    expect(el.querySelector('code')?.textContent).toBe('code');
  });

  it('keeps plain text and editor HTML working', () => {
    expect(renderInlineMarkdown('just text')).toBe('just text');
    expect(parse(renderInlineMarkdown('<b>bold</b> <i>it</i>')).querySelector('b')?.textContent).toBe('bold');
  });

  it('does not let a line run script through an image error handler', () => {
    const html = renderInlineMarkdown('hello <img src=x onerror=alert(document.cookie)>');
    expect(html).not.toMatch(/onerror/i);
    expect(html).not.toContain('alert');
  });

  it('does not let markdown markers turn an attribute value into a handler', () => {
    // `*` … `*` becomes <em> … </em> *inside* the quotes, which closes nothing, but the
    // pair below rewrites the attribute boundary: the result must still be sanitized.
    const html = renderInlineMarkdown('<a href="https://weldsuite.org" title="*" onmouseover=alert(1) x="*">l</a>');
    const a = parse(html).querySelector('a');
    expect(a).not.toBeNull();
    expect(a?.hasAttribute('onmouseover')).toBe(false);
    expect(Array.from(a?.attributes ?? []).map((attr) => attr.name)).not.toContain('onmouseover');
  });

  it('drops script, iframe and javascript: links', () => {
    const html = renderInlineMarkdown(
      '<script>alert(1)</script><iframe src="https://evil.test"></iframe><a href="javascript:alert(1)">x</a>',
    );
    const el = parse(html);
    expect(el.querySelector('script, iframe')).toBeNull();
    expect(el.querySelector('a')?.hasAttribute('href')).toBe(false);
  });

  it('does not emit a class on generated code', () => {
    expect(parse(renderInlineMarkdown('`x`')).querySelector('code')?.hasAttribute('class')).toBe(false);
  });
});
