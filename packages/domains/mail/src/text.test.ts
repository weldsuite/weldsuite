import { describe, it, expect } from 'vitest';
import { escapeHtml, htmlToText, looksLikeHtml, plainTextBody } from './text';

describe('htmlToText', () => {
  it('turns the editor markup from the QA mail into readable lines', () => {
    const html =
      'Hello from WeldMail QA. Plain line one.<div>This sentence is bold.</div><div><i>This sentence is italic.</i></div>';
    expect(htmlToText(html)).toBe(
      'Hello from WeldMail QA. Plain line one.\nThis sentence is bold.\nThis sentence is italic.',
    );
  });

  it('keeps line breaks, list items and decoded entities', () => {
    expect(htmlToText('<p>One<br>Two</p><ul><li>a &amp; b</li><li>&lt;b&gt;</li></ul>')).toBe(
      'One\nTwo\n- a & b\n- <b>',
    );
    expect(htmlToText('caf&#233; &#x1F600; &nbsp;done')).toBe('café 😀  done');
  });

  it('drops style and script content', () => {
    expect(htmlToText('<style>p{color:red}</style><p>Hi</p><script>alert(1)</script>')).toBe('Hi');
  });
});

describe('looksLikeHtml', () => {
  it('recognises markup but not text that merely contains angle brackets', () => {
    expect(looksLikeHtml('<div>x</div>')).toBe(true);
    expect(looksLikeHtml('line one<br>line two')).toBe(true);
    expect(looksLikeHtml('if a < b and b > c then <3')).toBe(false);
    expect(looksLikeHtml('Reply to <dana@acme.example> today')).toBe(false);
  });
});

describe('plainTextBody', () => {
  it('passes plain text through untouched', () => {
    expect(plainTextBody('Hi there,\n\nBye', '<p>Hi there,</p><p>Bye</p>')).toBe('Hi there,\n\nBye');
  });

  it('strips markup a client put in the text field', () => {
    expect(plainTextBody('Hi<div><b>bold</b></div>', undefined)).toBe('Hi\nbold');
  });

  it('falls back to the text of the HTML body', () => {
    expect(plainTextBody(undefined, '<p>Only html</p>')).toBe('Only html');
    expect(plainTextBody('   ', '<p>Only html</p>')).toBe('Only html');
    expect(plainTextBody(undefined, undefined)).toBeUndefined();
  });
});

describe('escapeHtml', () => {
  it('escapes an address in angle brackets', () => {
    expect(escapeHtml('daniel <weldhost@gmail.com> & "co"')).toBe(
      'daniel &lt;weldhost@gmail.com&gt; &amp; &quot;co&quot;',
    );
  });
});
